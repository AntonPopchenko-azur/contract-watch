import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalHistoryJson } from './history.js';
import { historyCheckpoint } from './retention.js';
import { checkRoot, openHistoryRoot, readBounded, parseHistoryJson } from './history-files.js';
import { validateSnapshot, MAX_SNAPSHOT_V4_BYTES } from './snapshot.js';
import { conflicting, observationSummary } from './timeline.js';
import { diffDocument } from './report.js';
import { configuredEndpoint } from './config.js';
import { blockHash, rpcUrl, timeout, deadline } from './validate.js';
import { checkBranch } from './branch-check.js';
import { checkCancellation } from './cancellation.js';
import { WatchError, fail, errorDetails } from './errors.js';

const digest = value => createHash('sha256').update(value).digest('hex');

export function revalidationOptions(options) {
  if (typeof options.directory !== 'string' || !options.directory ||
      (options.rpc === undefined) === (options.rpcEnv === undefined)) fail('USAGE');
  const anchor = blockHash(options.anchor);
  if (anchor === `0x${'0'.repeat(64)}`) fail('BLOCK_HASH');
  if (typeof options.maxBlocks !== 'string' || !/^[1-9][0-9]{0,2}$/.test(options.maxBlocks) || Number(options.maxBlocks) > 128) fail('BRANCH_LIMIT');
  if (options.rpcEnv !== undefined && (typeof options.rpcEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(options.rpcEnv))) fail('USAGE');
  if (options.rpc !== undefined) rpcUrl(options.rpc);
  const ms = options.timeoutMs ?? '10000';
  if (typeof ms !== 'string' || !/^[1-9][0-9]{2,4}$/.test(ms)) fail('TIMEOUT_OPTION');
  return { ...options, anchor, maxBlocks: Number(options.maxBlocks), timeoutMs: timeout(ms),
    deadlineMs: deadline(options.deadlineMs ?? '30000') };
}

// Pure classification of validated compact summaries against checked coverage.
// Never choose a branch from index order, hash repeats or height alone.
export function classifyObservations(observations, headers, genesisHash) {
  const byNumber = new Map(headers.map((h, i) => [h.number, { ...h, index: i }]));
  const byHash = new Map(headers.map(h => [h.hash, h]));
  byHash.set(genesisHash, { number: '0x0' });
  const conflicts = new Set();
  for (const a of observations) for (const b of observations) {
    if (a.block.hash === b.block.hash && conflicting(a, b)) conflicts.add(a.block.hash);
  }
  return observations.map(value => {
    const checked = byNumber.get(value.block.number), hashPeer = byHash.get(value.block.hash);
    let status = 'unknown', reason = 'OUTSIDE_CHECKED_RANGE';
    if (conflicts.has(value.block.hash)) reason = 'CONTRADICTORY_SAVED_DATA';
    else if (hashPeer && hashPeer.number !== value.block.number) reason = 'SAVED_NUMBER_MISMATCH';
    else if (checked) {
      status = checked.hash === value.block.hash ? 'on-branch' : 'displaced';
      reason = status === 'on-branch' ? 'MATCHED_CHECKED_HEADER' : 'DIFFERENT_CHECKED_HASH';
    }
    return { ...value, status, reason, checkedHeader: checked?.index ?? null };
  });
}

export async function revalidateHistory(input, environment = process.env, runtime = {}) {
  const options = revalidationOptions(input);
  const check = () => { checkCancellation(runtime.signal); runtime.check?.(); };
  let root;
  try {
    check(); root = await openHistoryRoot(options.directory);
    const initial = await historyCheckpoint(root, check), state = initial.state, identity = state.header.identity;
    if (identity.source !== 'rpc' || identity.snapshotVersion !== 4 || identity.genesis.status !== 'observed') fail('BRANCH_IDENTITY');
    const records = [...state.committed.values()], retention = state.header.retention;
    const originalOrdinal = ordinal => retention ? retention.ordinals[ordinal - 1] ?? null : ordinal;
    const read = async record => {
      check(); await checkRoot(root);
      const bytes = await readBounded(join(root.path, record.snapshot), MAX_SNAPSHOT_V4_BYTES);
      if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) fail('HISTORY_CHANGED');
      check(); return validateSnapshot(parseHistoryJson(bytes));
    };
    const summaries = [];
    for (const record of records) summaries.push({ ...observationSummary(await read(record), record), originalOrdinal: originalOrdinal(record.ordinal) });
    check();
    // Resolve exactly the selected environment property, after full local validation.
    const endpoint = options.rpc ?? configuredEndpoint(options.rpcEnv, environment);
    const proof = await checkBranch(identity, { ...options, endpoint }, { ...runtime, check });
    const evidence = { kind: 'contract-watch-branch-evidence', schemaVersion: 1,
      verificationId: randomUUID(), source: 'single-explicit-rpc', historyState: initial.sourceState, ...proof };
    const evidenceId = digest(canonicalHistoryJson(evidence));
    const observations = classifyObservations(summaries, proof.headers, proof.genesisHash);
    const visible = observations.filter(o => o.status === 'on-branch'), transitions = [];
    let previous, before;
    for (const observation of visible) {
      const value = await read(records[observation.ordinal - 1]);
      if (previous) {
        const pair = { from: before.ordinal, to: observation.ordinal,
          fromOriginal: before.originalOrdinal, toOriginal: observation.originalOrdinal,
          omittedOrdinals: observations.filter(o => o.ordinal > before.ordinal && o.ordinal < observation.ordinal).map(o => o.ordinal),
          retentionGap: !retention ? false : before.originalOrdinal === null || observation.originalOrdinal === null ? null
            : observation.originalOrdinal - before.originalOrdinal > observation.ordinal - before.ordinal };
        try {
          const diff = diffDocument(previous, value);
          transitions.push({ ...pair, status: 'compared', changed: diff.changed, changes: diff.changes,
            implementation: diff.implementation ?? null });
        } catch (error) {
          if (!(error instanceof WatchError) || error.code !== 'ORDER') throw error;
          transitions.push({ ...pair, status: 'unavailable', reason: errorDetails(error) });
        }
      }
      previous = value; before = observation;
    }
    if ((await historyCheckpoint(root, check)).sourceState !== initial.sourceState) fail('HISTORY_CHANGED');
    check();
    return { kind: 'contract-watch-history-branch', schemaVersion: 1, order: 'index', identity,
      historyVersion: state.header.schemaVersion, committed: records.length,
      pending: state.snapshots.size - records.length, staged: state.stages.length,
      retention: retention ?? null, sourceUnchanged: true, evidence: { ...evidence, evidenceId },
      observations, visibleOrdinals: visible.map(o => o.ordinal), transitions,
      caveats: [
        'Statuses are relative to one explicit RPC source and its checked anchor at this verification, not finality or an independently verified canonical chain.',
        'Only linked headers inside this bounded range are covered. Same-height differences alone and index order never choose a branch.',
        'All indexed observations remain here and in the untouched history. Only on-branch observations enter the rebuilt view; unknown does not mean unchanged or displaced.',
        'Visible endpoints retain index order and repeats. Omitted observations, retention gaps and intermediate events are not reconstructed.',
        'Header assertions are not cryptographic proofs of ancestry or provider honesty; chain ID and genesis do not authenticate the source.',
        'This stdout report is not persisted or authenticated by the tool; keep it separately if needed. No report is imported or replayed.'
      ] };
  } catch (error) {
    if (error instanceof WatchError) throw error;
    fail('HISTORY_CORRUPT');
  } finally {
    try { await root?.file.close(); } catch { fail('HISTORY_CORRUPT'); }
  }
}
