import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRpc } from '../src/rpc.js';
import { CAPTURE_POLICY, createCapturePolicy } from '../src/capture-policy.js';
import { retryOptions } from '../src/validate.js';
import { WatchError } from '../src/errors.js';
import { capture, captureWithBeacon, captureWithImplementation, resolveCaptureAnchor, captureAtAnchor, readSnapshot, SLOTS } from '../src/snapshot.js';
import { captureMany } from '../src/batch.js';
import { configuredCapture, validateConfig } from '../src/config.js';
import { cli, fakeRpc, temporaryDirectory, protocolResult, ADDRESS, HASH, EMPTY, IMPLEMENTATION, word } from './helpers/fake-rpc.js';

const GENESIS = `0x${'c1'.repeat(32)}`, OTHER = `0x${'d2'.repeat(32)}`;
const BEACON = `0x${'33'.repeat(20)}`;
const input = { address: ADDRESS, chainId: '1' };
const stripTime = snapshot => ({ ...snapshot, capturedAt: 'fixed' });
const trace = calls => calls.map(({ method, params }) => ({ method, params }));
const safe = value => assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|https?:|rpcEnv|Retry-After|at Object/);
function clock(options = { retries: 3, deadlineMs: 10000 }) {
  let time = 0; const waits = [];
  const policy = createCapturePolicy(options, { now: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  return { policy, waits, advance: ms => { time += ms; } };
}
function track(t, limit = 1) {
  const original = http.request, state = { active: 0, peak: 0, opened: 0, closed: 0 };
  t.mock.method(http, 'request', (...args) => {
    assert.ok(state.active < limit, 'previous transport must close before next attempt');
    const request = original(...args); state.active++; state.opened++; state.peak = Math.max(state.peak, state.active);
    request.once('close', () => { state.active--; state.closed++; }); return request;
  });
  return state;
}
const entry = i => ({ name: `private-${i}`, address: ADDRESS, chainId: '1', rpcEnv: `PRIVATE_RPC_${i}` });
async function setup(t, count = 3) {
  const dir = await temporaryDirectory(t), configPath = join(dir, 'config.json'), outputDir = join(dir, 'batch');
  const targets = Array.from({ length: count }, (_, i) => entry(i + 1));
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, targets }));
  return { dir, configPath, outputDir, names: targets.map(target => target.name) };
}
const batchArgs = p => ['snapshot-many', '--config', p.configPath, ...p.names.flatMap(n => ['--target', n]), '--out-dir', p.outputDir];
const singleArgs = p => ['snapshot', '--address', ADDRESS, '--chain-id', '1', '--out', join(p, 'new.json')];
function result(r, { beacon = false } = {}) {
  if (r.method === 'eth_getBlockByNumber') {
    const selector = r.params[0];
    return { number: selector.startsWith('0x') ? selector : '0x64', hash: selector === '0x0' ? GENESIS : HASH };
  }
  if (r.method === 'eth_getStorageAt' && beacon) return r.params[1] === SLOTS.beacon ? word(BEACON) : EMPTY;
  if (r.method === 'eth_call') return word(IMPLEMENTATION);
  return protocolResult(r);
}

test('canonical retry/deadline syntax and pairing, including explicit zero', () => {
  for (const retries of [0, 1, 2, 3, '0', '1', '2', '3']) {
    assert.equal(retryOptions({ retries, deadlineMs: 100 }).retries, Number(retries));
  }
  for (const retries of ['', '-1', '+1', '01', '4', '1.0', '1e0', ' 1', '1 ', '１', '\n1', null, true, NaN]) {
    assert.throws(() => retryOptions({ retries, deadlineMs: 100 }), { code: 'RETRIES_OPTION' });
  }
  for (const deadlineMs of ['', '0', '99', '600001', '0100', '+100', '1e3', '100.0', ' 100', '100 ', '１００', null, true, Infinity]) {
    assert.throws(() => retryOptions({ deadlineMs }), { code: 'DEADLINE_OPTION' });
  }
  for (const deadlineMs of [100, 600000, '100', '600000']) assert.equal(retryOptions({ deadlineMs }).deadlineMs, Number(deadlineMs));
  assert.throws(() => retryOptions({ retries: 1 }), { code: 'RETRIES_DEADLINE' });
  assert.deepEqual(retryOptions({ retries: 0 }), { retries: 0, deadlineMs: undefined });
});

test('invalid CLI options fail before config/env/RPC/output and offline commands reject them', async t => {
  const paths = await setup(t); const fake = await fakeRpc(t);
  for (const flags of [ ['--retries'], ['--deadline-ms'], ['--retries', '1'], ['--retries', '01', '--deadline-ms', '100'],
    ['--retries', '4', '--deadline-ms', '100'], ['--deadline-ms', '099'], ['--deadline-ms', '600001'],
    ['--retries', '0', '--retries', '0'], ['--deadline-ms', '100', '--deadline-ms', '100'],
    ['--retries=0'], ['--deadline-ms=100'], ['--retries', '0', '--block', 'latest', '--depth', '0'] ]) {
    for (const args of [singleArgs(paths.dir), ['snapshot', '--config', '/PRIVATE_MISSING', '--target', 'private-1', '--out', join(paths.dir, 'new.json')],
      ['snapshot-many', '--config', '/PRIVATE_MISSING', '--target', 'private-1', '--out-dir', paths.outputDir]]) {
      const value = await cli([...args, ...flags], { CONTRACT_WATCH_RPC_URL: fake.url });
      assert.equal(value.code, 1); assert.equal(value.stdout, ''); safe(value.stderr);
      assert.doesNotMatch(value.stderr, /CONFIG_READ|CONFIG_ENV|RPC_URL/);
    }
  }
  for (const args of [['inspect', 'examples/before.json'], ['diff', 'examples/before.json', 'examples/after.json'],
    ['migrate', 'examples/before.json', '--to-version', '3', '--out', join(paths.dir, 'migrated.json')]]) {
    for (const flags of [['--retries', '0'], ['--deadline-ms', '100']]) {
      const value = await cli([...args, ...flags]); assert.equal(value.code, 1); assert.match(value.stderr, /USAGE/);
    }
  }
  assert.equal(fake.calls.length, 0); assert.deepEqual(await fs.readdir(paths.dir), ['config.json']);
  const environment = new Proxy({}, { get() { assert.fail('env must not be read'); }, getOwnPropertyDescriptor() { assert.fail('env must not be checked'); } });
  await assert.rejects(configuredCapture(paths.configPath, 'private-1', { retries: 1 }, environment), { code: 'RETRIES_DEADLINE' });
  await assert.rejects(captureMany({ ...paths, options: { deadlineMs: '0100' } }, environment), { code: 'DEADLINE_OPTION' });
  for (const field of ['retries', 'deadlineMs', 'deadline-ms']) {
    for (const root of [true, false]) {
      const config = { schemaVersion: 1, targets: [entry(1)] }; (root ? config : config.targets[0])[field] = 1;
      assert.throws(() => validateConfig(config), { code: 'CONFIG' });
    }
  }
});

test('fake monotonic clock bounds all attempts/delays, exhaustion and deadline priority', async t => {
  for (const retries of [0, 1, 2, 3]) await t.test(`exhaust ${retries}`, async () => {
    const c = clock({ retries, deadlineMs: 10000 }), seen = [], failure = new WatchError('RPC_NETWORK');
    await assert.rejects(c.policy.read(async (limit, deadlineLimited) => {
      seen.push([limit, deadlineLimited]); c.advance(20); throw failure;
    }, 100, () => true), error => error === failure);
    assert.equal(seen.length, retries + 1); assert.deepEqual(c.waits, [100, 200, 400].slice(0, retries));
    assert.ok(seen.every(([limit, bounded]) => limit === 100 && !bounded));
  });
  const c = clock({ retries: 3, deadlineMs: 150 }); let attempts = 0;
  await assert.rejects(c.policy.read(async limit => {
    attempts++; assert.equal(limit, 150); c.advance(70); throw new WatchError('RPC_HTTP');
  }, 1000, () => true), { code: 'CAPTURE_DEADLINE' });
  assert.equal(attempts, 1); assert.deepEqual(c.waits, [80]);
  for (const failure of [false, true]) {
    const c = clock({ retries: 0, deadlineMs: 100 });
    await assert.rejects(c.policy.read(async () => { c.advance(100); if (failure) throw new WatchError('RPC_REMOTE'); return 'late'; }, 100, () => false), { code: 'CAPTURE_DEADLINE' });
  }
  const before = clock({ deadlineMs: 100 }); before.advance(100);
  await assert.rejects(before.policy.read(() => assert.fail('must not start'), 1000, () => true), { code: 'CAPTURE_DEADLINE' });
  const validation = clock({ deadlineMs: 100 });
  await assert.rejects(validation.policy.guard(async () => { validation.advance(100); throw new WatchError('RPC_DATA'); }), { code: 'CAPTURE_DEADLINE' });
});

test('only transport/timeouts and 502/503/504 recover; close precedes delay and next unique-ID attempt', async t => {
  for (const kind of [502, 503, 504, 'reset', 'body-abort', 'timeout']) await t.test(String(kind), async t => {
    const state = track(t), c = clock({ retries: 3, deadlineMs: 10000 }); let count = 0;
    const fake = await fakeRpc(t, (r, res) => {
      if (++count < 4) {
        if (typeof kind === 'number') { res.writeHead(kind, { 'Retry-After': '99999' }); res.end('PRIVATE_FAILURE'); }
        else if (kind === 'reset') res.destroy();
        else if (kind === 'body-abort') { res.writeHead(200, { 'content-length': 400 }); res.write('{'); setImmediate(() => res.destroy()); }
        return;
      }
      return { result: protocolResult(r) };
    });
    const read = c.policy.read.bind(c.policy);
    c.policy.read = (attempt, limit, retryable) => read(attempt, limit, error => { assert.equal(state.active, 0); return retryable(error); });
    const rpc = createRpc(fake.url, 100, c.policy);
    assert.equal(await rpc('eth_getCode', [ADDRESS, { blockHash: HASH, requireCanonical: true }]), '0x60006000');
    assert.deepEqual(fake.calls.map(r => r.id), [1, 2, 3, 4]);
    assert.ok(trace(fake.calls).every(r => JSON.stringify(r) === JSON.stringify(trace(fake.calls)[0])));
    assert.deepEqual(c.waits, [100, 200, 400]); assert.equal(state.active, 0); assert.equal(state.opened, state.closed);
  });
});

test('retry exhaustion preserves safe original error and never adds attempts', async t => {
  for (const retries of [0, 1, 2, 3]) await t.test(String(retries), async t => {
    const c = clock({ retries, deadlineMs: 10000 });
    const fake = await fakeRpc(t, (r, res) => { res.writeHead(503); res.end('PRIVATE_PROVIDER'); });
    await assert.rejects(createRpc(fake.url, 100, c.policy)('eth_chainId'), { code: 'RPC_HTTP' });
    assert.equal(fake.calls.length, retries + 1); assert.deepEqual(c.waits, [100, 200, 400].slice(0, retries));
  });
});

test('permanent HTTP, headers, encoding, size, envelope and JSON-RPC errors never retry', async t => {
  const cases = [
    ...[201, 204, 301, 302, 307, 400, 401, 403, 404, 408, 500, 501, 505].map(status => [String(status), 'RPC_HTTP', (r, res) => { res.writeHead(status, { location: 'http://PRIVATE_REDIRECT', 'Retry-After': '0' }); res.end(); }]),
    ['encoding', 'RPC_ENCODING', (r, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('PRIVATE_BODY'); }],
    ['declared size', 'RPC_SIZE', (r, res) => { res.writeHead(200, { 'content-length': 1048577 }); res.end(); }],
    ['stream size', 'RPC_SIZE', (r, res) => { res.writeHead(200); res.end('x'.repeat(1048577)); }],
    ['headers', 'RPC_NETWORK', (r, res) => { res.writeHead(200, { 'x-private': 'x'.repeat(17000) }); res.end(); }],
    ['json', 'RPC_ENVELOPE', (r, res) => { res.end('PRIVATE_NOT_JSON'); }],
    ['id', 'RPC_ENVELOPE', r => ({ id: r.id + 1, result: '0x1' })],
    ['version', 'RPC_ENVELOPE', () => ({ jsonrpc: '1.0', result: '0x1' })],
    ['both', 'RPC_ENVELOPE', () => ({ error: { message: 'PRIVATE' }, result: '0x1' })],
    ['neither', 'RPC_ENVELOPE', () => ({})],
    ['remote', 'RPC_REMOTE', () => ({ error: { code: -32000, message: 'PRIVATE' } })]
  ];
  for (const [name, code, respond] of cases) await t.test(name, async t => {
    const c = clock(), fake = await fakeRpc(t, respond), state = track(t);
    await assert.rejects(createRpc(fake.url, 1000, c.policy)('eth_chainId'), { code });
    assert.equal(fake.calls.length, 1); assert.deepEqual(c.waits, []); assert.equal(state.active, 0);
  });
});

test('null/malformed results and chain/block/canonical/genesis disagreements never retry', async t => {
  const cases = [
    ['chain', {}, 'eth_chainId', () => '0x2', 'CHAIN_MISMATCH'],
    ['quantity', {}, 'eth_chainId', () => '0x01', 'RPC_DATA'],
    ['null', {}, 'eth_getBlockByNumber', () => null, 'BLOCK_UNAVAILABLE'],
    ['header', {}, 'eth_getBlockByNumber', () => ({ number: '0x64' }), 'RPC_DATA'],
    ['code', {}, 'eth_getCode', () => '0xzz', 'RPC_DATA'],
    ['storage', {}, 'eth_getStorageAt', () => '0x', 'RPC_DATA'],
    ['canonical', { blockHash: HASH }, 'eth_getBlockByNumber', () => ({ number: '0x64', hash: OTHER }), 'BLOCK_NOT_CANONICAL'],
    ['genesis', { genesis: true }, 'eth_getBlockByNumber', r => r.params[0] === '0x0' ? ({ number: '0x0', hash: EMPTY }) : result(r), 'RPC_DATA']
  ];
  for (const [name, options, method, value, code] of cases) await t.test(name, async t => {
    const c = clock(), fake = await fakeRpc(t, r => ({ result: r.method === method ? value(r) : result(r) }));
    await assert.rejects(capture({ ...input, ...options, rpcUrl: fake.url, [CAPTURE_POLICY]: c.policy }), { code });
    assert.deepEqual(c.waits, []); assert.equal(fake.calls.filter(r => r.method === method).length, 1);
  });
});

test('all selectors, genesis and implementation/beacon modes retry reads at the original pin; zero/default traces match', async t => {
  const selectors = [{}, { block: 'safe' }, { block: 'finalized' }, { block: '100' }, { block: '0x64' }, { blockHash: HASH }, { depth: '0' }, { depth: '1' }];
  for (const selector of selectors) for (const genesis of [false, true]) for (const mode of ['plain', 'beacon', 'implementation-direct', 'implementation-beacon']) {
    await t.test(`${JSON.stringify(selector)}/${genesis}/${mode}`, async t => {
      const engine = mode === 'beacon' ? captureWithBeacon : mode.startsWith('implementation') ? captureWithImplementation : capture;
      const beacon = mode.includes('beacon'), getSnapshot = value => value.snapshot ?? value;
      const ordinary = await fakeRpc(t, r => ({ result: result(r, { beacon }) }));
      const options = { ...input, ...selector, genesis, rpcUrl: ordinary.url };
      const baseline = getSnapshot(await engine(options)); const initial = [...ordinary.calls]; ordinary.calls.length = 0;
      const zero = getSnapshot(await engine({ ...options, retries: 0 }));
      assert.deepEqual(stripTime(zero), stripTime(baseline)); assert.deepEqual(ordinary.calls, initial);
      const failed = new Set(), c = clock({ retries: 1, deadlineMs: 600000 });
      const retrying = await fakeRpc(t, (r, res) => {
        const key = JSON.stringify([r.method, r.params]);
        if (!failed.has(key)) { failed.add(key); res.writeHead(502); res.end(); return; }
        return { result: result(r, { beacon }) };
      });
      const recovered = getSnapshot(await engine({ ...options, rpcUrl: retrying.url, [CAPTURE_POLICY]: c.policy }));
      assert.deepEqual(stripTime(recovered), stripTime(baseline));
      assert.equal(retrying.calls.length, initial.length + failed.size);
      assert.deepEqual(retrying.calls.map(r => r.id), Array.from({ length: retrying.calls.length }, (_, i) => i + 1));
      assert.ok(retrying.calls.filter(r => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(r.method)).every(r =>
        r.params.at(-1).blockHash === HASH && r.params.at(-1).requireCanonical === true));
      assert.equal(retrying.calls.filter(r => r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest').length,
        selector.depth !== undefined || Object.keys(selector).length === 0 ? 2 : 0);
    });
  }
});

test('retry after pin never re-reads latest/genesis; final reorg/identity changes abort', async t => {
  for (const change of ['head-only', 'reorg', 'genesis', 'chain']) await t.test(change, async t => {
    let codeReads = 0, latest = 0, genesis = 0, chain = 0; const c = clock();
    const fake = await fakeRpc(t, (r, res) => {
      if (r.method === 'eth_getCode' && ++codeReads === 1) { res.destroy(); return; }
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') { latest++; return { result: { number: '0x65', hash: OTHER } }; }
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0' && ++genesis === 2 && change === 'genesis') return { result: { number: '0x0', hash: OTHER } };
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x64' && codeReads > 0 && change === 'reorg') return { result: { number: '0x64', hash: OTHER } };
      if (r.method === 'eth_chainId' && ++chain === 2 && change === 'chain') return { result: '0x2' };
      return { result: result(r) };
    });
    const work = capture({ ...input, rpcUrl: fake.url, depth: '1', genesis: true, [CAPTURE_POLICY]: c.policy });
    if (change === 'head-only') assert.equal((await work).block.hash, HASH);
    else await assert.rejects(work, { code: { reorg: 'BLOCK_CHANGED', genesis: 'GENESIS_CHANGED', chain: 'CHAIN_MISMATCH' }[change] });
    assert.equal(latest, 1); assert.equal(codeReads, 2); assert.deepEqual(c.waits, [100]);
    assert.ok(fake.calls.filter(r => r.method === 'eth_getCode').every(r => r.params[1].blockHash === HASH));
  });
});

test('beacon attempt retains gas/body/time caps, and invalid ABI/oversize never retries', async t => {
  for (const mode of ['success', 'abi', 'size']) await t.test(mode, async t => {
    const c = clock({ retries: 1, deadlineMs: 6000 }), limits = [], read = c.policy.read.bind(c.policy);
    c.policy.read = (attempt, timeout, retryable) => read((limit, bounded) => { limits.push({ timeout, limit }); return attempt(limit, bounded); }, timeout, retryable);
    const fake = await fakeRpc(t, (r, res) => {
      if (r.method === 'eth_call') {
        assert.deepEqual(r.params, [{ from: ADDRESS, to: BEACON, gas: '0x186a0', value: '0x0', input: '0x5c60da1b' }, { blockHash: HASH, requireCanonical: true }]);
        if (mode === 'size') { res.end('x'.repeat(4097)); return; }
        if (mode === 'abi') return { result: EMPTY };
      }
      return { result: result(r, { beacon: true }) };
    });
    c.advance(2000);
    const work = captureWithBeacon({ ...input, rpcUrl: fake.url, timeoutMs: 60000, [CAPTURE_POLICY]: c.policy });
    if (mode === 'success') await work; else await assert.rejects(work, { code: mode === 'abi' ? 'BEACON_RESULT' : 'BEACON_SIZE' });
    assert.equal(limits.filter(l => l.timeout === 5000).length, 1); assert.ok(limits.every(l => l.limit <= 4000));
    assert.deepEqual(c.waits, []);
  });
});

test('deadline closes stalled response, prevents later reads and never writes a partial single file', async t => {
  const dir = await temporaryDirectory(t), fake = await fakeRpc(t, (r, res) => { res.writeHead(200); res.write('{'); });
  const value = await cli([...singleArgs(dir), '--rpc', fake.url, '--retries', '3', '--deadline-ms', '100', '--timeout-ms', '5000']);
  assert.equal(value.code, 1); assert.equal(value.stdout, ''); assert.match(value.stderr, /CAPTURE_DEADLINE/); safe(value.stderr);
  assert.equal(fake.calls.length, 1); assert.deepEqual(await fs.readdir(dir), []);
  const state = track(t);
  await assert.rejects(capture({ ...input, rpcUrl: fake.url, deadlineMs: 100 }), { code: 'CAPTURE_DEADLINE' });
  assert.equal(state.active, 0); assert.equal(state.opened, state.closed);
});

test('one monotonic budget covers successive reads, resolver to capture, and validation before return', async t => {
  for (const phase of ['between', 'resolver', 'final-validation']) await t.test(phase, async t => {
    const c = clock({ deadlineMs: 100 }); let seen = 0;
    const fake = await fakeRpc(t, r => {
      seen++;
      if (phase === 'between') c.advance(60);
      if (phase === 'resolver') c.advance(30);
      if (phase === 'final-validation' && seen === 8) c.advance(100);
      return { result: protocolResult(r) };
    });
    const options = { ...input, rpcUrl: fake.url, [CAPTURE_POLICY]: c.policy };
    if (phase === 'resolver') {
      const anchor = await resolveCaptureAnchor(options);
      await assert.rejects(captureAtAnchor(options, anchor), { code: 'CAPTURE_DEADLINE' });
      assert.equal(seen, 4); assert.deepEqual(fake.calls.map(r => r.id), [1, 2, 3, 4]);
    } else {
      await assert.rejects(capture(options), { code: 'CAPTURE_DEADLINE' });
      assert.equal(seen, phase === 'between' ? 2 : 8);
    }
    const count = fake.calls.length;
    await assert.rejects(capture(options), { code: 'CAPTURE_DEADLINE' }); assert.equal(fake.calls.length, count);
  });
});

test('shared leader budget does not reset; follower starts after anchor wait and retains partial success', async t => {
  const paths = await setup(t, 2), state = track(t, 2); let latest = 0;
  const fake = await fakeRpc(t, async (r, res, req) => {
    if (req.url === '/1' && r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') { latest++; await sleep(650); }
    if (req.url === '/1' && r.method === 'eth_getCode') await sleep(650);
    if (res.destroyed) return;
    return { result: protocolResult(r) };
  });
  const value = await captureMany({ ...paths, sharedBlock: true, concurrency: 2, options: { deadlineMs: 1000, retries: 1 } },
    { PRIVATE_RPC_1: `${fake.url}/1`, PRIVATE_RPC_2: `${fake.url}/2` });
  assert.equal(value.saved, 1); assert.equal(value.outcomes[0].error.code, 'CAPTURE_DEADLINE');
  assert.equal(value.outcomes[1].status, 'saved'); assert.equal(value.groups[0].status, 'resolved'); assert.equal(latest, 1);
  assert.equal(state.active, 0); assert.equal(state.opened, state.closed); assert.equal(state.peak, 2);
  assert.deepEqual(await fs.readdir(paths.outputDir), ['target-02.json']); safe(value);
  const file = join(paths.outputDir, 'target-02.json'); await readSnapshot(file);
  assert.equal((await cli(['inspect', file])).code, 0); assert.equal((await cli(['diff', '--json', file, file])).code, 0);
});

test('real retry delays expire within the same worker and leave no open request', async t => {
  const state = track(t), fake = await fakeRpc(t, (r, res) => { res.writeHead(504); res.end(); });
  await assert.rejects(capture({ ...input, rpcUrl: fake.url, retries: 3, deadlineMs: 100 }), { code: 'CAPTURE_DEADLINE' });
  assert.equal(fake.calls.length, 1); assert.equal(state.active, 0); assert.equal(state.closed, state.opened);
});

test('final synchronous snapshot work is checked against the monotonic deadline', async t => {
  const c = clock({ deadlineMs: 100 }), fake = await fakeRpc(t), original = Date.prototype.toISOString;
  t.mock.method(Date.prototype, 'toISOString', function () { c.advance(100); return original.call(this); });
  await assert.rejects(capture({ ...input, rpcUrl: fake.url, [CAPTURE_POLICY]: c.policy }), { code: 'CAPTURE_DEADLINE' });
  assert.equal(fake.calls.length, 8);
});

test('global concurrency 1/2/8 survives per-read retries across independent/shared endpoints', async t => {
  for (const concurrency of [1, 2, 8]) for (const sharedBlock of [false, true]) await t.test(`${concurrency}/${sharedBlock}`, async t => {
    const paths = await setup(t, 8), state = track(t, concurrency), failed = new Set();
    const fake = await fakeRpc(t, (r, res, req) => {
      if (r.method === 'eth_getCode' && !failed.has(req.url)) { failed.add(req.url); res.destroy(); return; }
      return { result: protocolResult(r) };
    });
    const value = await captureMany({ ...paths, concurrency, sharedBlock, options: { retries: 1, deadlineMs: 5000 } },
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`PRIVATE_RPC_${i + 1}`, `${fake.url}/${i + 1}`])));
    assert.equal(value.saved, 8); assert.equal(state.active, 0); assert.equal(state.opened, state.closed);
    assert.equal(fake.calls.length, (sharedBlock ? 2 + 9 * 8 : 8 * 8) + 8); assert.equal(state.peak, concurrency);
  });
});

test('early CLI rejection performs no env/network/output IO even with retries requested', async t => {
  const paths = await setup(t), preload = join(paths.dir, 'guard.mjs');
  await fs.writeFile(preload, `import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';let calls=0;const no=()=>{calls++;throw Error('PRIVATE_FORBIDDEN');};process.env=new Proxy(process.env,{get(t,k){if(k==='CONTRACT_WATCH_RPC_URL'||String(k).startsWith('PRIVATE_RPC_'))return no();return Reflect.get(t,k);}});http.request=no;https.request=no;fs.mkdir=no;fs.open=no;syncBuiltinESMExports();process.on('exit',()=>assert.equal(calls,0));`);
  for (const args of [singleArgs(paths.dir), batchArgs(paths)]) for (const flags of [['--retries', '1'], ['--deadline-ms', '0100'], ['--retries', '0', '--retries', '0']]) {
    const value = await cli([...args, ...flags], { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    assert.equal(value.code, 1); assert.equal(value.stdout, ''); assert.match(value.stderr, /RETRIES_DEADLINE|DEADLINE_OPTION|USAGE/);
    assert.doesNotMatch(value.stderr, /AssertionError|PRIVATE_FORBIDDEN|INTERNAL/);
  }
});

test('write failures never retry capture or publication and retain other saved files', async t => {
  const paths = await setup(t), preload = join(paths.dir, 'write-failure.mjs'), fake = await fakeRpc(t);
  await fs.writeFile(preload, `import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {syncBuiltinESMExports} from 'node:module';const link=fs.link;let failures=0;fs.link=async(from,to)=>{if(to.endsWith('/target-02.json')){failures++;const e=Error('PRIVATE_WRITE');e.code='EIO';throw e;}return link(from,to);};syncBuiltinESMExports();process.on('exit',()=>assert.equal(failures,1));`);
  const value = await cli([...batchArgs(paths), '--shared-block', '--concurrency', '2', '--retries', '3', '--deadline-ms', '10000'],
    { PRIVATE_RPC_1: fake.url, PRIVATE_RPC_2: fake.url, PRIVATE_RPC_3: fake.url, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
  assert.equal(value.code, 1); assert.equal(value.stderr, ''); const report = JSON.parse(value.stdout); safe(report);
  assert.equal(report.saved, 2); assert.equal(report.outcomes[1].error.code, 'FILE_WRITE'); assert.equal(report.groups[0].status, 'resolved');
  assert.equal(fake.calls.length, 2 + 9 * 3); assert.deepEqual((await fs.readdir(paths.outputDir)).sort(), ['target-01.json', 'target-03.json']);
});

test('deadline during shared resolution blocks followers without env; independent queued targets get fresh budgets', async t => {
  for (const sharedBlock of [false, true]) await t.test(String(sharedBlock), async t => {
    const paths = await setup(t, 3), counts = [0, 0, 0], state = track(t, 1);
    const fake = await fakeRpc(t, (r, res, req) => {
      if (req.url === '/1') { res.writeHead(200); res.write('{'); return; }
      return { result: protocolResult(r) };
    });
    const env = Object.fromEntries([]);
    for (let i = 0; i < 3; i++) Object.defineProperty(env, `PRIVATE_RPC_${i + 1}`, { get() { counts[i]++; return `${fake.url}/${i + 1}`; } });
    const value = await captureMany({ ...paths, sharedBlock, options: { retries: 2, deadlineMs: 200 } }, env);
    assert.equal(value.saved, sharedBlock ? 0 : 2); assert.equal(value.outcomes[0].error.code, 'CAPTURE_DEADLINE');
    assert.deepEqual(counts, sharedBlock ? [1, 0, 0] : [1, 1, 1]);
    if (sharedBlock) { assert.equal(value.groups[0].status, 'unavailable'); assert.ok(value.outcomes.slice(1).every(o => o.error.code === 'SHARED_BLOCK_UNAVAILABLE')); }
    assert.equal(state.active, 0); safe(value);
  });
});

test('real CLI concurrent shared retry/deadline smoke preserves groups/order/files and safe partial errors', async t => {
  const paths = await setup(t, 3), failed = new Set(); let active = 0, peak = 0;
  const fake = await fakeRpc(t, (r, res, req) => {
    active++; peak = Math.max(peak, active); res.once('close', () => active--);
    const key = JSON.stringify([req.url, r.method, r.params]);
    if (req.url === '/3' && r.method === 'eth_getCode') { res.writeHead(200); res.write('{'); return; }
    if (!failed.has(key)) { failed.add(key); res.writeHead(503); res.end('PRIVATE_PROVIDER'); return; }
    return { result: protocolResult(r) };
  });
  const value = await cli([...batchArgs(paths), '--shared-block', '--concurrency', '2', '--retries', '1', '--deadline-ms', '2000'],
    Object.fromEntries([1, 2, 3].map(i => [`PRIVATE_RPC_${i}`, `${fake.url}/${i}`])));
  assert.equal(value.code, 1); assert.equal(value.stderr, ''); const report = JSON.parse(value.stdout); safe(report);
  assert.equal(report.schemaVersion, 2); assert.equal(report.groups.length, 1); assert.equal(report.groups[0].status, 'resolved');
  assert.equal(report.saved, 2); assert.deepEqual(report.outcomes.map(o => o.ordinal), [1, 2, 3]);
  assert.equal(report.outcomes[2].error.code, 'CAPTURE_DEADLINE'); assert.ok(peak <= 2);
  assert.deepEqual((await fs.readdir(paths.outputDir)).sort(), ['target-01.json', 'target-02.json']);
  for (const file of ['target-01.json', 'target-02.json']) assert.equal((await readSnapshot(join(paths.outputDir, file))).schemaVersion, 1);
});

test('default and explicit zero preserve configured single, independent/shared batch traces and closed reports', async t => {
  for (const sharedBlock of [false, true]) await t.test(String(sharedBlock), async t => {
    const fake = await fakeRpc(t), paths = await setup(t, 2), env = { PRIVATE_RPC_1: fake.url, PRIVATE_RPC_2: fake.url };
    const reports = [], traces = [];
    for (const flags of [[], ['--retries', '0']]) {
      const out = `${paths.outputDir}-${reports.length}`;
      const value = await cli([...batchArgs({ ...paths, outputDir: out }), ...(sharedBlock ? ['--shared-block'] : []), ...flags], env);
      assert.equal(value.code, 0, value.stderr); reports.push(JSON.parse(value.stdout)); traces.push([...fake.calls]); fake.calls.length = 0;
    }
    assert.deepEqual(reports[0], reports[1]); assert.deepEqual(traces[0], traces[1]);
    const single = [];
    for (const flags of [[], ['--retries', '0']]) {
      const file = join(paths.dir, `single-${single.length}.json`);
      const value = await cli(['snapshot', '--config', paths.configPath, '--target', 'private-1', '--out', file, ...flags], env);
      assert.equal(value.code, 0, value.stderr); single.push({ stdout: value.stdout, calls: [...fake.calls], file: stripTime(await readSnapshot(file)) }); fake.calls.length = 0;
    }
    assert.deepEqual(single[0], single[1]);
  });
});
