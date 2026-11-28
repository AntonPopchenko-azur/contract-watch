import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { historyCheckpoint } from './retention.js';
import { openHistoryRoot, checkRoot, readBounded, parseHistoryJson } from './history-files.js';
import { validateSnapshot, MAX_SNAPSHOT_V4_BYTES } from './snapshot.js';
import { conflicting, observationSummary } from './timeline.js';
import { readRangeFile, recheckRangeFile } from './event-range-import.js';
import { fail, WatchError } from './errors.js';

export const MAX_CORRELATION_BYTES = 4 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function correlationJson(document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_CORRELATION_BYTES) fail('CORRELATION_SIZE');
  return text;
}

// Height selection does not reorder the source history. Only exact, consistent
// matches to saved headers qualify; outside-window ancestry is never inferred.
function classify(summaries, evidence) {
  const byNumber = new Map(evidence.blocks.map(b => [b.number, b]));
  const byHash = new Map(evidence.blocks.map(b => [b.hash, b.number]));
  byHash.set(evidence.genesisHash, '0x0');
  const conflicts = new Set(), notices = [];
  for (const a of summaries) for (const b of summaries) {
    if (a.block.hash === b.block.hash && conflicting(a, b)) conflicts.add(a.block.hash);
  }
  const observations = summaries.map((current, i) => {
    const prior = summaries.slice(0, i), previous = prior.at(-1);
    const notice = (code, peer) => { if (peer) notices.push({ code, beforeOrdinal: peer.ordinal, afterOrdinal: current.ordinal }); };
    if (previous && BigInt(current.block.number) < BigInt(previous.block.number)) notice('HEIGHT_DECREASED', previous);
    if (previous && Date.parse(current.capturedAt) < Date.parse(previous.capturedAt)) notice('CAPTURE_TIME_DECREASED', previous);
    notice('REPEATED_HEIGHT', prior.find(p => p.block.number === current.block.number));
    notice('SAME_HEIGHT_DIFFERENT_HASH', prior.find(p => p.block.number === current.block.number && p.block.hash !== current.block.hash));
    notice('CONTRADICTORY_SAVED_HASH', prior.find(p => p.block.hash === current.block.hash && conflicting(p, current)));
    const header = byNumber.get(current.block.number), knownNumber = byHash.get(current.block.hash);
    let relation = 'unknown', reason = 'OUTSIDE_SAVED_RANGE';
    if (conflicts.has(current.block.hash)) { relation = 'conflicting'; reason = 'CONTRADICTORY_SAVED_DATA'; }
    else if (knownNumber !== undefined && knownNumber !== current.block.number) reason = 'SAVED_NUMBER_MISMATCH';
    else if (header) {
      relation = header.hash === current.block.hash ? 'matched' : 'different-hash';
      reason = relation === 'matched' ? 'MATCHED_SAVED_HEADER' : 'DIFFERENT_SAVED_HASH';
    }
    return { ...current, relation, reason };
  });
  return { observations, notices };
}

function candidatesFor(observations, evidence, retention) {
  const groups = new Map();
  for (const o of observations) if (o.relation === 'matched') {
    if (!groups.has(o.block.number)) groups.set(o.block.number, { number: o.block.number, hash: o.block.hash, ordinals: [] });
    groups.get(o.block.number).ordinals.push(o.ordinal);
  }
  const ordered = [...groups.values()].sort((a, b) => BigInt(a.number) < BigInt(b.number) ? -1 : 1);
  const slot = (group, name) => group ? observations[group.ordinals[0] - 1].slots[name] : null;
  const compare = (group, event) => {
    const observed = slot(group, event.slot);
    return { status: observed ? observed.raw === event.valueWord ? 'matches' : 'differs' : 'unavailable', observed };
  };
  const gap = (before, after) => {
    if (!before || !after) return null;
    if (!retention) return false;
    const origins = [...before.ordinals, ...after.ordinals].map(n => observations[n - 1].originalOrdinal);
    if (origins.includes(null)) return null;
    const low = Math.min(...origins), high = Math.max(...origins), retained = new Set(retention.ordinals);
    for (let n = low; n <= high; n++) if (!retained.has(n)) return true;
    return false;
  };
  const intervals = [], byPair = new Map(), candidates = [], sameBlockSlot = new Map();
  for (const [i, event] of evidence.logs.entries()) {
    const key = `${event.blockNumber}:${event.slot}`;
    if (!sameBlockSlot.has(key)) sameBlockSlot.set(key, []);
    sameBlockSlot.get(key).push(i + 1);
  }
  for (const [i, event] of evidence.logs.entries()) {
    const before = ordered.filter(g => BigInt(g.number) < BigInt(event.blockNumber)).at(-1) ?? null;
    const after = ordered.find(g => BigInt(g.number) >= BigInt(event.blockNumber)) ?? null;
    const key = `${before?.number ?? '-'}:${after?.number ?? '-'}:${event.slot}`;
    let interval = byPair.get(key);
    if (!interval) {
      const left = slot(before, event.slot), right = slot(after, event.slot);
      interval = { id: intervals.length + 1, slot: event.slot, before, after,
        bracketing: before && after ? 'bounded' : before ? 'after-missing' : after ? 'before-missing' : 'both-missing',
        candidateIds: [], endpointChange: { status: left && right ? left.raw === right.raw ? 'unchanged' : 'changed' : 'unavailable',
          beforeWord: left?.raw ?? null, afterWord: right?.raw ?? null }, retentionGap: gap(before, after) };
      byPair.set(key, interval); intervals.push(interval);
    }
    interval.candidateIds.push(i + 1);
    const peers = sameBlockSlot.get(`${event.blockNumber}:${event.slot}`);
    candidates.push({ id: i + 1, event, intervalId: interval.id, association: 'candidate-only',
      valueComparison: { before: compare(before, event), after: compare(after, event) },
      sameBlockAsAfter: after?.number === event.blockNumber,
      laterReturnedSameSlotEventsInBlock: peers.length - peers.indexOf(i + 1) - 1, lastReturnedSameSlotEventInBlock: peers.at(-1) });
  }
  return { intervals, candidates };
}

export async function correlateHistory({ directory, events }) {
  if (typeof directory !== 'string' || !directory || typeof events !== 'string' || !events) fail('USAGE');
  let root;
  try {
    const imported = await readRangeFile(events), evidence = imported.evidence;
    root = await openHistoryRoot(directory);
    const initial = await historyCheckpoint(root), state = initial.state, identity = state.header.identity;
    if (identity.source !== 'rpc' || identity.snapshotVersion !== 4 || identity.genesis.status !== 'observed' ||
        identity.address !== evidence.address || identity.chainId !== evidence.chainId || identity.genesis.hash !== evidence.genesisHash) fail('CORRELATION_IDENTITY');
    const retention = state.header.retention ?? null, summaries = [];
    for (const record of state.committed.values()) {
      await checkRoot(root);
      const bytes = await readBounded(join(root.path, record.snapshot), MAX_SNAPSHOT_V4_BYTES);
      if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) fail('HISTORY_CHANGED');
      const value = validateSnapshot(parseHistoryJson(bytes));
      summaries.push({ ...observationSummary(value, record), snapshotSha256: record.sha256, snapshotBytes: record.bytes,
        originalOrdinal: retention ? retention.ordinals[record.ordinal - 1] ?? null : record.ordinal });
    }
    const { observations, notices } = classify(summaries, evidence);
    const { intervals, candidates } = candidatesFor(observations, evidence, retention);
    if ((await historyCheckpoint(root)).sourceState !== initial.sourceState) fail('HISTORY_CHANGED');
    await recheckRangeFile(events, imported);
    return { kind: 'contract-watch-event-correlation', schemaVersion: 1, mode: 'offline', identity,
      inputValidation: 'internally-consistent', completeness: 'unverified', causation: 'unverified', sourceUnchanged: true,
      history: { schemaVersion: state.header.schemaVersion, sourceState: initial.sourceState, committed: state.committed.size,
        pending: state.snapshots.size - state.committed.size, staged: state.stages.length, retention },
      eventSource: { sha256: imported.sha256, bytes: imported.bytes, range: evidence.range, rangeSha256: evidence.rangeSha256,
        headers: evidence.blocks.map(({ transactions, ...header }) => header), claimedChecks: 'not-replayed', authenticity: 'unverified' },
      selection: { before: 'nearest-strictly-lower-height', after: 'nearest-equal-or-higher-height',
        ties: 'all-in-index-order', eligibility: 'consistent-exact-saved-header-match' },
      observations, intervals, candidates, notices,
      limits: { historyEntries: 128, rangeBlocks: 32, candidateEvents: 512, reportBytes: MAX_CORRELATION_BYTES },
      caveats: [
        'All associations are candidates. Saved value matches or differences do not prove causation, an upgrade or contract safety.',
        'A consistent saved report is not authenticated RPC evidence. Claimed checks are not replayed; headers, genesis and fingerprints do not prove ancestry, current canonicality or finality.',
        'Snapshots describe end-of-block state. Same-block snapshots follow every event in that block; earlier returned event values can differ from final storage.',
        'Only matching saved headers qualify. Outside-range observations, different hashes and contradictory saved data remain explicit; no branch or missing neighbor is guessed.',
        'Returned events may be incomplete. Several events and A/B/A can leave equal endpoints; empty logs or equal saved values do not establish absence of changes.',
        'Pending/staged data, retention gaps and unavailable implementation observations are never reconstructed. BeaconUpgraded concerns the proxy beacon slot, not an implementation change inside a beacon.'
      ] };
  } catch (error) {
    if (error instanceof WatchError) throw error;
    fail('CORRELATION_INPUT');
  } finally {
    try { await root?.file.close(); } catch { fail('HISTORY_CORRUPT'); }
  }
}
