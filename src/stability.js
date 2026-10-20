import { createHash } from 'node:crypto';
import { validateSnapshot } from './snapshot.js';
import { fail } from './errors.js';

export function stableCount(value) {
  if (typeof value !== 'string' || value.length > 2 || !/^[1-9][0-9]*$/.test(value) ||
      Number(value) > 16) fail('STABILITY_OPTION');
  return Number(value);
}

const digest = value => createHash('sha256').update(value).digest('hex');
const available = value => value && ['observed', 'no-code'].includes(value.status);
const caveats = [
  'Stable means only that the local observation threshold was met; it is not safety, an upgrade/event, ancestry, reorg detection or finality.',
  'Only committed snapshots count. Repeated blocks add no matches; missing observations and excluded implementation data are not unchanged state.',
  'A new baseline after a gap or unavailable/incomparable data does not describe a transition across that break.',
  'Block conflict checks use bounded SHA-256 summaries; chain/genesis and all state remain provider observations.'
];

function observed(snapshot, includeImplementation) {
  const target = JSON.stringify([snapshot.code.toLowerCase(), ...['implementation','admin','beacon']
    .map(name => snapshot.slots[name].toLowerCase())]);
  const value = snapshot.implementation;
  // Fixed field order; compare decoded-equivalent hex, never timestamps or block.
  const implementation = available(value) ? JSON.stringify([value.status, value.via, value.address,
    value.beacon ?? null, value.raw?.toLowerCase() ?? null, value.code.toLowerCase()])
    : value && value.status !== 'not-recorded' ? JSON.stringify([value.status, value.reason]) : null;
  return {
    key: includeImplementation ? JSON.stringify([target, implementation]) : target,
    provenance: includeImplementation && available(value) ? JSON.stringify([value.via, value.beacon ?? null]) : null,
    targetDigest: digest(target), implementationDigest: implementation === null ? null : digest(implementation)
  };
}

// Internal streaming policy, fed only after an observation commits. Retain at
// most a baseline and candidate's exact state, plus <=128 compact block records.
export function createStabilityPolicy(value, { includeImplementation = false } = {}) {
  const threshold = stableCount(value);
  let identity, baseline = null, candidate = null, highWater;
  let invalidatedAt = null, invalidReason = null;
  const byHash = new Map(), byHeight = new Map(), observations = [], transitions = [];
  const step = (ordinal, status, reason = null, run = candidate, reference = baseline?.ordinal ?? null) => {
    observations.push({ ordinal, status, reason, referenceOrdinal: reference,
      candidateOrdinal: run?.firstOrdinal ?? null, matches: run?.matches ?? 0 });
  };
  const reset = () => { baseline = null; candidate = null; };
  const invalidate = (ordinal, reason) => {
    reset(); invalidatedAt = ordinal; invalidReason = reason;
    for (const transition of transitions) transition.status = 'invalidated';
    step(ordinal, 'invalidated', reason);
  };
  const rebase = (ordinal, state, reason) => {
    baseline = { ordinal, ...state }; candidate = null; step(ordinal, 'baseline', reason);
  };
  return {
    observe(outcome, snapshot) {
      const { ordinal, status } = outcome;
      if (ordinal !== observations.length + 1 || ordinal > 128 ||
          !['saved','failed','stopped'].includes(status)) fail('STABILITY_INPUT');
      if (status === 'saved') validateSnapshot(snapshot);
      if (invalidatedAt !== null) { step(ordinal, 'inactive', invalidReason); return; }
      if (status !== 'saved') {
        candidate = null; step(ordinal, 'interrupted', status === 'failed' ? 'ATTEMPT_FAILED' : 'ATTEMPT_STOPPED'); return;
      }
      const key = JSON.stringify([snapshot.address, snapshot.chainId, snapshot.source, snapshot.schemaVersion,
        snapshot.genesis?.status ?? 'not-recorded', snapshot.genesis?.hash ?? null]);
      if (identity === undefined) identity = key;
      if (identity !== key) { invalidate(ordinal, 'IDENTITY_CHANGED'); return; }
      if (snapshot.schemaVersion === 4 && snapshot.genesis.status !== 'observed') {
        reset(); step(ordinal, 'unavailable', 'GENESIS_UNAVAILABLE'); return;
      }
      const state = observed(snapshot, includeImplementation), block = snapshot.block;
      const previous = byHash.get(block.hash);
      if (previous && (previous.number !== block.number || previous.targetDigest !== state.targetDigest ||
          previous.implementationDigest !== null && state.implementationDigest !== null &&
          previous.implementationDigest !== state.implementationDigest)) {
        invalidate(ordinal, 'INCONSISTENT_BLOCK_DATA'); return;
      }
      if (byHeight.has(block.number) && byHeight.get(block.number) !== block.hash) {
        invalidate(ordinal, 'HEIGHT_CONFLICT'); return;
      }
      byHash.set(block.hash, { number: block.number, targetDigest: state.targetDigest,
        implementationDigest: state.implementationDigest ?? previous?.implementationDigest ?? null });
      byHeight.set(block.number, block.hash);
      const height = BigInt(block.number), before = highWater;
      if (highWater === undefined || height > highWater) highWater = height;
      if (includeImplementation && !available(snapshot.implementation)) {
        reset(); step(ordinal, 'unavailable', 'IMPLEMENTATION_UNAVAILABLE'); return;
      }
      if (before !== undefined && height < before) {
        reset(); step(ordinal, 'interrupted', 'NONMONOTONIC_BLOCK'); return;
      }
      if (before !== undefined && height === before) {
        step(ordinal, 'repeated', 'REPEATED_BLOCK'); return;
      }
      if (before !== undefined && height !== before + 1n) {
        rebase(ordinal, state, 'BLOCK_GAP'); return;
      }
      if (!baseline) { rebase(ordinal, state, 'BASELINE'); return; }
      if (state.provenance !== baseline.provenance) {
        rebase(ordinal, state, 'PROVENANCE_CHANGED'); return;
      }
      if (state.key === baseline.key) {
        candidate = null; step(ordinal, 'baseline-match'); return;
      }
      candidate = candidate?.key === state.key
        ? { ...candidate, lastOrdinal: ordinal, matches: candidate.matches + 1 }
        : { ...state, firstOrdinal: ordinal, lastOrdinal: ordinal, matches: 1 };
      if (candidate.matches < threshold) { step(ordinal, 'candidate'); return; }
      transitions.push({ status: 'stable', fromOrdinal: baseline.ordinal, firstOrdinal: candidate.firstOrdinal,
        confirmedOrdinal: ordinal, matches: candidate.matches });
      step(ordinal, 'stable');
      baseline = { ordinal, ...state }; candidate = null;
    },
    report() {
      return { kind: 'consecutive-observations', threshold,
        scope: includeImplementation ? 'target-and-implementation' : 'target',
        status: invalidatedAt === null ? 'active' : 'invalidated', invalidatedAt, reason: invalidReason,
        baselineOrdinal: baseline?.ordinal ?? null,
        candidate: candidate ? { firstOrdinal: candidate.firstOrdinal, lastOrdinal: candidate.lastOrdinal, matches: candidate.matches } : null,
        observations: observations.map(entry => ({ ...entry })), transitions: transitions.map(entry => ({ ...entry })),
        caveats: [...caveats] };
    }
  };
}
