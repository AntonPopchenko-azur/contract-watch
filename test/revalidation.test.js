import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { revalidateHistory } from '../src/revalidation.js';
import { checkBranch } from '../src/branch-check.js';
import { historyTimeline } from '../src/timeline.js';
import { store, preserved, tree, json, hash, id, stageName, snapshotName } from './helpers/history-fixture.js';
import { fakeRpc, fixture, cli, IMPLEMENTATION, EMPTY } from './helpers/fake-rpc.js';
import { watchChild, watchPreload } from './helpers/watch-child.js';

const h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const q = n => `0x${BigInt(n).toString(16)}`;
const genesis = { number: '0x0', hash: h(1), parentHash: EMPTY };
const block = (n, branch = 0) => ({ number: q(n), hash: h(BigInt(n) + 1n + BigInt(branch) * 1000n),
  parentHash: BigInt(n) === 0n ? EMPTY : h(BigInt(n) + BigInt(branch) * 1000n) });
const snapshot = (n, branch = 0, time = Number(n)) => ({ ...fixture(), schemaVersion: 4, source: 'rpc',
  capturedAt: new Date(Date.UTC(2026, 10, 14, 10, 0, time)).toISOString(),
  block: { number: q(n), hash: block(n, branch).hash }, genesis: { status: 'observed', hash: genesis.hash },
  implementation: { status: 'observed', via: 'implementation-slot', address: IMPLEMENTATION, code: '0x6000' } });
const identity = { chainId: '1', genesis: { status: 'observed', hash: genesis.hash } };
const options = (directory, rpc, extra = {}) => ({ directory, rpc, anchor: block(3).hash, maxBlocks: '3', ...extra });
const proofOptions = (endpoint, extra = {}) => ({ endpoint, anchor: block(3).hash, maxBlocks: 3, timeoutMs: 1000, deadlineMs: 10000, ...extra });
const args = (directory, rpc, extra = []) => ['history', 'revalidate', '--dir', directory, '--rpc', rpc,
  '--anchor', block(3).hash, '--max-blocks', '3', ...extra];
function answer(request, headers = [block(3), block(2), block(1), genesis], chainId = '0x1') {
  if (request.method === 'eth_chainId') { assert.deepEqual(request.params, []); return chainId; }
  assert.equal(request.params[1], false);
  if (request.method === 'eth_getBlockByHash') return headers.find(h => h.hash === request.params[0]) ?? null;
  if (request.method === 'eth_getBlockByNumber') return headers.find(h => h.number === request.params[0]) ?? null;
  assert.fail('unexpected method');
}
async function server(t, headers, chainId) { return fakeRpc(t, r => ({ result: answer(r, headers, chainId) })); }
const safeFailure = (result, code) => {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]: [^\\n]+\\n$`));
  assert.doesNotMatch(result.stderr, /PRIVATE|127\.0\.0\.1|secret|stack/);
};

test('fork, multiple displacement and return: complete evidence, rebuilt endpoint pairs and untouched raw timeline', async t => {
  const values = [snapshot(1), snapshot(2, 1), snapshot(3, 1), snapshot(2, 0, 4), snapshot(3, 0, 5)];
  values[1].code = '0x61'; values[2].code = '0x62'; values[3].code = values[4].code = '0x63';
  const p = await store(t, values, { pending: [snapshot(4)], stages: ['PRIVATE partial'] }), rpc = await server(t);
  const rawBefore = await historyTimeline(p.directory);
  const result = await preserved(p.directory, () => cli(args(p.directory, rpc.url + '/secret')));
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const d = JSON.parse(result.stdout);
  assert.equal(d.kind, 'contract-watch-history-branch'); assert.equal(d.schemaVersion, 1);
  assert.equal(d.pending, 1); assert.equal(d.staged, 1); assert.equal(d.sourceUnchanged, true);
  assert.deepEqual(d.observations.map(o => o.status), ['on-branch', 'displaced', 'displaced', 'on-branch', 'on-branch']);
  assert.deepEqual(d.visibleOrdinals, [1, 4, 5]);
  assert.deepEqual(d.transitions.map(p => [p.from, p.to, p.changed, p.omittedOrdinals]), [[1, 4, true, [2, 3]], [4, 5, false, []]]);
  assert.deepEqual(d.transitions[0].changes, [{ field: 'code', before: { bytes: 4, sha256: hash(Buffer.from('60006000', 'hex')) },
    after: { bytes: 1, sha256: hash(Buffer.from('63', 'hex')) } }]);
  assert.equal(d.transitions[0].implementation.comparison, 'comparable');
  assert.deepEqual(d.transitions[0].implementation.changes, []);
  assert.deepEqual(d.transitions[0].implementation.before, d.transitions[0].implementation.after);
  assert.deepEqual(d.observations.map(o => o.observationId), values.map(id));
  const { evidenceId, ...evidence } = d.evidence;
  assert.equal(evidenceId, id(evidence)); assert.match(evidence.historyState, /^[a-f0-9]{64}$/);
  assert.match(evidence.verificationId, /^[a-f0-9-]{36}$/); assert.equal(evidence.requests, 9);
  assert.deepEqual(evidence.headers, [block(3), block(2), block(1)]);
  assert.deepEqual(evidence.checks.before, evidence.checks.after);
  assert.ok(Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt));
  assert.doesNotMatch(result.stdout, /secret|127\.0\.0\.1|PRIVATE/);
  assert.deepEqual(await historyTimeline(p.directory), rawBefore);
  assert.equal(rawBefore.schemaVersion, 1); assert.equal(rawBefore.observations.length, 5);
  assert.deepEqual(rpc.calls.map(r => [r.method, r.params]), [
    ['eth_chainId', []], ['eth_getBlockByNumber', ['0x0', false]],
    ['eth_getBlockByHash', [block(3).hash, false]], ['eth_getBlockByNumber', ['0x3', false]],
    ['eth_getBlockByHash', [block(2).hash, false]], ['eth_getBlockByHash', [block(1).hash, false]],
    ['eth_getBlockByNumber', ['0x3', false]], ['eth_getBlockByNumber', ['0x0', false]], ['eth_chainId', []]
  ]);
});

test('repeat and nonmonotonic observations retain index order; unverified range stays unknown', async t => {
  const values = [snapshot(0), snapshot(3), snapshot(3, 0, 4), snapshot(1, 0, 5), snapshot(4, 0, 6)];
  const p = await store(t, values), rpc = await server(t);
  const d = await revalidateHistory(options(p.directory, rpc.url));
  assert.deepEqual(d.visibleOrdinals, [2, 3, 4]);
  assert.deepEqual(d.observations.map(o => o.status), ['unknown', 'on-branch', 'on-branch', 'on-branch', 'unknown']);
  assert.equal(d.transitions[0].changed, false); assert.equal(d.transitions[1].status, 'unavailable');
  assert.equal(d.transitions[1].reason.code, 'ORDER');
  assert.equal(d.observations[0].reason, 'OUTSIDE_CHECKED_RANGE');
});

for (const field of ['code', 'slot', 'implementation', 'number']) test(`all occurrences of conflicting saved hash become unknown: ${field}`, async t => {
  const a = snapshot(2), b = snapshot(2, 0, 3), c = snapshot(2, 0, 4);
  if (field === 'code') b.code = '0x61';
  if (field === 'slot') b.slots.admin = h(55);
  if (field === 'implementation') b.implementation.code = '0x61';
  if (field === 'number') b.block.number = '0x1';
  const p = await store(t, [a, b, c]), rpc = await server(t);
  const d = await preserved(p.directory, () => revalidateHistory(options(p.directory, rpc.url)));
  assert.deepEqual(d.visibleOrdinals, []); assert.deepEqual(d.transitions, []);
  assert.deepEqual(d.observations.map(o => [o.status, o.reason]), Array(3).fill(['unknown', 'CONTRADICTORY_SAVED_DATA']));
});

test('missing implementation remains unavailable, without manufacturing a same-hash conflict', async t => {
  const a = snapshot(2), b = snapshot(2, 0, 3); a.implementation = { status: 'not-recorded' };
  const p = await store(t, [a, b]), rpc = await server(t);
  const d = await revalidateHistory(options(p.directory, rpc.url));
  assert.deepEqual(d.visibleOrdinals, [1, 2]); assert.equal(d.transitions[0].changed, false);
  assert.equal(d.transitions[0].implementation.comparison, 'unavailable');
});

for (const hash of [block(3).hash, genesis.hash]) test('saved known hash claiming the wrong height stays unknown', async t => {
  const a = snapshot(2); a.block.hash = hash;
  const p = await store(t, [a]), rpc = await server(t);
  const d = await revalidateHistory(options(p.directory, rpc.url));
  assert.equal(d.observations[0].status, 'unknown'); assert.equal(d.observations[0].reason, 'SAVED_NUMBER_MISMATCH');
});

test('independent retained-prefix fixture preserves gaps, later unknown origins and raw v2 timeline', async t => {
  const values = [snapshot(1), snapshot(2), snapshot(3), snapshot(3, 0, 8)], p = await store(t, values);
  const header = { ...p.state.header, schemaVersion: 2, retention: { policy: 'baseline-and-last', keepLast: 2,
    sourceState: 'a'.repeat(64), sourceCommitted: 5, sourcePending: 0, sourceStaged: 0, ordinals: [1, 4, 5],
    observationsSha256: id(values.slice(0, 3).map(id)), planId: 'b'.repeat(64) } };
  await fs.writeFile(join(p.directory, 'index.json'), json(header));
  let previous = hash(json(header));
  for (const record of p.state.committed.values()) {
    const bytes = json({ ...record, previous }); previous = hash(bytes);
    await fs.writeFile(join(p.directory, `entry-${String(record.ordinal).padStart(4, '0')}.json`), bytes);
  }
  const raw = await historyTimeline(p.directory), rpc = await server(t);
  const d = await preserved(p.directory, () => revalidateHistory(options(p.directory, rpc.url)));
  assert.equal(d.historyVersion, 2); assert.deepEqual(d.retention, header.retention);
  assert.deepEqual(d.observations.map(o => o.originalOrdinal), [1, 4, 5, null]);
  assert.deepEqual(d.transitions.map(p => p.retentionGap), [true, false, null]);
  assert.equal(raw.schemaVersion, 2); assert.deepEqual(await historyTimeline(p.directory), raw);
});

for (const type of ['v1', 'v2', 'v3', 'unknown-genesis', 'synthetic']) test(`identity refused before environment access: ${type}`, async t => {
  const a = snapshot(1);
  if (type === 'synthetic') a.source = 'synthetic';
  else if (type === 'unknown-genesis') { a.genesis = { status: 'not-recorded' }; a.migration = { fromVersion: 2 }; }
  else { a.schemaVersion = Number(type.slice(1)); delete a.genesis;
    if (a.schemaVersion === 1) delete a.implementation;
    if (a.schemaVersion === 3) a.migration = { fromVersion: 2 }; }
  const p = await store(t, [a]); let reads = 0;
  const env = { get PRIVATE() { reads++; throw Error('secret'); } };
  await assert.rejects(preserved(p.directory, () => revalidateHistory(options(p.directory, undefined, { rpcEnv: 'PRIVATE' }), env)), { code: 'BRANCH_IDENTITY' });
  assert.equal(reads, 0);
});

test('only one explicit own environment property is resolved once; defaults cannot supply an endpoint', async t => {
  const p = await store(t, [snapshot(1)]), rpc = await server(t); let reads = 0;
  const env = { get PRIVATE() { reads++; return rpc.url; }, get CONTRACT_WATCH_RPC_URL() { assert.fail('default access'); } };
  await revalidateHistory(options(p.directory, undefined, { rpcEnv: 'PRIVATE' }), env); assert.equal(reads, 1);
  await assert.rejects(revalidateHistory(options(p.directory, undefined), env), { code: 'USAGE' });
  await assert.rejects(revalidateHistory(options(p.directory, undefined, { rpcEnv: 'PRIVATE' }), Object.create({ PRIVATE: rpc.url })), { code: 'CONFIG_ENV' });
  assert.equal(rpc.calls.length, 9);
});

for (const n of [0, 1, 127]) test(`exact successful request budget, early genesis and bounded 128 headers from height ${n}`, async t => {
  const headers = Array.from({ length: n + 1 }, (_, i) => block(n - i)), rpc = await server(t, headers);
  const proof = await checkBranch(identity, proofOptions(rpc.url, { anchor: headers[0].hash, maxBlocks: 128 }));
  assert.equal(proof.headers.length, n + 1); assert.equal(proof.requests, n + 7); assert.equal(rpc.calls.length, n + 7);
  assert.deepEqual(proof.headers, headers);
});

test('full uint256 chain IDs and heights use exact arithmetic throughout evidence and comparisons', async t => {
  const max = (1n << 256n) - 1n;
  const headers = [{ number: q(max), hash: h(900), parentHash: h(899) }, { number: q(max - 1n), hash: h(899), parentHash: h(898) }, genesis];
  const values = [snapshot(1), snapshot(2)];
  for (const [i, value] of values.entries()) { value.chainId = max.toString(); value.block = { number: headers[1-i].number, hash: headers[1-i].hash }; }
  const p = await store(t, values), rpc = await server(t, headers, q(max));
  const d = await revalidateHistory(options(p.directory, rpc.url, { anchor: h(900), maxBlocks: '2' }));
  assert.equal(d.identity.chainId, max.toString()); assert.equal(d.observations[1].block.number, q(max));
  assert.deepEqual(d.visibleOrdinals, [1, 2]); assert.equal(d.transitions[0].changed, false);
});

test('fresh explicit checks can select another branch and then return; prior report and raw history remain intact', async t => {
  const p = await store(t, [snapshot(1), snapshot(2, 1), snapshot(3, 1), snapshot(2, 0, 4), snapshot(3, 0, 5)]);
  const fork = [block(3, 1), { ...block(2, 1), parentHash: block(1).hash }, block(1), genesis];
  const a = await server(t), b = await server(t, fork);
  await preserved(p.directory, async () => {
    const first = await revalidateHistory(options(p.directory, a.url)), saved = JSON.stringify(first);
    const changed = await revalidateHistory(options(p.directory, b.url, { anchor: fork[0].hash }));
    const returned = await revalidateHistory(options(p.directory, a.url));
    assert.deepEqual(changed.visibleOrdinals, [1, 2, 3]); assert.deepEqual(returned.visibleOrdinals, [1, 4, 5]);
    assert.deepEqual(first.observations, returned.observations); assert.equal(JSON.stringify(first), saved);
    assert.notEqual(first.evidence.verificationId, returned.evidence.verificationId);
    assert.equal(first.evidence.historyState, changed.evidence.historyState);
  });
});

test('consistent-looking self-cycle fails during traversal, without completing checks', async t => {
  const head = { ...block(3), parentHash: block(3).hash }, rpc = await server(t, [head, genesis]);
  await assert.rejects(checkBranch(identity, proofOptions(rpc.url)), { code: 'BRANCH_HEADERS' });
  assert.equal(rpc.calls.length, 5);
});

for (const kind of ['self', 'cycle', 'genesis-parent', 'wrong-genesis-parent']) test(`known contradiction at truncated coverage boundary: ${kind}`, async t => {
  const head = kind === 'wrong-genesis-parent' ? { ...block(1), parentHash: h(99) } : block(3);
  if (kind === 'self') head.parentHash = head.hash;
  if (kind === 'genesis-parent') head.parentHash = genesis.hash;
  const headers = kind === 'cycle' ? [head, { ...block(2), parentHash: head.hash }, genesis] : [head, genesis];
  const rpc = await server(t, headers);
  await assert.rejects(checkBranch(identity, proofOptions(rpc.url, { anchor: head.hash, maxBlocks: kind === 'cycle' ? 2 : 1 })), { code: 'BRANCH_HEADERS' });
  assert.equal(rpc.calls.length, kind === 'cycle' ? 5 : 4);
});

test('reaching a different genesis or seeing its hash at another height fails linked evidence', async t => {
  const bad = { number: '0x0', hash: h(66), parentHash: EMPTY };
  const head = { ...block(1), parentHash: bad.hash };
  const rpc = await fakeRpc(t, r => ({ result: r.method === 'eth_getBlockByHash' && r.params[0] === bad.hash ? bad : answer(r, [head, genesis]) }));
  await assert.rejects(checkBranch(identity, proofOptions(rpc.url, { anchor: head.hash, maxBlocks: 2 })), { code: 'BRANCH_HEADERS' });
  assert.equal(rpc.calls.length, 5);
  const wrong = { number: '0x1', hash: genesis.hash, parentHash: h(9) };
  const other = await fakeRpc(t, r => ({ result: r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0' ? genesis : answer(r, [wrong]) }));
  await assert.rejects(checkBranch(identity, proofOptions(other.url, { anchor: wrong.hash, maxBlocks: 1 })), { code: 'BRANCH_HEADERS' });
  assert.equal(other.calls.length, 4);
});

test('one-header coverage exposes unknown peers; empty valid history has no fabricated transitions', async t => {
  const p = await store(t, [snapshot(2), snapshot(3)]), rpc = await server(t);
  const d = await revalidateHistory(options(p.directory, rpc.url, { maxBlocks: '1' }));
  assert.deepEqual(d.observations.map(o => o.status), ['unknown', 'on-branch']); assert.deepEqual(d.transitions, []);
  assert.equal(d.evidence.requests, 7);
  const empty = await store(t, [], { seed: snapshot(1) });
  const e = await revalidateHistory(options(empty.directory, rpc.url));
  assert.equal(e.committed, 0); assert.deepEqual(e.observations, []); assert.deepEqual(e.transitions, []);
});

for (const mutation of ['missing', 'duplicate-key', 'oversize-index', 'symlink', 'pending-identity']) test(`initial ${mutation} history refuses before environment or RPC`, async t => {
  const a = snapshot(1), p = await store(t, [a]);
  const path = join(p.directory, 'index.json');
  if (mutation === 'missing') await fs.unlink(join(p.directory, 'entry-0001.json'));
  if (mutation === 'duplicate-key') await fs.writeFile(path, '{"kind":"secret",' + json(p.state.header).slice(1));
  if (mutation === 'oversize-index') await fs.appendFile(path, ' '.repeat(4096));
  if (mutation === 'symlink') { await fs.rename(path, join(p.parent, 'saved.json')); await fs.symlink(join(p.parent, 'saved.json'), path); }
  if (mutation === 'pending-identity') { const value = snapshot(2); value.chainId = '2'; await fs.writeFile(join(p.directory, snapshotName(value)), json(value)); }
  let reads = 0;
  // Removing the last entry makes a valid pending-only history; test a missing snapshot instead.
  if (mutation === 'missing') await fs.unlink(join(p.directory, snapshotName(a)));
  if (mutation === 'missing') await fs.writeFile(join(p.directory, 'entry-0001.json'), json([...p.state.committed.values()][0]));
  await assert.rejects(revalidateHistory(options(p.directory, undefined, { rpcEnv: 'PRIVATE' }),
    { get PRIVATE() { reads++; throw Error('secret'); } }), e => ['HISTORY_CORRUPT', 'HISTORY_IDENTITY'].includes(e.code));
  assert.equal(reads, 0);
});

const failures = [
  ['wrong chain', 1, '0x2', 'CHAIN_MISMATCH'], ['wrong genesis', 2, { ...genesis, hash: h(99) }, 'BRANCH_IDENTITY'],
  ['bad genesis height', 2, { ...block(1), hash: genesis.hash }, 'BRANCH_IDENTITY'],
  ['missing anchor', 3, null, 'BLOCK_UNAVAILABLE'], ['wrong anchor hash', 3, block(2), 'BRANCH_HEADERS'],
  ['not canonical', 4, block(3, 1), 'BLOCK_NOT_CANONICAL'], ['missing parent', 5, null, 'BLOCK_UNAVAILABLE'],
  ['wrong parent hash', 5, block(2, 1), 'BRANCH_HEADERS'], ['skipped parent height', 5, { ...block(2), number: '0x1' }, 'BRANCH_HEADERS'],
  ['final anchor race', 7, block(3, 1), 'BLOCK_CHANGED'], ['final parent race', 7, { ...block(3), parentHash: h(99) }, 'BLOCK_CHANGED'],
  ['final genesis race', 8, { ...genesis, hash: h(99) }, 'GENESIS_CHANGED'], ['final chain race', 9, '0x2', 'CHAIN_MISMATCH'],
  ['pending header', 3, { ...block(3), number: null }, 'RPC_DATA'], ['missing parentHash', 3, { number: '0x3', hash: block(3).hash }, 'RPC_DATA'],
  ['zero hash', 3, { ...block(3), hash: EMPTY }, 'RPC_DATA'], ['zero parent', 3, { ...block(3), parentHash: EMPTY }, 'RPC_DATA'],
  ['noncanonical quantity', 3, { ...block(3), number: '0x03' }, 'RPC_DATA'], ['overflow quantity', 3, { ...block(3), number: '0x1' + '0'.repeat(64) }, 'RPC_DATA'],
  ['array header', 3, [], 'RPC_DATA']
];
for (const [name, at, value, code] of failures) test(`all-or-error verification: ${name}`, async t => {
  const p = await store(t, [snapshot(1), snapshot(2, 1)]); let count = 0;
  const rpc = await fakeRpc(t, r => ({ result: ++count === at ? value : answer(r) }));
  const result = await preserved(p.directory, () => cli(args(p.directory, rpc.url + '/secret')));
  safeFailure(result, code); assert.equal(count, at);
});

for (const kind of ['missing', 'unsupported', 'timeout', 'body', 'header', 'envelope', 'http']) test(`no retry or partial view on ${kind}`, async t => {
  const p = await store(t, [snapshot(1)]); let count = 0;
  const rpc = await fakeRpc(t, (r, res) => {
    count++;
    if (kind === 'timeout') return undefined;
    if (kind === 'http') { res.writeHead(503); res.end('secret'); return; }
    if (kind === 'body') { res.end(' '.repeat(1024 * 1024 + 1)); return; }
    if (kind === 'header') { res.setHeader('X-Private', 'secret'.repeat(3000)); res.end('{}'); return; }
    if (kind === 'envelope') { res.end('{"secret":true}'); return; }
    if (kind === 'unsupported') return { error: { code: -32601, message: 'PRIVATE secret' } };
    return { result: null };
  });
  const result = await preserved(p.directory, () => cli(args(p.directory, rpc.url, ['--timeout-ms', '100'])));
  safeFailure(result, { missing: 'RPC_DATA', unsupported: 'RPC_REMOTE', timeout: 'RPC_TIMEOUT', body: 'RPC_SIZE',
    header: 'RPC_NETWORK', envelope: 'RPC_ENVELOPE', http: 'RPC_HTTP' }[kind]);
  assert.equal(count, 1);
});

test('deadline bounds a stalled request and monotonic exhaustion prevents final success', async t => {
  const p = await store(t, [snapshot(1)]), stalled = await fakeRpc(t, () => undefined);
  safeFailure(await cli(args(p.directory, stalled.url, ['--deadline-ms', '100'])), 'CAPTURE_DEADLINE');
  let now = 0, calls = 0;
  const rpc = await fakeRpc(t, r => { if (++calls === 9) now = 10001; return { result: answer(r) }; });
  await assert.rejects(checkBranch(identity, proofOptions(rpc.url), { now: () => now }), { code: 'CAPTURE_DEADLINE' });
  assert.equal(calls, 9);
});

for (const mutation of ['stage', 'snapshot', 'metadata', 'root']) test(`source binding refuses concurrent ${mutation} change with empty stdout`, async t => {
  const a = snapshot(1), p = await store(t, [a]); let calls = 0;
  const rpc = await fakeRpc(t, async r => {
    if (++calls === 1) {
      if (mutation === 'stage') await fs.writeFile(join(p.directory, stageName(99)), 'PRIVATE');
      if (mutation === 'snapshot') await fs.appendFile(join(p.directory, snapshotName(a)), ' ');
      if (mutation === 'metadata') await fs.chmod(join(p.directory, snapshotName(a)), 0o640);
      if (mutation === 'root') { await fs.rename(p.directory, p.output); await fs.mkdir(p.directory); }
    }
    return { result: answer(r) };
  });
  const result = await cli(args(p.directory, rpc.url));
  safeFailure(result, 'HISTORY_CHANGED');
  assert.equal(calls, 9);
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`live ${signal} drains transport with empty stdout and untouched files`, async t => {
  const p = await store(t, [snapshot(1)]), before = await tree(p.directory); let child, seen;
  const requested = new Promise(resolve => { seen = resolve; });
  const rpc = await fakeRpc(t, () => { seen(); return undefined; });
  child = watchChild(t, args(p.directory, rpc.url));
  await requested; child.p.kill(signal);
  const result = await child.result;
  assert.equal(result.code, signal === 'SIGINT' ? 130 : 143); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error \[CAPTURE_CANCELLED\]:/); assert.equal(rpc.calls.length, 1);
  assert.deepEqual(await tree(p.directory), before);
});

test('cancellation at the report boundary suppresses a completed read-only report', async t => {
  const p = await store(t, [snapshot(1)]), rpc = await server(t);
  // runLive has two setImmediate boundaries; gate the second using a test-only preload.
  const preload = await watchPreload(p.parent, 'none', 1, `
let branchTurns=0;
timers.setImmediate=async(...a)=>{if(++branchTurns===2){process.send({point:'branch-report'});await new Promise(r=>process.once('message',r));}return immediate(...a);};
`);
  const before = await tree(p.directory), child = watchChild(t, args(p.directory, rpc.url), { NODE_OPTIONS: `--import=${preload}` });
  await child.message(m => m.point === 'branch-report'); child.p.kill('SIGTERM');
  await child.message(m => m.signal === 'SIGTERM'); child.p.send('resume');
  const result = await child.result;
  assert.equal(result.code, 143); assert.equal(result.stdout, ''); assert.equal(rpc.calls.length, 9);
  assert.deepEqual(await tree(p.directory), before);
});

for (const [key, values, code] of [
  ['maxBlocks', ['', '0', '129', '01', '1.0', '-1', '1e2', '9'.repeat(1000)], 'BRANCH_LIMIT'],
  ['anchor', ['latest', EMPTY, '0x1', 'PRIVATE'], 'BLOCK_HASH'],
  ['timeoutMs', ['99', '60001', '0100', '1e3'], 'TIMEOUT_OPTION'],
  ['deadlineMs', ['99', '600001', '0100', '1e3'], 'DEADLINE_OPTION'],
  ['rpcEnv', ['x', 'PRIVATE-X', 'A'.repeat(65)], 'USAGE']
]) for (const value of values) test(`local option refusal before env: ${key} ${value.slice(0, 12)}`, async () => {
  let reads = 0;
  await assert.rejects(revalidateHistory(options('/PRIVATE', undefined, { rpcEnv: 'PRIVATE', [key]: value }),
    { get PRIVATE() { reads++; return 'https://PRIVATE'; } }), { code });
  assert.equal(reads, 0);
});

for (const extra of [['--json'], ['--out', 'PRIVATE'], ['--retries', '1'], ['--config', 'PRIVATE'],
  ['--max-blocks', '2'], ['--rpc-env', 'PRIVATE'], ['--anchor'], ['--unknown', 'PRIVATE']]) test(`CLI rejects unsupported or duplicate flags ${extra[0]}`, async t => {
  const p = await store(t, [snapshot(1)]), rpc = await server(t);
  safeFailure(await cli(args(p.directory, rpc.url, extra)), 'USAGE'); assert.equal(rpc.calls.length, 0);
});
