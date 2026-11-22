import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { crossCheckEvents, eventCheckJson } from '../src/event-check.js';
import { EVENTS, decodeEventLogs } from '../src/event-logs.js';
import { createRpc } from '../src/rpc.js';
import { keccak256 } from '../src/keccak.js';
import { fakeRpc, cli, EMPTY, word, fixture } from './helpers/fake-rpc.js';
import { store, tree, preserved } from './helpers/history-fixture.js';
import { watchChild, watchPreload } from './helpers/watch-child.js';

const f = JSON.parse(await fs.readFile(new URL('fixtures/events/block.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(f);
const h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const q = n => `0x${BigInt(n).toString(16)}`;
const addr = n => `0x${String(n).repeat(40)}`;
const options = (rpc, extra = {}) => ({ rpc, address: f.address, chainId: f.chainId,
  genesisHash: f.genesis.hash, blockHash: f.block.hash, ...extra });
const args = (rpc, extra = []) => ['events', '--rpc', rpc, '--address', f.address, '--chain-id', f.chainId,
  '--genesis-hash', f.genesis.hash, '--block-hash', f.block.hash, ...extra];
function answer(r, value = f) {
  if (r.method === 'eth_chainId') return q(value.chainId);
  if (r.method === 'eth_getBlockByHash') return value.block;
  if (r.method === 'eth_getBlockByNumber') return r.params[0] === '0x0' ? value.genesis : value.block;
  if (r.method === 'eth_getStorageAt') return value.slots[Object.keys(value.positions).find(k => value.positions[k] === r.params[1])];
  if (r.method === 'eth_getLogs') return value.logs;
  assert.fail('unexpected RPC method');
}
const server = (t, value = f) => fakeRpc(t, r => ({ result: answer(r, value) }));
function failure(r, code) {
  assert.equal(r.code, 1); assert.equal(r.stdout, '');
  assert.match(r.stderr, new RegExp(`^Error \\[${code}\\]: [^\\n]+\\n$`));
  assert.doesNotMatch(r.stderr, /PRIVATE|secret|127\.0\.0\.1|stack|\.json/);
}

test('independent ABI signatures and indexed layout fixtures cover all three events', () => {
  const signatures = ['Upgraded(address)', 'AdminChanged(address,address)', 'BeaconUpgraded(address)'];
  assert.deepEqual(EVENTS.map(e => e.topic), f.topics);
  assert.deepEqual(signatures.map(s => `0x${keccak256(Buffer.from(s))}`), f.topics);
  const logs = decodeEventLogs(f.logs, f.address, f.block);
  assert.deepEqual(logs.map(l => l.arguments), [{ implementation: addr(2) }, { previousAdmin: addr(0), newAdmin: addr(3) }, { beacon: addr(4) }]);
  assert.deepEqual(logs.map(l => l.valueWord), Object.values(f.slots));
  assert.deepEqual(logs.map(l => l.previousWord), [null, EMPTY, null]);
});

test('all three agreements, deterministic order, exact 11-request protocol and original files untouched', async t => {
  const value = clone(); value.logs.reverse();
  const rpc = await server(t, value), p = await store(t, [fixture()], { stages: ['PRIVATE incomplete'] });
  await fs.writeFile(join(p.parent, 'PRIVATE_user.json'), 'PRIVATE user bytes');
  const result = await preserved(p.parent, () => cli(args(rpc.url + '/secret')));
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const d = JSON.parse(result.stdout);
  assert.equal(d.kind, 'contract-watch-event-cross-check'); assert.equal(d.schemaVersion, 1);
  assert.equal(d.completeness, 'unverified'); assert.equal(d.storageState, 'end-of-block');
  assert.deepEqual(d.transactions, f.block.transactions); assert.deepEqual(d.logs.map(l => l.logIndex), ['0x0', '0x1', '0x2']);
  assert.deepEqual(Object.values(d.slots).map(s => s.raw), Object.values(f.slots));
  assert.deepEqual(d.comparisons, ['implementation', 'admin', 'beacon'].map((slot, i) => ({ slot,
    event: ['Upgraded', 'AdminChanged', 'BeaconUpgraded'][i], status: 'agreement', reason: 'LAST_RETURNED_VALUE_MATCHES', eventCount: 1,
    selectedLogIndex: q(i), selectedValueWord: f.slots[slot], earlierLogIndexes: [], adminSequenceGaps: [] })));
  assert.deepEqual(d.verification.before, d.verification.after); assert.equal(d.verification.requests, 11);
  assert.ok(Date.parse(d.verification.completedAt) >= Date.parse(d.verification.startedAt));
  assert.doesNotMatch(result.stdout, /secret|127\.0\.0\.1|PRIVATE/);
  const selector = { blockHash: f.block.hash, requireCanonical: true };
  assert.deepEqual(rpc.calls.map(r => [r.method, r.params]), [
    ['eth_chainId', []], ['eth_getBlockByNumber', ['0x0', false]], ['eth_getBlockByHash', [f.block.hash, false]],
    ['eth_getBlockByNumber', ['0x64', false]],
    ...Object.values(f.positions).map(position => ['eth_getStorageAt', [f.address, position, selector]]),
    ['eth_getLogs', [{ address: f.address, blockHash: f.block.hash, topics: [f.topics] }]],
    ['eth_getBlockByNumber', ['0x64', false]], ['eth_getBlockByNumber', ['0x0', false]], ['eth_chainId', []]
  ]);
  assert.deepEqual(rpc.calls.map(r => r.id), Array.from({ length: 11 }, (_, i) => i + 1));
});

for (const [name, raw, status, reason] of [
  ['different', word(addr(9)), 'disagreement', 'LAST_RETURNED_VALUE_DIFFERS'],
  ['empty', EMPTY, 'disagreement', 'LAST_RETURNED_VALUE_DIFFERS'],
  ['noncanonical', `0x01${'00'.repeat(31)}`, 'unavailable', 'NONCANONICAL_SLOT']
]) for (const slot of Object.keys(f.slots)) test(`${slot}: ${name} final storage`, async t => {
  const value = clone(); value.slots[slot] = raw; const rpc = await server(t, value);
  const d = await crossCheckEvents(options(rpc.url));
  assert.equal(d.slots[slot].raw, raw);
  assert.deepEqual(d.comparisons.filter(c => c.slot === slot).map(c => [c.status, c.reason]), [[status, reason]]);
});

test('empty and subset log responses produce unavailable, never unchanged or complete', async t => {
  for (const logs of [[], [f.logs[2]]]) {
    const value = clone(); value.logs = logs;
    const rpc = await server(t, value), d = await crossCheckEvents(options(rpc.url));
    assert.equal(d.completeness, 'unverified');
    assert.deepEqual(d.comparisons.map(c => c.status), logs.length ? ['unavailable', 'unavailable', 'agreement'] : Array(3).fill('unavailable'));
    assert.equal(d.comparisons[0].reason, 'NO_RETURNED_EVENT'); assert.equal(rpc.calls.length, 11);
  }
});

for (const slot of ['implementation', 'admin', 'beacon']) test(`multiple ${slot} events return to the starting emitted value; only final event is compared`, async t => {
  const value = clone(), source = value.logs[['implementation', 'admin', 'beacon'].indexOf(slot)];
  value.logs = [2, 8, 2].map((n, i) => ({ ...structuredClone(source), logIndex: q(i),
    transactionIndex: '0x0', transactionHash: value.block.transactions[0],
    topics: slot === 'admin' ? source.topics : [source.topics[0], word(addr(n))],
    data: slot === 'admin' ? word(addr(i === 0 ? 0 : i === 1 ? 2 : 8)) + word(addr(n)).slice(2) : '0x' }));
  value.slots[slot] = word(addr(2));
  value.logs.reverse();
  const rpc = await server(t, value), d = await crossCheckEvents(options(rpc.url));
  const comparison = d.comparisons.find(c => c.slot === slot);
  assert.equal(comparison.status, 'agreement'); assert.equal(comparison.selectedLogIndex, '0x2');
  assert.deepEqual(comparison.earlierLogIndexes, ['0x0', '0x1']); assert.equal(d.logs.length, 3);
  assert.deepEqual(d.logs.map(l => l.valueWord), [word(addr(2)), word(addr(8)), word(addr(2))]);
});

test('admin prior/new discontinuity is unavailable evidence even when final value matches', async t => {
  const value = clone(), last = structuredClone(value.logs[1]); last.logIndex = '0x3';
  last.transactionIndex = '0x2'; last.transactionHash = value.block.transactions[2];
  last.data = word(addr(8)) + word(addr(3)).slice(2); value.logs.push(last);
  const rpc = await server(t, value), d = await crossCheckEvents(options(rpc.url));
  assert.equal(d.comparisons[1].status, 'unavailable'); assert.equal(d.comparisons[1].reason, 'ADMIN_SEQUENCE_GAP');
  assert.deepEqual(d.comparisons[1].adminSequenceGaps, ['0x3']);
  assert.equal(d.comparisons[2].status, 'agreement');
});

test('zero ABI addresses are encoded values, not evidence of EIP conformance or code', async t => {
  const value = clone();
  for (const log of value.logs) { if (log.topics.length === 2) log.topics[1] = EMPTY; else log.data = EMPTY + EMPTY.slice(2); }
  for (const slot in value.slots) value.slots[slot] = EMPTY;
  const rpc = await server(t, value), d = await crossCheckEvents(options(rpc.url));
  assert.deepEqual(d.comparisons.map(c => c.status), Array(3).fill('agreement'));
  assert.ok(Object.values(d.slots).every(s => s.status === 'empty' && s.address === null));
});

const malformed = [
  ['wrong target', l => l.address = addr(9)], ['bad address', l => l.address = 'secret'],
  ['removed', l => l.removed = true], ['pending removed', l => l.removed = null], ['missing removed', l => delete l.removed],
  ['wrong block hash', l => l.blockHash = h(999)], ['wrong block number', l => l.blockNumber = '0x65'],
  ['pending hash', l => l.blockHash = null], ['short hash', l => l.blockHash = '0x12'],
  ['missing tx hash', l => delete l.transactionHash], ['zero tx hash', l => l.transactionHash = EMPTY],
  ['wrong tx hash', l => l.transactionHash = f.block.transactions[2]], ['wrong tx index', l => l.transactionIndex = '0x2'],
  ['pending tx index', l => l.transactionIndex = null], ['huge tx index', l => l.transactionIndex = '0x' + 'f'.repeat(64)],
  ['bad quantity', l => l.logIndex = '0x00'], ['pending index', l => l.logIndex = null], ['numeric index', l => l.logIndex = 1],
  ['overflow index', l => l.logIndex = '0x1' + '0'.repeat(64)], ['negative index', l => l.logIndex = '-1'],
  ['missing topics', l => delete l.topics], ['empty topics', l => l.topics = []], ['extra topic', l => l.topics.push(EMPTY)],
  ['wrong signature', l => l.topics[0] = h(555)], ['short topic', l => l.topics[1] = '0x01'],
  ['noncanonical address topic', l => l.topics[1] = '0x01' + '00'.repeat(31)], ['unexpected data', l => l.data = EMPTY],
  ['wrong timestamp', l => l.blockTimestamp = '0x1'], ['null timestamp', l => l.blockTimestamp = null],
  ['unknown property', l => l.PRIVATE = 'secret']
];
for (const [name, mutate] of malformed) test(`malformed or misbound log: ${name}`, async t => {
  const value = clone(); mutate(value.logs[0]); const rpc = await server(t, value);
  failure(await cli(args(rpc.url + '/secret')), 'EVENT_LOG'); assert.equal(rpc.calls.length, 8);
});

for (const [name, mutate] of [
  ['indexed admin', l => l.topics.push(EMPTY)], ['short admin data', l => l.data = EMPTY],
  ['extra admin data', l => l.data += '00'], ['bad previous word', l => l.data = '0x01' + l.data.slice(4)],
  ['bad new word', l => l.data = l.data.slice(0, 66) + '01' + l.data.slice(68)]
]) test(`AdminChanged ABI refusal: ${name}`, async t => {
  const value = clone(); mutate(value.logs[1]); const rpc = await server(t, value);
  failure(await cli(args(rpc.url)), 'EVENT_LOG'); assert.equal(rpc.calls.length, 8);
});

for (const kind of ['null', 'object', 'duplicate', 'conflicting-duplicate', 'transaction-order']) test(`contradictory log collection: ${kind}`, async t => {
  const value = clone();
  if (kind === 'null') value.logs = null;
  if (kind === 'object') value.logs = { logs: value.logs };
  if (kind.includes('duplicate')) { value.logs.push(structuredClone(value.logs[0])); if (kind.startsWith('conflicting')) value.logs.at(-1).topics[1] = EMPTY; }
  if (kind === 'transaction-order') value.logs[0].logIndex = '0x3';
  const rpc = await server(t, value); failure(await cli(args(rpc.url)), 'EVENT_LOG');
});

test('full uint256 chain/block/log quantities remain exact; hex addresses and topics normalize', async t => {
  const value = clone(), max = (1n << 256n) - 1n;
  value.chainId = max.toString(); value.block.number = q(max); value.logs = [value.logs[0]];
  value.logs[0].blockNumber = q(max); value.logs[0].logIndex = q(max);
  const upper = value => '0x' + value.slice(2).toUpperCase();
  value.logs[0].topics = value.logs[0].topics.map(upper); value.logs[0].blockHash = upper(value.logs[0].blockHash);
  const rpc = await server(t, value), d = await crossCheckEvents(options(rpc.url, { chainId: value.chainId }));
  assert.equal(d.chainId, value.chainId); assert.equal(d.block.number, q(max)); assert.equal(d.comparisons[0].selectedLogIndex, q(max));
});

for (const [kind, count] of [['logs', 256], ['logs', 257], ['transactions', 4096], ['transactions', 4097]]) test(`hard ${kind} boundary ${count}`, async t => {
  const value = clone();
  if (kind === 'logs') value.logs = Array.from({ length: count }, (_, i) => ({ ...value.logs[0], logIndex: q(i) }));
  else { value.block.transactions = Array.from({ length: count }, (_, i) => h(i + 1)); value.logs = []; }
  const rpc = await server(t, value);
  if (count === 257 || count === 4097) { await assert.rejects(crossCheckEvents(options(rpc.url)), { code: 'EVENT_LIMIT' }); assert.equal(rpc.calls.length, count === 257 ? 8 : 3); }
  else { const d = await crossCheckEvents(options(rpc.url)); assert.equal(d[kind].length, count); assert.equal(rpc.calls.length, 11); }
});

test('combined maximum retained data and uint256 widths fit the explicit report cap', async t => {
  const value = clone(), max = (1n << 256n) - 1n;
  value.chainId = max.toString(); value.block.number = value.block.timestamp = q(max);
  value.block.transactions = Array.from({ length: 4096 }, (_, i) => h(i + 1));
  value.logs = Array.from({ length: 256 }, (_, i) => ({ ...f.logs[1], blockNumber: q(max), blockTimestamp: q(max),
    logIndex: q(max - 255n + BigInt(i)), data: word(addr(3)) + word(addr(3)).slice(2) }));
  const rpc = await server(t, value), d = await crossCheckEvents(options(rpc.url, { chainId: value.chainId }));
  assert.equal(d.logs.length, 256); assert.equal(d.transactions.length, 4096);
  assert.ok(Buffer.byteLength(eventCheckJson(d)) <= d.limits.reportBytes); assert.equal(d.comparisons[1].status, 'agreement');
});

const races = [
  ['chain before', 1, '0x2', 'CHAIN_MISMATCH'], ['genesis before', 2, { ...f.genesis, hash: h(999) }, 'EVENT_GENESIS'],
  ['genesis wrong number', 2, { ...f.genesis, number: '0x1' }, 'RPC_DATA'],
  ['missing block', 3, null, 'BLOCK_UNAVAILABLE'], ['pending block', 3, { ...f.block, number: null }, 'RPC_DATA'],
  ['wrong hash', 3, { ...f.block, hash: h(999) }, 'RPC_DATA'], ['zero block', 3, { ...f.block, hash: EMPTY }, 'RPC_DATA'],
  ['missing transactions', 3, { ...f.block, transactions: undefined }, 'EVENT_BLOCK'],
  ['duplicate transactions', 3, { ...f.block, transactions: [h(1), h(1)] }, 'EVENT_BLOCK'],
  ['zero transaction', 3, { ...f.block, transactions: [EMPTY] }, 'EVENT_BLOCK'],
  ['transaction objects', 3, { ...f.block, transactions: [{}] }, 'RPC_DATA'],
  ['wrong genesis height', 3, { ...f.block, number: '0x0' }, 'EVENT_BLOCK'],
  ['canonical before', 4, { ...f.block, hash: h(999) }, 'BLOCK_NOT_CANONICAL'],
  ['inconsistent initial transaction list', 4, { ...f.block, transactions: [h(9)] }, 'BLOCK_NOT_CANONICAL'],
  ['missing storage', 5, null, 'RPC_DATA'], ['short storage', 6, '0x0', 'RPC_DATA'],
  ['canonical after', 9, { ...f.block, hash: h(999) }, 'BLOCK_CHANGED'],
  ['inconsistent final transactions', 9, { ...f.block, transactions: [h(9)] }, 'BLOCK_CHANGED'],
  ['inconsistent final timestamp', 9, { ...f.block, timestamp: '0x1' }, 'BLOCK_CHANGED'],
  ['genesis after', 10, { ...f.genesis, hash: h(999) }, 'GENESIS_CHANGED'], ['chain after', 11, '0x2', 'CHAIN_MISMATCH']
];
for (const [name, at, value, code] of races) test(`identity/state binding refusal: ${name}`, async t => {
  let count = 0; const rpc = await fakeRpc(t, r => ({ result: ++count === at ? value : answer(r) }));
  failure(await cli(args(rpc.url + '/secret')), code); assert.equal(count, at);
});

test('explicit genesis block can be checked with an empty transaction list and unavailable events', async t => {
  const value = clone(); value.block = { ...value.block, ...value.genesis, transactions: [] }; value.genesis = value.block; value.logs = [];
  const rpc = await server(t, value), d = await crossCheckEvents(options(rpc.url, { blockHash: value.genesis.hash }));
  assert.equal(d.block.number, '0x0'); assert.equal(rpc.calls.length, 11); assert.ok(d.comparisons.every(c => c.status === 'unavailable'));
});

for (const at of [5, 8]) test(`unsupported pin or provider limit at request ${at} never causes fallback/pagination`, async t => {
  let count = 0; const rpc = await fakeRpc(t, r => ++count === at ? { error: { code: -32005, message: 'PRIVATE secret unsupported or limit' } } : { result: answer(r) });
  failure(await cli(args(rpc.url)), 'RPC_REMOTE'); assert.equal(count, at);
});

for (const kind of ['body-length', 'stream-body', 'headers', 'timeout', 'http', 'redirect', 'encoding', 'duplicate-key', 'invalid-utf8', 'bom', 'nesting']) test(`bounded log transport: ${kind}`, async t => {
  const rpc = await fakeRpc(t, (r, res) => {
    if (r.method !== 'eth_getLogs') return { result: answer(r) };
    if (kind === 'timeout') return;
    if (kind === 'http' || kind === 'redirect') { res.writeHead(kind === 'http' ? 429 : 302, { Location: '/secret' }); res.end('secret'); return; }
    if (kind === 'body-length') { res.writeHead(200, { 'content-length': 262145 }); res.end(); return; }
    if (kind === 'stream-body') { res.write(' '.repeat(262144)); res.end(' '); return; }
    if (kind === 'headers') { res.setHeader('X-Private', 'secret'.repeat(3000)); res.end('{}'); return; }
    if (kind === 'encoding') { res.setHeader('content-encoding', 'gzip'); res.end('secret'); return; }
    if (kind === 'duplicate-key') { res.end(`{"jsonrpc":"2.0","id":${r.id},"result":null,"resu\\u006ct":[]}`); return; }
    if (kind === 'invalid-utf8') { res.end(Buffer.from([0xff])); return; }
    if (kind === 'bom') { res.end('\uFEFF' + JSON.stringify({ jsonrpc: '2.0', id: r.id, result: [] })); return; }
    res.end('{"a":'.repeat(7) + '0' + '}'.repeat(7));
  });
  const code = kind.includes('body') ? 'EVENT_SIZE' : kind === 'headers' ? 'RPC_NETWORK' : kind === 'timeout' ? 'RPC_TIMEOUT'
    : ['http', 'redirect'].includes(kind) ? 'RPC_HTTP' : kind === 'encoding' ? 'RPC_ENCODING' : 'RPC_ENVELOPE';
  failure(await cli(args(rpc.url, ['--timeout-ms', '100'])), code); assert.equal(rpc.calls.length, 8);
});

test('generic RPC still refuses getLogs; restricted method validates its own inputs', async t => {
  const rpc = await server(t), client = createRpc(rpc.url);
  await assert.rejects(client('eth_getLogs', []), { code: 'USAGE' });
  await assert.rejects(client.eip1967Logs('secret', f.block.hash), { code: 'ADDRESS' });
  await assert.rejects(client.eip1967Logs(f.address, 'latest'), { code: 'BLOCK_HASH' }); assert.equal(rpc.calls.length, 0);
});

test('active monotonic deadline includes final validation and closes a stalled request', async t => {
  let now = 0, count = 0;
  const rpc = await fakeRpc(t, r => { if (++count === 11) now = 1000; return { result: answer(r) }; });
  await assert.rejects(crossCheckEvents(options(rpc.url, { deadlineMs: '100' }), {}, { now: () => now }), { code: 'CAPTURE_DEADLINE' });
  assert.equal(count, 11);
  const stalled = await fakeRpc(t, () => undefined);
  failure(await cli(args(stalled.url, ['--deadline-ms', '100'])), 'CAPTURE_DEADLINE'); assert.equal(stalled.calls.length, 1);
});

test('explicit environment resolution is once, own-property only and after all validation', async t => {
  const rpc = await server(t); let reads = 0;
  const environment = { get PRIVATE() { reads++; return rpc.url; }, get CONTRACT_WATCH_RPC_URL() { assert.fail('implicit env'); } };
  await crossCheckEvents(options(undefined, { rpcEnv: 'PRIVATE' }), environment); assert.equal(reads, 1);
  await assert.rejects(crossCheckEvents(options(undefined, { rpcEnv: 'PRIVATE' }), Object.create({ PRIVATE: rpc.url })), { code: 'CONFIG_ENV' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(crossCheckEvents(options(undefined, { rpcEnv: 'PRIVATE' }), environment, { signal: controller.signal }), { code: 'CAPTURE_CANCELLED' });
  assert.equal(reads, 1); assert.equal(rpc.calls.length, 11);
});

for (const [key, values, code] of [
  ['address', ['', 'PRIVATE', null], 'ADDRESS'], ['chainId', ['0', '01', '0x' + 'f'.repeat(65)], 'CHAIN_ID'],
  ['genesisHash', [undefined, EMPTY, 'latest'], 'BLOCK_HASH'], ['blockHash', [undefined, EMPTY, 'latest'], 'BLOCK_HASH'],
  ['rpcEnv', ['lower', 'A'.repeat(65), 'PRIVATE-X'], 'USAGE'], ['timeoutMs', ['99', '60001', '0100'], 'TIMEOUT_OPTION'],
  ['deadlineMs', ['99', '600001', '0100'], 'DEADLINE_OPTION']
]) for (const value of values) test(`input ${key} refused before env: ${String(value).slice(0, 10)}`, async () => {
  let reads = 0;
  await assert.rejects(crossCheckEvents(options(undefined, { rpcEnv: 'PRIVATE', [key]: value }),
    { get PRIVATE() { reads++; throw Error('secret'); } }), { code }); assert.equal(reads, 0);
});

for (const extra of [['--json'], ['--out', 'PRIVATE'], ['--from-block', '1'], ['--to-block', '2'], ['--retries', '1'],
  ['--config', 'PRIVATE'], ['--dir', 'PRIVATE'], ['--rpc-env', 'PRIVATE'], ['--block-hash', f.block.hash], ['--address']]) test(`closed CLI rejects ${extra[0]}`, async t => {
  const rpc = await server(t); failure(await cli(args(rpc.url, extra)), 'USAGE'); assert.equal(rpc.calls.length, 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) for (const at of [1, 8, 11]) test(`${signal} at request ${at}: drain, empty stdout, source files preserved`, async t => {
  const p = await store(t, [fixture()]); let ready, count = 0;
  const requested = new Promise(resolve => { ready = resolve; });
  const rpc = await fakeRpc(t, (r, res) => { if (++count === at) { if (at === 8) res.write('{"jsonrpc":'); ready(); return; } return { result: answer(r) }; });
  const before = await tree(p.parent), child = watchChild(t, args(rpc.url));
  await requested; child.p.kill(signal); const result = await child.result;
  assert.equal(result.code, signal === 'SIGINT' ? 130 : 143); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Error \[CAPTURE_CANCELLED\]:/); assert.equal(count, at); assert.deepEqual(await tree(p.parent), before);
});

test('first signal wins at the report boundary after every RPC has completed', async t => {
  const p = await store(t, [fixture()]), rpc = await server(t);
  const preload = await watchPreload(p.parent, 'none', 1, `
let eventTurns=0;
timers.setImmediate=async(...a)=>{if(++eventTurns===2){process.send({point:'event-report'});await new Promise(r=>process.once('message',r));}return immediate(...a);};
`);
  const before = await tree(p.directory), child = watchChild(t, args(rpc.url), { NODE_OPTIONS: `--import=${preload}` });
  await child.message(m => m.point === 'event-report'); child.p.kill('SIGTERM'); await child.message(m => m.signal === 'SIGTERM');
  child.p.kill('SIGINT'); await child.message(m => m.signal === 'SIGINT'); child.p.send('resume');
  const result = await child.result;
  assert.equal(result.code, 143); assert.equal(result.stdout, ''); assert.equal(rpc.calls.length, 11);
  assert.deepEqual(await tree(p.directory), before);
});
