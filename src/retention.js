import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalHistoryJson, loadHistory, entryFor, MAX_HISTORY_INDEX_BYTES } from './history.js';
import { checkRoot, openHistoryRoot, readBounded, historyNames, publishHistoryFile } from './history-files.js';
import { MAX_SNAPSHOT_V4_BYTES } from './snapshot.js';
import { retainedOrdinals, retentionCount } from './retention-policy.js';
import { fail, WatchError } from './errors.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const equal = (a, b) => canonicalHistoryJson(a) === canonicalHistoryJson(b);
const limitFor = name => name === 'index.json' || name.startsWith('entry-') ? MAX_HISTORY_INDEX_BYTES : MAX_SNAPSHOT_V4_BYTES;
const metadata = stat => Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => [k, stat[k].toString()]));
const stat = path => lstat(path, { bigint: true });

// Bind the plan to both verified bytes and this filesystem instance. Access
// time is excluded so repeated read-only previews produce the same plan.
async function checkpoint(root) {
  const before = metadata(await checkRoot(root)), state = await loadHistory(root), files = [];
  for (const name of state.names) {
    await checkRoot(root);
    const path = join(root.path, name), before = metadata(await stat(path));
    const bytes = await readBounded(path, limitFor(name)), after = metadata(await stat(path));
    const fingerprint = { sha256: digest(bytes), bytes: bytes.length };
    if (!equal(before, after) || (state.files.has(name) && !equal(state.files.get(name), fingerprint))) fail('HISTORY_CHANGED');
    files.push({ name, metadata: after, ...fingerprint });
  }
  for (const file of files) if (!equal(file.metadata, metadata(await stat(join(root.path, file.name))))) fail('HISTORY_CHANGED');
  if (!equal(before, metadata(await checkRoot(root))) || !equal(state.names, await historyNames(root))) fail('HISTORY_CHANGED');
  return { state, sourceState: digest(canonicalHistoryJson({ root: before, files })) };
}

// Pure selection over validated index metadata; exported for independent plan fixtures.
export function retentionPlan(state, sourceState, keepLast) {
  const selected = new Set(retainedOrdinals(state.entries.length, keepLast));
  let ordinal = 0;
  const observations = [...state.committed.values()].map(record => ({
    ordinal: record.ordinal, observationId: record.observationId, capturedAt: record.capturedAt,
    block: record.block, bytes: record.bytes, sha256: record.sha256,
    action: selected.has(record.ordinal) ? 'keep' : 'exclude',
    reason: record.ordinal === 1 ? 'baseline' : selected.has(record.ordinal) ? 'recent' : 'outside-retention',
    newOrdinal: selected.has(record.ordinal) ? ++ordinal : null
  }));
  const plan = { kind: 'contract-watch-retention-plan', schemaVersion: 1, sourceState,
    identity: state.header.identity, source: { historyVersion: state.header.schemaVersion,
      committed: state.entries.length, pending: state.snapshots.size - state.entries.length, staged: state.stages.length },
    policy: { kind: 'baseline-and-last', keepLast, order: 'index' }, selectionChanged: ordinal < observations.length,
    retained: ordinal, excluded: observations.length - ordinal,
    excludedSnapshotBytes: observations.filter(o => o.action === 'exclude').reduce((sum, o) => sum + o.bytes, 0),
    observations, sourceUnchanged: true, freesSpace: false,
    caveats: [
      'Apply copies selected observations to a new history; it never deletes or rewrites the source.',
      'Pending snapshots, abandoned stages and all source files remain in the source; they are not copied.',
      'The copy uses new contiguous ordinals and retains their source mapping; excluded observations may contain changes.',
      'No disk space is reclaimed. Keep the source as backup; any later relocation or deletion is a separate manual decision.'
    ] };
  return { ...plan, planId: digest(canonicalHistoryJson(plan)) };
}

async function checkCopyMetadata(root, saved) {
  if (!equal(saved.root, metadata(await checkRoot(root))) ||
      !equal(saved.files.map(f => f.name).sort(), await historyNames(root))) fail('HISTORY_CHANGED');
  for (const file of saved.files) if (!equal(file.metadata, metadata(await stat(join(root.path, file.name))))) fail('HISTORY_CHANGED');
  if (!equal(saved.root, metadata(await checkRoot(root)))) fail('HISTORY_CHANGED');
}

async function verifyCopy(root, expected) {
  const saved = { root: metadata(await checkRoot(root)), files: [] };
  if (!equal(await historyNames(root), [...expected.keys()].sort())) fail('HISTORY_CHANGED');
  for (const [name, fingerprint] of expected) {
    await checkRoot(root);
    const path = join(root.path, name), before = metadata(await stat(path));
    const bytes = await readBounded(path, limitFor(name)), after = metadata(await stat(path));
    if (!equal(before, after) || !equal(fingerprint, { sha256: digest(bytes), bytes: bytes.length })) fail('HISTORY_CHANGED');
    saved.files.push({ name, metadata: after });
  }
  await checkCopyMetadata(root, saved);
  return saved;
}

export async function pruneHistory({ directory, keepLast, apply, output }) {
  keepLast = retentionCount(keepLast);
  if (typeof directory !== 'string' || !directory ||
      (apply === undefined ? output !== undefined : typeof apply !== 'string' || !/^[0-9a-f]{64}$/.test(apply) || typeof output !== 'string' || !output)) fail('USAGE');
  let source, parent, destination;
  try {
    source = await openHistoryRoot(directory);
    const initial = await checkpoint(source), plan = retentionPlan(initial.state, initial.sourceState, keepLast);
    if (apply === undefined) return plan;
    if (apply !== plan.planId) fail('RETENTION_PLAN');
    output = resolve(output);
    parent = await openHistoryRoot(dirname(output));
    const inside = relative(await realpath(source.path), await realpath(parent.path));
    if (!inside || (!inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && inside !== '..' && !isAbsolute(inside))) fail('RETENTION_DESTINATION');
    await checkRoot(source); await checkRoot(parent);
    try { await mkdir(output, { mode: 0o700 }); }
    catch (error) { fail(error.code === 'EEXIST' ? 'HISTORY_EXISTS' : 'RETENTION_DESTINATION'); }
    await checkRoot(parent);
    destination = await openHistoryRoot(output);
    if ((await historyNames(destination)).length) fail('HISTORY_CHANGED');
    const kept = plan.observations.filter(o => o.action === 'keep');
    const retention = { policy: 'baseline-and-last', keepLast, sourceState: plan.sourceState,
      sourceCommitted: plan.source.committed, sourcePending: plan.source.pending, sourceStaged: plan.source.staged,
      ordinals: kept.map(o => o.ordinal), observationsSha256: digest(canonicalHistoryJson(kept.map(o => o.observationId))), planId: plan.planId };
    const header = encode({ kind: 'contract-watch-history', schemaVersion: 2, identity: plan.identity, retention });
    if (header.length > MAX_HISTORY_INDEX_BYTES) fail('HISTORY_LIMIT');
    let previous = digest(header);
    const expected = new Map();
    const publish = async (name, bytes) => {
      await checkRoot(parent);
      if (!await publishHistoryFile(destination, name, bytes)) fail('HISTORY_CHANGED');
      expected.set(name, { sha256: digest(bytes), bytes: bytes.length });
    };
    for (const selected of kept) {
      await checkRoot(source);
      const name = `snapshot-${selected.observationId}.json`;
      const bytes = await readBounded(join(source.path, name), MAX_SNAPSHOT_V4_BYTES);
      if (digest(bytes) !== selected.sha256 || bytes.length !== selected.bytes) fail('HISTORY_CHANGED');
      await publish(name, bytes);
      const entry = encode(entryFor(initial.state.snapshots.get(selected.observationId), selected.newOrdinal, previous));
      await publish(`entry-${String(selected.newOrdinal).padStart(4, '0')}.json`, entry);
      previous = digest(entry);
    }
    await verifyCopy(destination, expected);
    if ((await checkpoint(source)).sourceState !== initial.sourceState) fail('HISTORY_CHANGED');
    // Whole-copy commit point: header published LAST. Without it the prefix is
    // deliberately unreadable as a history. Never delete partial output.
    await publish('index.json', header);
    const copied = await verifyCopy(destination, expected);
    await loadHistory(destination);
    if ((await checkpoint(source)).sourceState !== initial.sourceState) fail('HISTORY_CHANGED');
    await checkRoot(parent);
    await checkCopyMetadata(destination, copied);
    return { kind: 'contract-watch-retention-result', schemaVersion: 1, status: 'copied', planId: plan.planId,
      sourceState: plan.sourceState, historyVersion: 2, retained: plan.retained, excluded: plan.excluded,
      sourceUnchanged: true, freesSpace: false, retention };
  } catch (error) {
    if (apply !== undefined && error?.code === 'HISTORY_WRITE') fail('RETENTION_WRITE');
    if (error instanceof WatchError) throw error;
    fail(apply === undefined ? 'HISTORY_CORRUPT' : 'RETENTION_WRITE');
  } finally {
    let failed = false;
    for (const root of [destination, parent, source]) try { await root?.file.close(); } catch { failed = true; }
    if (failed) fail(apply === undefined ? 'HISTORY_CORRUPT' : 'RETENTION_WRITE');
  }
}
