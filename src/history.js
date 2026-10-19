import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_V4_BYTES, ZERO_WORD } from './snapshot.js';
import { address, chainId, data } from './validate.js';
import { fail, WatchError } from './errors.js';
import { validateRetention } from './retention-policy.js';
import { readBounded, parseHistoryJson, openHistoryRoot, checkRoot, historyNames,
  checkHistoryFile, publishHistoryFile, MAX_HISTORY_FILES } from './history-files.js';

export const MAX_HISTORY_ENTRIES = 128;
export const MAX_HISTORY_INDEX_BYTES = 4096; // Per immutable header or index entry.
const SNAPSHOT_NAME = /^snapshot-([0-9a-f]{64})\.json$/;
const ENTRY_NAME = /^entry-([0-9]{4})\.json$/;
const STAGE_NAME = /^\.cw-stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const digest = value => createHash('sha256').update(value).digest('hex');
export const canonicalHistoryJson = value => value !== null && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonicalHistoryJson).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalHistoryJson(value[k])}`).join(',')}}`
  : JSON.stringify(value);
const equal = (a, b) => canonicalHistoryJson(a) === canonicalHistoryJson(b);
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const snapshotName = id => `snapshot-${id}.json`;
const entryName = ordinal => `entry-${String(ordinal).padStart(4, '0')}.json`;
const identityOf = value => ({ address: value.address, chainId: value.chainId, source: value.source,
  snapshotVersion: value.schemaVersion, genesis: value.genesis ?? { status: 'not-recorded' } });

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('HISTORY_CORRUPT');
}
function validateHeader(header) {
  try {
    keys(header, ['kind','schemaVersion','identity', ...(header?.schemaVersion === 2 ? ['retention'] : [])]);
    if (header.kind !== 'contract-watch-history' || ![1, 2].includes(header.schemaVersion)) fail('HISTORY_CORRUPT');
    if (header.schemaVersion === 2) validateRetention(header.retention);
    const id = header.identity;
    keys(id, ['address','chainId','source','snapshotVersion','genesis']);
    if (address(id.address) !== id.address || chainId(id.chainId) !== id.chainId ||
        !['rpc','synthetic'].includes(id.source) || ![1,2,3,4].includes(id.snapshotVersion)) fail('HISTORY_CORRUPT');
    if (id.genesis.status === 'not-recorded') keys(id.genesis, ['status']);
    else {
      keys(id.genesis, ['status','hash']);
      if (id.snapshotVersion !== 4 || id.genesis.status !== 'observed' ||
          data(id.genesis.hash,32) !== id.genesis.hash || id.genesis.hash === ZERO_WORD) fail('HISTORY_CORRUPT');
    }
    return header;
  } catch { fail('HISTORY_CORRUPT'); }
}

async function observation(path, code = 'HISTORY_CORRUPT', includeValue = false) {
  const bytes = await readBounded(path, MAX_SNAPSHOT_V4_BYTES, code);
  let value;
  try {
    value = validateSnapshot(parseHistoryJson(bytes, code));
    if (value.schemaVersion === 1 && bytes.length > MAX_SNAPSHOT_BYTES) fail(code);
  } catch { fail(code); }
  const canonical = canonicalHistoryJson(value), id = digest(canonical);
  return { bytes, canonical, identity: identityOf(value), id, sha256: digest(bytes), size: bytes.length,
    capturedAt: value.capturedAt, block: value.block, ...(includeValue ? { value } : {}) };
}
export function entryFor(observed, ordinal, previous) {
  return { kind: 'contract-watch-history-entry', schemaVersion: 1, ordinal, previous,
    observationId: observed.id, snapshot: snapshotName(observed.id), sha256: observed.sha256,
    bytes: observed.size, capturedAt: observed.capturedAt, block: observed.block };
}

export async function loadHistory(root, allowUninitialized = false) {
  const before = await checkRoot(root);
  try {
    const names = await historyNames(root), snapshots = new Map(), entries = [], stages = [], files = new Map();
    for (const name of names) {
      if (STAGE_NAME.test(name)) { await checkHistoryFile(root, name, MAX_SNAPSHOT_V4_BYTES); stages.push(name); }
      else if (SNAPSHOT_NAME.test(name)) {
        await checkRoot(root);
        const observed = await observation(join(root.path, name));
        if (snapshotName(observed.id) !== name) fail('HISTORY_CORRUPT');
        // Retain only bounded metadata, not every snapshot's bytecode/buffers.
        const { bytes, canonical, ...metadata } = observed;
        snapshots.set(observed.id, metadata);
        files.set(name, { sha256: observed.sha256, bytes: observed.size });
      } else if (ENTRY_NAME.test(name)) entries.push(name);
      else if (name !== 'index.json') fail('HISTORY_DIRECTORY');
    }
    if (entries.length > MAX_HISTORY_ENTRIES) fail('HISTORY_LIMIT');
    if (!names.includes('index.json')) {
      if (!allowUninitialized || snapshots.size || entries.length) fail('HISTORY_CORRUPT');
      return { names, stages, snapshots, entries: [], header: null };
    }
    const headerBytes = await readBounded(join(root.path,'index.json'), MAX_HISTORY_INDEX_BYTES);
    const header = validateHeader(parseHistoryJson(headerBytes));
    files.set('index.json', { sha256: digest(headerBytes), bytes: headerBytes.length });
    for (const observed of snapshots.values()) if (!equal(observed.identity, header.identity)) fail('HISTORY_CORRUPT');
    let previous = digest(headerBytes);
    const committed = new Map();
    for (const [index, name] of entries.entries()) {
      if (name !== entryName(index + 1)) fail('HISTORY_CORRUPT');
      const bytes = await readBounded(join(root.path,name), MAX_HISTORY_INDEX_BYTES);
      const record = parseHistoryJson(bytes), observed = snapshots.get(record?.observationId);
      if (!observed || committed.has(observed.id) || !equal(record, entryFor(observed,index + 1,previous))) fail('HISTORY_CORRUPT');
      committed.set(observed.id, record);
      previous = digest(bytes);
      files.set(name, { sha256: previous, bytes: bytes.length });
    }
    if (header.schemaVersion === 2) {
      const { ordinals, observationsSha256 } = header.retention;
      if (committed.size < ordinals.length ||
          digest(canonicalHistoryJson([...committed.keys()].slice(0, ordinals.length))) !== observationsSha256) fail('HISTORY_CORRUPT');
    }
    return { names, stages, snapshots, entries, header, committed, previous, files };
  } finally {
    const after = await checkRoot(root);
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('HISTORY_CHANGED');
  }
}

function report(operation, status, state, observed, record) {
  return { kind: 'contract-watch-history-result', schemaVersion: 1, operation, status,
    committed: state.entries.length, pending: state.snapshots.size - state.entries.length,
    staged: state.stages.length, ...(observed ? { observationId: observed.id } : {}),
    ...(record ? { ordinal: record.ordinal, snapshot: record.snapshot } : {}) };
}

// Read-only traversal: validate every committed AND pending file before visiting
// indexed observations. Re-read one snapshot at a time, then validate the store
// again before returning. A visitor must retain summaries, not all raw code.
// Callers must not publish output until this function has returned and closed.
export async function visitCommittedHistory(directory, visit) {
  if (typeof directory !== 'string' || !directory || typeof visit !== 'function') fail('USAGE');
  let root;
  try {
    root = await openHistoryRoot(directory);
    const before = await checkRoot(root), state = await loadHistory(root);
    for (const record of state.committed.values()) {
      await checkRoot(root);
      const observed = await observation(join(root.path, snapshotName(record.observationId)), 'HISTORY_CORRUPT', true);
      if (!equal(observed.identity, state.header.identity) ||
          !equal(entryFor(observed, record.ordinal, record.previous), record)) fail('HISTORY_CHANGED');
      visit(observed.value, record);
    }
    const final = await loadHistory(root), after = await checkRoot(root);
    const signature = value => ({ names: value.names, header: value.header, previous: value.previous,
      snapshots: [...value.snapshots], committed: [...value.committed] });
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        !equal(signature(state), signature(final))) fail('HISTORY_CHANGED');
    return { identity: state.header.identity, committed: state.entries.length,
      pending: state.snapshots.size - state.entries.length, staged: state.stages.length,
      ...(state.header.schemaVersion === 2 ? { retention: state.header.retention } : {}) };
  } catch (error) {
    if (error instanceof WatchError) throw error;
    fail('HISTORY_CORRUPT');
  } finally {
    try { await root?.file.close(); } catch { fail('HISTORY_CORRUPT'); }
  }
}

export async function historyOperation({ operation, input, directory }) {
  if (!['init','add','verify','recover'].includes(operation) || typeof directory !== 'string' || !directory ||
      (operation === 'verify' ? input !== undefined : typeof input !== 'string' || !input)) fail('USAGE');
  // Source validation precedes directory creation or mutation, with no env/RPC.
  const source = operation === 'verify' ? undefined : await observation(input, 'HISTORY_INPUT');
  let root;
  try {
    if (operation === 'init') {
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { fail(error.code === 'EEXIST' ? 'HISTORY_EXISTS' : 'HISTORY_DIRECTORY'); }
    }
    root = await openHistoryRoot(directory);
    let state = await loadHistory(root, operation === 'init' || operation === 'recover');
    if (!state.header) {
      if (state.names.length + 2 > MAX_HISTORY_FILES) fail('HISTORY_LIMIT');
      const header = { kind: 'contract-watch-history', schemaVersion: 1, identity: source.identity };
      if (!await publishHistoryFile(root, 'index.json', encode(header))) fail('HISTORY_CHANGED');
      state = await loadHistory(root);
      if (!equal(state.header, header)) fail('HISTORY_CHANGED');
      return report(operation, 'initialized', state);
    }
    if (operation === 'verify') return report(operation, state.snapshots.size === state.entries.length ? 'verified' : 'pending', state);
    if (!equal(source.identity, state.header.identity)) fail('HISTORY_IDENTITY');
    const existing = state.committed.get(source.id);
    if (existing) {
      await checkRoot(root);
      const stored = await observation(join(root.path, snapshotName(source.id)));
      if (stored.canonical !== source.canonical || stored.sha256 !== existing.sha256) fail('HISTORY_CORRUPT');
      return report(operation, 'already-present', state, source, existing);
    }
    if (state.entries.length === MAX_HISTORY_ENTRIES || state.names.length + 3 > MAX_HISTORY_FILES) fail('HISTORY_LIMIT');
    const name = snapshotName(source.id);
    if (!state.snapshots.has(source.id)) {
      if (operation === 'recover') fail('HISTORY_RECOVERY');
      await publishHistoryFile(root, name, source.bytes);
    }
    // A competing identical publication is reusable only after full validation.
    // No caller input or on-disk index supplies a pathname.
    await checkRoot(root);
    const stored = await observation(join(root.path,name));
    if (stored.canonical !== source.canonical) fail('HISTORY_CORRUPT');
    const entry = entryFor(stored, state.entries.length + 1, state.previous);
    if (!await publishHistoryFile(root, entryName(entry.ordinal), encode(entry))) {
      // A concurrent writer owns this ordinal. Never overwrite it or retry in a
      // loop; an explicit repeat/recover gets a new validated index position.
      const actual = parseHistoryJson(await readBounded(join(root.path,entryName(entry.ordinal)), MAX_HISTORY_INDEX_BYTES));
      if (!equal(actual, entry)) fail('HISTORY_CHANGED');
    }
    state = await loadHistory(root);
    const committed = state.committed.get(source.id);
    if (!committed || !equal(committed, entry)) fail('HISTORY_CHANGED');
    return report(operation, operation === 'recover' ? 'recovered' : 'added', state, stored, committed);
  } catch (error) {
    if (error instanceof WatchError) throw error;
    fail('HISTORY_WRITE');
  } finally {
    try { await root?.file.close(); } catch { fail('HISTORY_WRITE'); }
  }
}
