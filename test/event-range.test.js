import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { readEventRange, eventRangeJson } from '../src/event-range.js';
import { rangeBounds, splitRange, rangeBudget, RANGE_LIMITS } from '../src/event-range-policy.js';
import { createRpc } from '../src/rpc.js';
import { fakeRpc, cli, fixture, EMPTY } from './helpers/fake-rpc.js';
import { preserved, store, tree } from './helpers/history-fixture.js';
import { watchChild, watchPreload } from './helpers/watch-child.js';

const f = JSON.parse(await fs.readFile(new URL('fixtures/event-range/inputs.json', import.meta.url), 'utf8'));
const h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const q = n => `0x${BigInt(n).toString(16)}`;
const options = (rpc, value = f, extra = {}) => ({ rpc, address: value.address, chainId: value.chainId,
  genesisHash: value.genesis.hash, fromBlock: BigInt(value.blocks[0].number).toString(),
  toBlock: BigInt(value.blocks.at(-1).number).toString(), toHash: value.blocks.at(-1).hash, ...extra });
const args = (rpc, extra = [], value = f) => {
  const o = options(rpc, value);
  return ['events-range', '--rpc', rpc, '--address', o.address, '--chain-id', o.chainId,
    '--genesis-hash', o.genesisHash, '--from-block', o.fromBlock, '--to-block', o.toBlock, '--to-hash', o.toHash, ...extra];
};
function answer(r, value = f) {
  if (r.method === 'eth_chainId') return q(value.chainId);
  if (r.method === 'eth_getBlockByNumber') return value.blocks.find(b => b.number === r.params[0]) ?? (r.params[0] === '0x0' ? value.genesis : null);
  if (r.method === 'eth_getBlockByHash') return value.blocks.find(b => b.hash === r.params[0]) ?? null;
  if (r.method === 'eth_getLogs') return value.logs.filter(log => BigInt(log.blockNumber) >= BigInt(r.params[0].fromBlock) && BigInt(log.blockNumber) <= BigInt(r.params[0].toBlock));
  assert.fail('unexpected RPC');
}
const limit = { error: { code: -32005, message: 'PRIVATE secret response limit', data: { secret: 'PRIVATE' } } };
const server = (t, value = f, width = 32) => fakeRpc(t, r => r.method === 'eth_getLogs' && BigInt(r.params[0].toBlock) - BigInt(r.params[0].fromBlock) >= BigInt(width)
  ? limit : { result: answer(r, value) });
function dataSet(count, first = 100n) {
  const value = structuredClone(f); value.logs = [];
  value.blocks = Array.from({ length: count }, (_, i) => ({ number: q(first + BigInt(i)),
    hash: first + BigInt(i) === 0n ? value.genesis.hash : h(6000 + i),
    parentHash: first + BigInt(i) === 0n ? EMPTY : first + BigInt(i) === 1n ? value.genesis.hash : i === 0 ? h(4095) : h(6000 + i - 1),
    timestamp: q(1700000000 + i), transactions: [h(100 * (i + 1))] }));
  if (first === 0n && count > 1) value.blocks[1].parentHash = value.genesis.hash;
  return value;
}
function logFor(block, index = 0, template = f.logs[0]) {
  const log = { ...structuredClone(template), blockHash: block.hash, blockNumber: block.number,
    transactionHash: block.transactions[0], transactionIndex: '0x0', logIndex: q(index) };
  if (Object.hasOwn(log, 'blockTimestamp')) log.blockTimestamp = block.timestamp;
  return log;
}
function incomplete(result, code) {
  assert.equal(result.code, 1); assert.equal(result.stderr, '');
  const d = JSON.parse(result.stdout);
  assert.equal(d.status, 'incomplete'); assert.equal(d.coverageVerified, false);
  assert.equal(d.logs, null); assert.equal(d.blocks, null); assert.equal(d.failure.code, code);
  assert.ok(d.coverage.every(c => !['read', 'read-empty'].includes(c.status)));
  assert.doesNotMatch(result.stdout, /PRIVATE|secret|127\.0\.0\.1|stack/);
  return d;
}
function invalid(result, code) {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]:`));
  assert.doesNotMatch(result.stderr, /PRIVATE|secret|127\.0\.0\.1|stack/);
}

test('independent four-block fixture: stable bindings, deterministic logs and exact unsplit budget', async t => {
  const value = structuredClone(f); value.logs.reverse(); const rpc = await server(t, value);
  const p = await store(t, [fixture()], { stages: ['PRIVATE partial'] });
  await fs.writeFile(join(p.parent, 'PRIVATE_user.json'), 'preserve original bytes');
  const result = await preserved(p.parent, () => cli(args(rpc.url + '/secret')));
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const d = JSON.parse(result.stdout);
  assert.equal(d.kind, 'contract-watch-event-range'); assert.equal(d.schemaVersion, 1);
  assert.equal(d.status, 'complete'); assert.equal(d.completeness, 'unverified'); assert.equal(d.coverageVerified, true);
  assert.deepEqual(d.logs.map(l => [l.blockNumber, l.logIndex, l.event]), [['0x64', '0x0', 'Upgraded'], ['0x66', '0x3', 'AdminChanged'], ['0x67', '0x6', 'BeaconUpgraded']]);
  assert.deepEqual(d.logs.map(l => l.arguments), [{ implementation: '0x' + '2'.repeat(40) },
    { previousAdmin: '0x' + '0'.repeat(40), newAdmin: '0x' + '3'.repeat(40) }, { beacon: '0x' + '4'.repeat(40) }]);
  assert.deepEqual(d.coverage.map(c => [c.number, c.status, c.uniqueLogs]), [['0x64', 'read', 1], ['0x65', 'read-empty', 0], ['0x66', 'read', 1], ['0x67', 'read', 1]]);
  assert.deepEqual(d.blocks.map(b => b.hash), f.blocks.map(b => b.hash));
  assert.equal(d.verification.requests, 16); assert.equal(d.verification.logRequests, 1); assert.equal(d.verification.receivedLogs, 3);
  assert.match(d.verification.rangeSha256, /^[a-f0-9]{64}$/); assert.doesNotMatch(result.stdout, /PRIVATE|secret|127\.0\.0\.1/);
  const anchor = f.blocks.at(-1);
  assert.deepEqual(rpc.calls.map(r => [r.method, r.params]), [
    ['eth_chainId', []], ['eth_getBlockByNumber', ['0x0', false]], ['eth_getBlockByHash', [anchor.hash, false]],
    ['eth_getBlockByNumber', [anchor.number, false]],
    ...f.blocks.slice(0, -1).reverse().map(b => ['eth_getBlockByHash', [b.hash, false]]),
    ['eth_getBlockByNumber', [anchor.number, false]],
    ['eth_getLogs', [{ address: f.address, fromBlock: '0x64', toBlock: '0x67', topics: [f.topics] }]],
    ['eth_getBlockByNumber', [anchor.number, false]],
    ...f.blocks.map(b => ['eth_getBlockByNumber', [b.number, false]]),
    ['eth_getBlockByNumber', ['0x0', false]], ['eth_chainId', []]
  ]);
  assert.deepEqual(rpc.calls.map(r => r.id), Array.from({ length: 16 }, (_, i) => i + 1));
});

test('multi-level splitting is left-first, inclusive, nonoverlapping and preserves explicit empty coverage', async t => {
  const rpc = await server(t, f, 1), d = await readEventRange(options(rpc.url));
  assert.equal(d.status, 'complete');
  assert.deepEqual(rpc.calls.filter(r => r.method === 'eth_getLogs').map(r => [r.params[0].fromBlock, r.params[0].toBlock]),
    [['0x64', '0x67'], ['0x64', '0x65'], ['0x64', '0x64'], ['0x65', '0x65'], ['0x66', '0x67'], ['0x66', '0x66'], ['0x67', '0x67']]);
  assert.deepEqual(d.pages.map(p => [p.id, p.parentId, p.depth, p.status, p.attempt]),
    [[1, null, 0, 'split', 1], [2, 1, 1, 'split', 2], [3, 1, 1, 'split', 5], [4, 2, 2, 'read', 3], [5, 2, 2, 'read-empty', 4], [6, 3, 2, 'read', 6], [7, 3, 2, 'read', 7]]);
  assert.deepEqual(d.coverage.map(c => c.pageId), [4, 5, 6, 7]);
  assert.ok(d.pages.every(p => p.anchorBefore && p.anchorAfter));
  assert.equal(d.verification.requests, 34); assert.equal(d.verification.logRequests, 7); assert.equal(d.logs.length, 3);
});

for (const [count, first, width] of [[1, 100n, 1], [1, 0n, 1], [2, 0n, 1], [32, 100n, 1], [32, 100n, 32]]) test(`range boundary ${count} blocks at ${first}, page width ${width}`, async t => {
  const value = dataSet(count, first), rpc = await server(t, value, width), d = await readEventRange(options(rpc.url, value));
  assert.equal(d.status, 'complete', JSON.stringify(d.failure)); assert.equal(d.logs.length, 0);
  assert.ok(d.coverage.every(c => c.status === 'read-empty'));
  const attempts = width === 1 ? 2 * count - 1 : 1;
  assert.equal(d.verification.logRequests, attempts); assert.equal(d.verification.requests, 2 * count + 5 + 3 * attempts);
  if (count === 32 && width === 1) { assert.equal(d.pages.length, 63); assert.equal(Math.max(...d.pages.map(p => p.depth)), 5); assert.equal(rpc.calls.length, 258); }
});

test('all valid splits form an exact partition, including full uint256 endpoints', () => {
  for (const base of [0n, (1n << 256n) - 32n]) for (let n = 1n; n <= 32n; n++) {
    const pending = [[base, base + n - 1n]], leaves = [];
    while (pending.length) { const [a, b] = pending.pop(); if (a === b) leaves.push(a); else { const [left, right] = splitRange(a, b); assert.equal(left[1] + 1n, right[0]); pending.push(right, left); } }
    assert.deepEqual(leaves, Array.from({ length: Number(n) }, (_, i) => base + BigInt(i)));
  }
});

test('uint256 endpoints, chain and global log indices are exact through split and report', async t => {
  const max = (1n << 256n) - 1n, value = dataSet(3, max - 2n); value.chainId = max.toString();
  value.logs = value.blocks.map(b => logFor(b, max));
  const rpc = await server(t, value, 1), d = await readEventRange(options(rpc.url, value));
  assert.equal(d.status, 'complete'); assert.equal(d.range.toBlock, q(max)); assert.equal(d.chainId, max.toString());
  assert.deepEqual(d.logs.map(l => l.logIndex), [q(max), q(max), q(max)]);
  assert.equal(d.verification.requests, 26);
});

test('valid identical repeats normalize and deduplicate; filtered global-index gaps stay valid', async t => {
  const value = structuredClone(f), duplicate = structuredClone(value.logs[0]);
  duplicate.blockHash = '0x' + duplicate.blockHash.slice(2).toUpperCase();
  duplicate.topics = duplicate.topics.map(v => '0x' + v.slice(2).toUpperCase()); value.logs.push(duplicate, structuredClone(value.logs[2]));
  const rpc = await server(t, value), d = await readEventRange(options(rpc.url, value));
  assert.equal(d.status, 'complete'); assert.equal(d.logs.length, 3); assert.equal(d.verification.receivedLogs, 5);
  assert.equal(d.verification.duplicateLogs, 2); assert.equal(d.pages[0].duplicates, 2);
});

for (const mutation of ['value', 'transaction', 'optional-timestamp']) test(`same log identity with conflicting ${mutation} fails`, async t => {
  const value = structuredClone(f), duplicate = structuredClone(value.logs[0]);
  if (mutation === 'value') duplicate.topics[1] = EMPTY;
  if (mutation === 'transaction') { duplicate.transactionIndex = '0x1'; duplicate.transactionHash = value.blocks[0].transactions[1]; }
  if (mutation === 'optional-timestamp') duplicate.blockTimestamp = value.blocks[0].timestamp;
  value.logs.push(duplicate); const rpc = await server(t, value);
  incomplete(await cli(args(rpc.url)), 'RANGE_DUPLICATE'); assert.equal(rpc.calls.length, 9);
});

test('an identical prior-page log outside the new page is refused instead of hidden as a duplicate', async t => {
  const rpc = await fakeRpc(t, r => {
    if (r.method === 'eth_getLogs') {
      if (r.params[0].fromBlock === '0x64' && r.params[0].toBlock === '0x67') return limit;
      if (r.params[0].fromBlock === '0x66') return { result: [...answer(r), f.logs[0]] };
    }
    return { result: answer(r) };
  });
  const d = incomplete(await cli(args(rpc.url)), 'EVENT_LOG');
  assert.deepEqual(d.coverage.map(c => c.status), ['read-unverified', 'read-unverified', 'failed', 'failed']);
});

test('page failure journal distinguishes provisional empty pages, failed and unread blocks', async t => {
  const value = dataSet(4); let logCalls = 0;
  const rpc = await fakeRpc(t, r => {
    if (r.method === 'eth_getLogs') {
      logCalls++;
      if (logCalls === 4) return { error: { code: -32000, message: 'PRIVATE secret' } };
      if (r.params[0].fromBlock !== r.params[0].toBlock) return limit;
    }
    return { result: answer(r, value) };
  });
  const d = incomplete(await cli(args(rpc.url)), 'RPC_REMOTE');
  assert.deepEqual(d.coverage.map(c => [c.status, c.uniqueLogs]), [['read-unverified', 0], ['failed', null], ['unread', null], ['unread', null]]);
  assert.equal(d.pages.find(p => p.id === 4).returnedLogs, 0); assert.equal(logCalls, 4);
});

test('explicit max-pages exhausts without issuing a new log query or any unchecked success', async t => {
  const rpc = await server(t, f, 1), d = incomplete(await cli(args(rpc.url, ['--max-pages', '3'])), 'RANGE_PAGES');
  assert.equal(d.verification.logRequests, 3); assert.equal(d.verification.requests, 16);
  assert.deepEqual(d.coverage.map(c => c.status), ['read-unverified', 'failed', 'unread', 'unread']);
  assert.equal(d.pages.find(p => p.status === 'failed').attempt, null);
});

test('unsplittable provider limit is explicit, bounded and has no recovered logs', async t => {
  const value = dataSet(1), rpc = await fakeRpc(t, r => r.method === 'eth_getLogs' ? limit : { result: answer(r, value) });
  const d = incomplete(await cli(args(rpc.url, [], value)), 'RANGE_UNSPLITTABLE');
  assert.equal(d.verification.requests, 7); assert.equal(d.verification.logRequests, 1); assert.equal(d.pages.length, 1);
  assert.equal(d.pages[0].anchorAfter, true);
});

for (const [error, code] of [
  [{ code: -32000, message: 'limit exceeded PRIVATE' }, 'RPC_REMOTE'], [{ code: 4444, message: 'pruned' }, 'RPC_REMOTE'],
  [{ code: -32601, message: 'unsupported' }, 'RPC_REMOTE'], [{ code: '-32005', message: 'limit' }, 'RPC_ENVELOPE'],
  [{ code: -32005 }, 'RPC_ENVELOPE'], [{ code: -32005, message: null }, 'RPC_ENVELOPE'],
  [{ code: -32005, message: 'PRIVATE', extra: true }, 'RPC_ENVELOPE'], [null, 'RPC_ENVELOPE']
]) test(`only a valid -32005 envelope splits: ${JSON.stringify(error)}`, async t => {
  const rpc = await fakeRpc(t, r => r.method === 'eth_getLogs' ? { error } : { result: answer(r) });
  const d = incomplete(await cli(args(rpc.url)), code); assert.equal(d.pages.length, 1); assert.equal(d.verification.requests, 9);
});

for (const [name, mutate] of [
  ['target', l => l.address = '0x' + '9'.repeat(40)], ['removed', l => l.removed = true], ['pending', l => l.blockHash = null],
  ['wrong block', l => l.blockHash = h(99)], ['outside range', l => l.blockNumber = '0x63'], ['missing number', l => delete l.blockNumber],
  ['tx membership', l => l.transactionHash = h(99)], ['tx index', l => l.transactionIndex = '0xff'], ['log quantity', l => l.logIndex = '0x00'],
  ['unknown field', l => l.PRIVATE = 'secret'], ['signature', l => l.topics[0] = h(99)], ['topic count', l => l.topics.push(EMPTY)],
  ['padding', l => l.topics[1] = '0x01' + '00'.repeat(31)], ['data', l => l.data = EMPTY], ['timestamp', l => l.blockTimestamp = '0x1']
]) test(`page keeps strict event validation: ${name}`, async t => {
  const value = structuredClone(f); mutate(value.logs[0]);
  // Return every record, including an out-of-page record, so the decoder must refuse it.
  const rpc = await fakeRpc(t, r => ({ result: r.method === 'eth_getLogs' ? value.logs : answer(r, value) }));
  incomplete(await cli(args(rpc.url)), 'EVENT_LOG'); assert.equal(rpc.calls.length, 9);
});

test('cross-event global ordering cannot contradict the block transaction ordering', async t => {
  const value = structuredClone(f), block = value.blocks[0];
  value.logs = [logFor(block, 7), { ...logFor(block, 2, f.logs[1]), transactionHash: block.transactions[1], transactionIndex: '0x1' }];
  const rpc = await server(t, value); incomplete(await cli(args(rpc.url)), 'EVENT_LOG');
});

for (const [name, at, value, code] of [
  ['chain before', 1, '0x2', 'CHAIN_MISMATCH'], ['genesis before', 2, { ...f.genesis, hash: h(99) }, 'EVENT_GENESIS'],
  ['anchor missing', 3, null, 'BLOCK_UNAVAILABLE'], ['anchor height', 3, { ...f.blocks[3], number: '0x68' }, 'BRANCH_HEADERS'],
  ['anchor hash', 3, { ...f.blocks[3], hash: h(99) }, 'BRANCH_HEADERS'],
  ['non-genesis zero parent', 3, { ...f.blocks[3], parentHash: EMPTY }, 'BRANCH_HEADERS'],
  ['false genesis parent', 5, { ...f.blocks[2], parentHash: f.genesis.hash }, 'BRANCH_HEADERS'],
  ['malformed parent', 3, { ...f.blocks[3], parentHash: 'PRIVATE' }, 'RPC_DATA'],
  ['genesis parent', 2, { ...f.genesis, parentHash: h(99) }, 'RPC_DATA'],
  ['initial canonical', 4, { ...f.blocks[3], hash: h(99) }, 'BLOCK_NOT_CANONICAL'],
  ['parent link', 5, { ...f.blocks[2], hash: h(99) }, 'BRANCH_HEADERS'], ['parent height', 5, { ...f.blocks[2], number: '0x64' }, 'BRANCH_HEADERS'],
  ['lower boundary cycle', 7, { ...f.blocks[0], parentHash: f.blocks[3].hash }, 'BRANCH_HEADERS'],
  ['before page', 8, { ...f.blocks[3], hash: h(99) }, 'BLOCK_CHANGED'], ['after page', 10, { ...f.blocks[3], hash: h(99) }, 'BLOCK_CHANGED'],
  ['final lower block', 11, { ...f.blocks[0], hash: h(99) }, 'BLOCK_CHANGED'],
  ['final tx list', 12, { ...f.blocks[1], transactions: [h(99)] }, 'BLOCK_CHANGED'],
  ['final genesis', 15, { ...f.genesis, hash: h(99) }, 'GENESIS_CHANGED'], ['final chain', 16, '0x2', 'CHAIN_MISMATCH']
]) test(`branch and identity races: ${name}`, async t => {
  let count = 0; const rpc = await fakeRpc(t, r => ({ result: ++count === at ? value : answer(r) }));
  incomplete(await cli(args(rpc.url)), code); assert.equal(count, at);
});

test('reorg between pages invalidates already-read data; a later explicit run starts fresh', async t => {
  let count = 0;
  const rpc = await fakeRpc(t, r => {
    count++;
    if (count === 17) return { result: { ...f.blocks[3], hash: h(99) } };
    if (r.method === 'eth_getLogs' && r.params[0].fromBlock !== r.params[0].toBlock) return limit;
    return { result: answer(r) };
  });
  const first = incomplete(await cli(args(rpc.url)), 'BLOCK_CHANGED');
  assert.equal(first.coverage[0].status, 'read-unverified'); assert.equal(first.logs, null);
  const second = await cli(args(rpc.url)); assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).verification.requests, 34); assert.equal(count, 51);
});

for (const [kind, count] of [['received', 4], ['received', 5], ['unique', 2], ['unique', 3], ['page', 257]]) test(`log budgets: ${kind} ${count}`, async t => {
  const value = dataSet(kind === 'page' ? 1 : count);
  value.logs = value.blocks.flatMap(b => Array.from({ length: kind === 'page' ? 257 : 256 }, (_, i) => logFor(b, kind === 'received' ? 0 : i)));
  const rpc = await server(t, value, 1), d = await readEventRange(options(rpc.url, value));
  if (count === 5 || kind === 'unique' && count === 3 || kind === 'page') {
    assert.equal(d.status, 'incomplete'); assert.equal(d.logs, null); assert.equal(d.failure.code, kind === 'page' ? 'EVENT_LIMIT' : 'RANGE_LOGS');
  } else { assert.equal(d.status, 'complete'); assert.equal(d.logs.length, kind === 'received' ? 4 : 512); assert.ok(Buffer.byteLength(eventRangeJson(d)) <= RANGE_LIMITS.reportBytes); }
});

for (const [count, duplicate] of [[4096, false], [4097, false], [4, true]]) test(`aggregate transaction membership ${count}, duplicate ${duplicate}`, async t => {
  const value = dataSet(2), left = Math.floor(count / 2);
  value.blocks[0].transactions = Array.from({ length: left }, (_, i) => h(i + 1));
  value.blocks[1].transactions = Array.from({ length: count - left }, (_, i) => h(i + left + 1));
  if (duplicate) value.blocks[1].transactions[0] = value.blocks[0].transactions[0];
  const rpc = await server(t, value), d = await readEventRange(options(rpc.url, value));
  if (count === 4096) assert.equal(d.status, 'complete');
  else { assert.equal(d.status, 'incomplete'); assert.equal(d.failure.code, duplicate ? 'EVENT_BLOCK' : 'RANGE_TRANSACTIONS'); assert.ok(d.coverage.every(c => c.status === 'unread')); }
});

test('fixed request and byte accounting accept exact caps then refuse the next increment', () => {
  const budget = rangeBudget(63);
  for (let i = 0; i < 258; i++) budget.beforeRequest('eth_chainId');
  assert.throws(() => budget.beforeRequest('eth_chainId'), { code: 'RANGE_BUDGET' });
  budget.receiveBytes(16 * 1024 * 1024); assert.throws(() => budget.receiveBytes(1), { code: 'RANGE_BYTES' });
  const pages = rangeBudget(1); pages.beforeRequest('eth_getLogs'); assert.throws(() => pages.beforeRequest('eth_getLogs'), { code: 'RANGE_PAGES' });
});

test('serialized output accepts its exact byte cap and refuses one extra byte', () => {
  const overhead = Buffer.byteLength(eventRangeJson({ value: '' }));
  const value = 'x'.repeat(RANGE_LIMITS.reportBytes - overhead);
  assert.equal(Buffer.byteLength(eventRangeJson({ value })), RANGE_LIMITS.reportBytes);
  assert.throws(() => eventRangeJson({ value: value + 'x' }), { code: 'RANGE_REPORT' });
});

test('aggregate response byte limit closes the live request and suppresses all collected logs', async t => {
  const rpc = await fakeRpc(t, r => {
    if (r.method === 'eth_getLogs') return r.params[0].fromBlock === r.params[0].toBlock ? { result: answer(r) } : limit;
    const result = answer(r);
    return { result: typeof result === 'object' ? { ...result, ignored: 'x'.repeat(950000) } : result };
  });
  const result = await readEventRange(options(rpc.url));
  assert.equal(result.status, 'incomplete'); assert.equal(result.failure.code, 'RANGE_BYTES'); assert.equal(result.logs, null);
  assert.ok(result.verification.requests < 34); assert.ok(result.verification.responseBytes > RANGE_LIMITS.responseBytes);
});

for (const kind of ['http429', 'http503', 'body', 'headers', 'timeout', 'duplicate-json', 'utf8', 'nesting', 'envelope']) test(`transport refusal never splits: ${kind}`, async t => {
  const rpc = await fakeRpc(t, (r, res) => {
    if (r.method !== 'eth_getLogs') return { result: answer(r) };
    if (kind === 'timeout') return;
    if (kind.startsWith('http')) { res.writeHead(Number(kind.slice(4)), { 'retry-after': '0' }); res.end('PRIVATE secret'); return; }
    if (kind === 'body') { res.write(' '.repeat(262144)); res.end(' '); return; }
    if (kind === 'headers') { res.setHeader('X-Private', 'secret'.repeat(3000)); res.end('{}'); return; }
    if (kind === 'duplicate-json') { res.end(`{"jsonrpc":"2.0","id":${r.id},"error":{"code":-32000,"co\\u0064e":-32005,"message":"secret"}}`); return; }
    if (kind === 'utf8') { res.end(Buffer.from([0xff])); return; }
    if (kind === 'nesting') { res.end('{"a":'.repeat(7) + '0' + '}'.repeat(7)); return; }
    res.end('{"PRIVATE":true}');
  });
  const code = kind.startsWith('http') ? 'RPC_HTTP' : kind === 'body' ? 'EVENT_SIZE' : kind === 'headers' ? 'RPC_NETWORK' : kind === 'timeout' ? 'RPC_TIMEOUT' : 'RPC_ENVELOPE';
  const d = incomplete(await cli(args(rpc.url, ['--timeout-ms', '100'])), code); assert.equal(d.pages.length, 1); assert.equal(rpc.calls.length, 9);
});

test('deadline exhaustion between pages and during final validation never publishes checked data', async t => {
  for (const at of [10, 16]) {
    let now = 0, count = 0;
    const rpc = await fakeRpc(t, r => { if (++count === at) now = 101; return { result: answer(r) }; });
    const d = await readEventRange(options(rpc.url, f, { deadlineMs: '100' }), {}, { now: () => now });
    assert.equal(d.status, 'incomplete'); assert.equal(d.failure.code, 'CAPTURE_DEADLINE'); assert.equal(d.logs, null); assert.equal(count, at);
  }
});

test('explicit env reads once; invalid range, inherited env and aborted work cannot access RPC', async t => {
  const rpc = await server(t); let reads = 0;
  const env = { get PRIVATE() { reads++; return rpc.url; }, get CONTRACT_WATCH_RPC_URL() { assert.fail('default env'); } };
  const input = options(undefined, f, { rpcEnv: 'PRIVATE' });
  assert.equal((await readEventRange(input, env)).status, 'complete'); assert.equal(reads, 1);
  await assert.rejects(readEventRange(input, Object.create({ PRIVATE: rpc.url })), { code: 'CONFIG_ENV' });
  await assert.rejects(readEventRange({ ...input, toBlock: '132' }, env), { code: 'RANGE_INPUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readEventRange(input, env, { signal: controller.signal }), { code: 'CAPTURE_CANCELLED' });
  assert.equal(reads, 1); assert.equal(rpc.calls.length, 16);
});

for (const [from, to] of [['1', '0'], ['0', '32'], ['01', '2'], ['0x1', '2'], ['-1', '1'], ['1', '1e2'], ['0', (1n << 256n).toString()], ['', '1']]) test(`range input bounds ${from}/${to}`, () => {
  assert.throws(() => rangeBounds(from, to), { code: 'RANGE_INPUT' });
});
for (const extra of [['--block-hash', f.blocks[3].hash], ['--out', 'PRIVATE'], ['--json'], ['--retries', '1'], ['--config', 'PRIVATE'],
  ['--rpc-env', 'PRIVATE'], ['--from-block', '1'], ['--to-hash'], ['--topics', 'PRIVATE']]) test(`closed range CLI rejects ${extra[0]}`, async t => {
  const rpc = await server(t); invalid(await cli(args(rpc.url, extra)), 'USAGE'); assert.equal(rpc.calls.length, 0);
});
for (const value of ['0', '64', '01', '1.0']) test(`invalid explicit page budget ${value}`, async t => {
  const rpc = await server(t); invalid(await cli(args(rpc.url, ['--max-pages', value])), 'RANGE_INPUT'); assert.equal(rpc.calls.length, 0);
});

test('single-block method keeps RPC_REMOTE and its generic allowlist cannot issue arbitrary logs', async t => {
  const rpc = await fakeRpc(t, () => limit), client = createRpc(rpc.url);
  await assert.rejects(client.eip1967Logs(f.address, f.blocks[3].hash), { code: 'RPC_REMOTE' });
  await assert.rejects(client('eth_getLogs', []), { code: 'USAGE' });
  await assert.rejects(client.eip1967RangeLogs(f.address, '0x0', '0x20'), { code: 'RANGE_INPUT' });
  assert.equal(rpc.calls.length, 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) for (const at of [1, 9, 16]) test(`${signal} during range request ${at} drains with empty stdout`, async t => {
  const p = await store(t, [fixture()]); let ready, count = 0;
  const requested = new Promise(resolve => { ready = resolve; });
  const rpc = await fakeRpc(t, (r, res) => { if (++count === at) { if (at === 9) res.write('{"jsonrpc":'); ready(); return; } return { result: answer(r) }; });
  const before = await tree(p.parent), child = watchChild(t, args(rpc.url));
  await requested; child.p.kill(signal); const result = await child.result;
  assert.equal(result.code, signal === 'SIGINT' ? 130 : 143); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error \[CAPTURE_CANCELLED\]:/); assert.equal(count, at); assert.deepEqual(await tree(p.parent), before);
});

for (const point of ['between-pages', 'report']) test(`first signal wins at ${point} boundary without journal stdout`, async t => {
  const p = await store(t, [fixture()]), rpc = await server(t, f, point === 'between-pages' ? 1 : 32);
  // runLive turn, first page turn, then second-page or final-report turn.
  const preload = await watchPreload(p.parent, 'none', 1, `
let rangeTurns=0;
timers.setImmediate=async(...a)=>{if(++rangeTurns===3){process.send({point:'range-gate'});await new Promise(r=>process.once('message',r));}return immediate(...a);};
`);
  const before = await tree(p.directory), child = watchChild(t, args(rpc.url), { NODE_OPTIONS: `--import=${preload}` });
  await child.message(m => m.point === 'range-gate'); child.p.kill('SIGTERM'); await child.message(m => m.signal === 'SIGTERM');
  child.p.kill('SIGINT'); await child.message(m => m.signal === 'SIGINT'); child.p.send('resume');
  const result = await child.result;
  assert.equal(result.code, 143); assert.equal(result.stdout, '');
  assert.equal(rpc.calls.length, point === 'between-pages' ? 10 : 16); assert.deepEqual(await tree(p.directory), before);
});
