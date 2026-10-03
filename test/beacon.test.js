import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture, captureWithBeacon, SLOTS, validateSnapshot } from '../src/snapshot.js';
import { createRpc } from '../src/rpc.js';
import { BEACON_SELECTOR, decodeBeaconResult } from '../src/beacon.js';
import { keccak256 } from '../src/keccak.js';
import { snapshotReport } from '../src/report.js';
import { fakeRpc, cli, temporaryDirectory, protocolResult, ADDRESS, HASH, EMPTY, word } from './helpers/fake-rpc.js';

const corpus = JSON.parse(await readFile(new URL('./fixtures/beacon/abi.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('./fixtures/beacon/snapshot-v1.json', import.meta.url), 'utf8'));
const BEACON = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const IMPLEMENTATION = corpus.valid[0].implementation;
const ABI_RESULT = corpus.valid[0].result;
const METHODS = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_getStorageAt', 'eth_getStorageAt', 'eth_getStorageAt', 'eth_call',
  'eth_getBlockByNumber', 'eth_chainId'];
const options = url => ({ rpcUrl: url, address: ADDRESS, chainId: '1' });
const args = (url, path) => ['snapshot', '--address', ADDRESS, '--chain-id', '1',
  '--rpc', `${url}/SENSITIVE_TEST_KEY`, '--out', path, '--resolve-beacon'];
const errorCode = code => error => error.code === code;

function beaconResult(request, slots = fixture.slots) {
  if (request.method === 'eth_getStorageAt') {
    return slots[Object.keys(SLOTS).find(name => SLOTS[name] === request.params[1])];
  }
  if (request.method === 'eth_call') return ABI_RESULT;
  return protocolResult(request);
}

function assertPinnedCall(calls, target = ADDRESS) {
  const call = calls.find(request => request.method === 'eth_call');
  assert.deepEqual(call.params, [
    { from: target, to: BEACON, gas: '0x186a0', value: '0x0', input: '0x5c60da1b' },
    { blockHash: HASH, requireCanonical: true }
  ]);
  assert.equal(calls.filter(request => request.method === 'eth_call').length, 1);
  for (const request of calls.filter(request => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(request.method))) {
    assert.deepEqual(request.params.at(-1), { blockHash: HASH, requireCanonical: true });
  }
  // No implementation/beacon bytecode lookup or recursive resolution in this increment.
  assert.deepEqual(calls.filter(request => request.method === 'eth_getCode').map(request => request.params[0]), [target]);
}

function assertFailure(result, code) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
  assert.doesNotMatch(result.stderr, /SENSITIVE_TEST_|secret\.invalid|https?:|0x[0-9a-fA-F]{40}|at .*\.js/);
}

test('selector and ABI fixtures enforce a single padded nonzero address', () => {
  assert.equal(BEACON_SELECTOR, corpus.selector);
  assert.equal(`0x${keccak256(Buffer.from(corpus.signature)).slice(0, 8)}`, corpus.selector);
  for (const { result, implementation } of corpus.valid) {
    assert.deepEqual(decodeBeaconResult(result), { implementation, raw: result.toLowerCase() });
  }
  for (const { result } of corpus.invalid) assert.throws(() => decodeBeaconResult(result), errorCode('BEACON_RESULT'));
});

test('resolution uses one fixed pinned call in every existing block selection mode', async t => {
  for (const [name, selection, extra] of [
    ['default', {}, false], ['number', { block: '100' }, false], ['finalized', { block: 'finalized' }, false],
    ['hash', { blockHash: HASH }, true], ['depth 0', { depth: '0' }, false], ['depth 1', { depth: '1' }, true]
  ]) {
    await t.test(name, async t => {
      const fake = await fakeRpc(t, request => ({ result: selection.depth === '1' && request.method === 'eth_getBlockByNumber' && request.params[0] === 'latest'
        ? { number: '0x65', hash: `0x${'cd'.repeat(32)}` } : beaconResult(request) }));
      const { snapshot, beaconResolution } = await captureWithBeacon({ ...options(fake.url), ...selection });
      const expected = [...METHODS];
      if (selection.blockHash) expected[1] = 'eth_getBlockByHash';
      if (extra) expected.splice(2, 0, 'eth_getBlockByNumber');
      assert.deepEqual(fake.calls.map(request => request.method), expected);
      assert.equal(fake.calls.length, extra ? 10 : 9);
      assertPinnedCall(fake.calls);
      assert.equal(new Set(fake.calls.map(request => request.id)).size, fake.calls.length);
      assert.equal(validateSnapshot(snapshot), snapshot);
      assert.deepEqual(snapshot.slots, fixture.slots);
      assert.deepEqual(beaconResolution, { status: 'resolved', beacon: BEACON, raw: ABI_RESULT, implementation: IMPLEMENTATION });
      const report = snapshotReport(snapshot, { beaconResolution });
      assert.ok(report.includes(IMPLEMENTATION));
      assert.match(report, /not saved in snapshot v1/);
      assert.match(report, /proxy behavior and implementation code are unverified/);
      assert.doesNotMatch(report, /implementation is not resolved/);
    });
  }
});

test('default capture never calls a beacon and the generic RPC path rejects calls and writes', async t => {
  const fake = await fakeRpc(t, request => ({ result: beaconResult(request) }));
  const snapshot = await capture(options(fake.url));
  assert.equal(fake.calls.length, 8);
  assert.ok(fake.calls.every(request => request.method !== 'eth_call'));
  assert.match(snapshotReport(snapshot), /beacon implementation is not resolved/);
  const rpc = createRpc(fake.url);
  for (const method of ['eth_call', 'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'eth_estimateGas']) {
    await assert.rejects(rpc(method, [{ to: BEACON, input: '0x' }, 'latest']), errorCode('USAGE'));
  }
  assert.equal(fake.calls.length, 8);
});

test('ineligible slots or no target code skip resolution while preserving raw v1 state', async t => {
  const noncanonical = `0x01${'00'.repeat(31)}`;
  for (const [name, code, slots, reason] of [
    ['empty beacon', '0x6000', { ...fixture.slots, beacon: EMPTY }, 'EMPTY_BEACON'],
    ['both slots populated', '0x6000', { ...fixture.slots, implementation: word(IMPLEMENTATION) }, 'IMPLEMENTATION_SLOT_POPULATED'],
    ['implementation only', '0x6000', { ...fixture.slots, implementation: word(IMPLEMENTATION), beacon: EMPTY }, 'IMPLEMENTATION_SLOT_POPULATED'],
    ...['beacon', 'implementation', 'admin'].map(slot => [`noncanonical ${slot}`, '0x6000', { ...fixture.slots, [slot]: noncanonical }, 'NONCANONICAL_SLOT']),
    ['no target code', '0x', fixture.slots, 'NO_TARGET_CODE']
  ]) {
    await t.test(name, async t => {
      const fake = await fakeRpc(t, request => ({ result: request.method === 'eth_getCode' ? code : beaconResult(request, slots) }));
      const { snapshot, beaconResolution } = await captureWithBeacon(options(fake.url));
      assert.deepEqual(snapshot.slots, slots);
      assert.deepEqual(beaconResolution, { status: 'skipped', reason });
      assert.equal(fake.calls.length, 8);
      assert.ok(fake.calls.every(request => request.method !== 'eth_call'));
      const report = snapshotReport(snapshot, { beaconResolution });
      assert.match(report, /Beacon resolution skipped:/);
      assert.doesNotMatch(report, /implementation\(\): 0x/);
    });
  }
});

test('CLI success preserves v1 files, RPC precedence, checksum and private no-overwrite persistence', async t => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'snapshot.json');
  const target = '0x52908400098527886E0F7030069857D2E4169EE7';
  const fake = await fakeRpc(t, request => ({ result: beaconResult(request) }));
  const ignored = await fakeRpc(t);
  const command = args(fake.url, path);
  command[command.indexOf('--address') + 1] = target;
  command.push('--strict-checksum', '--timeout-ms', '1000', '--block-hash', HASH);
  const environment = { CONTRACT_WATCH_RPC_URL: `${ignored.url}/SENSITIVE_TEST_ENV` };
  const result = await cli(command, environment);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Live beacon observation only; not saved in snapshot v1/);
  assert.ok(result.stdout.includes(IMPLEMENTATION));
  assert.doesNotMatch(result.stdout, /SENSITIVE_TEST_|https?:/);
  assertPinnedCall(fake.calls, target.toLowerCase());
  assert.equal(fake.calls.length, 10);
  assert.equal(ignored.calls.length, 0);
  const original = await readFile(path, 'utf8');
  const saved = JSON.parse(original);
  assert.equal(validateSnapshot(saved), saved);
  assert.deepEqual(saved.slots, fixture.slots);
  assert.ok(!original.includes(IMPLEMENTATION));
  assert.equal(Object.hasOwn(saved, 'beaconResolution'), false);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const inspect = await cli(['inspect', path], environment);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /beacon implementation is not resolved/);
  const diff = await cli(['diff', '--json', path, '--exit-code', path], environment);
  assert.equal(diff.code, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).schemaVersion, 1);
  assert.equal(JSON.parse(diff.stdout).changed, false);
  assert.equal(fake.calls.length, 10);
  assert.equal(ignored.calls.length, 0);
  assertFailure(await cli(command, environment), 'FILE_EXISTS');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['snapshot.json']);
});

test('CLI opt-in can use the RPC environment and emits an explicit skip', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t); // Baseline direct implementation, empty beacon.
  const result = await cli(['snapshot', '--resolve-beacon', '--address', ADDRESS, '--chain-id', '1',
    '--depth', '0', '--out', join(dir, 'out.json')], { CONTRACT_WATCH_RPC_URL: fake.url });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Beacon resolution skipped: implementation slot populated/);
  assert.equal(fake.calls.length, 8);
});

test('ABI, provider and final-check errors never save or emit partial output', async t => {
  const remote = code => ({ error: { code, message: 'SENSITIVE_TEST_REMOTE', data: 'https://secret.invalid' } });
  const cases = [
    ...corpus.invalid.map(({ name, result }) => [name, 7, 'BEACON_RESULT', { result }]),
    ['revert', 7, 'RPC_REMOTE', remote(3)], ['out of gas', 7, 'RPC_REMOTE', remote(-32000)],
    ['EIP-1898 unsupported', 7, 'RPC_REMOTE', remote(-32602)], ['missing pinned state', 7, 'RPC_REMOTE', remote(-32001)],
    ['response id mismatch', 7, 'RPC_ENVELOPE', { id: 999, result: ABI_RESULT }],
    ['late reorg', 8, 'BLOCK_CHANGED', { result: { number: '0x64', hash: `0x${'ef'.repeat(32)}` } }],
    ['missing final block', 8, 'BLOCK_UNAVAILABLE', { result: null }],
    ['late chain change', 9, 'CHAIN_MISMATCH', { result: '0x2' }]
  ];
  for (const [name, step, code, envelope] of cases) {
    await t.test(name, async t => {
      const dir = await temporaryDirectory(t);
      let count = 0;
      const fake = await fakeRpc(t, request => ++count === step ? envelope : { result: beaconResult(request) });
      assertFailure(await cli(args(fake.url, join(dir, 'SENSITIVE_TEST_PATH.json'))), code);
      assert.deepEqual(fake.calls.map(request => request.method), METHODS.slice(0, step));
      assertPinnedCall(fake.calls);
      assert.deepEqual(await readdir(dir), []);
    });
  }
});

test('beacon HTTP response and timeout limits cover declared and streamed bodies', async t => {
  for (const mode of ['declared oversize', 'streamed oversize', 'no headers', 'slow body', 'five second cap']) {
    await t.test(mode, async t => {
      const dir = await temporaryDirectory(t);
      const fake = await fakeRpc(t, (request, response) => {
        if (request.method !== 'eth_call') return { result: beaconResult(request) };
        if (mode === 'declared oversize') { response.writeHead(200, { 'content-length': 4097 }); response.end('x'.repeat(4097)); }
        if (mode === 'streamed oversize') { response.writeHead(200, { 'transfer-encoding': 'chunked' }); response.end('x'.repeat(4097)); }
        if (mode === 'slow body') {
          response.writeHead(200);
          const timer = setInterval(() => response.write(' '), 10);
          response.on('close', () => clearInterval(timer));
        }
      });
      const result = await cli([...args(fake.url, join(dir, 'out.json')), '--timeout-ms', mode === 'five second cap' ? '60000' : '100']);
      assertFailure(result, mode.includes('oversize') ? 'BEACON_SIZE' : 'RPC_TIMEOUT');
      assert.deepEqual(fake.calls.map(request => request.method), METHODS.slice(0, 7));
      assert.deepEqual(await readdir(dir), []);
    });
  }
});

test('flag and old-format validation reject invalid input without network or silent extension', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t);
  const path = join(dir, 'SENSITIVE_TEST_PATH.json');
  const base = args(fake.url, path);
  const invalid = [
    [...base, '--resolve-beacon'], [...base, 'true'], [...base, 'false'],
    [...base.slice(0, -1), '--resolve-beacon=true'], [...base, '--unknown'],
    ['inspect', '--resolve-beacon', path], ['diff', '--json', '--resolve-beacon', path, path]
  ];
  for (const command of invalid) assertFailure(await cli(command), 'USAGE');
  const badChecksum = [...base, '--strict-checksum'];
  badChecksum[badChecksum.indexOf('--address') + 1] = '0x52908400098527886e0f7030069857d2e4169ee7';
  assertFailure(await cli(badChecksum), 'ADDRESS_CHECKSUM');
  assertFailure(await cli([...base, '--block-hash', 'SENSITIVE_TEST_HASH']), 'BLOCK_HASH');
  assertFailure(await cli([...base, '--depth', '-1']), 'DEPTH');
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(path, JSON.stringify(fixture));
  const env = { CONTRACT_WATCH_RPC_URL: fake.url };
  assert.equal((await cli(['inspect', path], env)).code, 0);
  assert.equal((await cli(['diff', path, path], env)).code, 0);
  await writeFile(path, JSON.stringify({ ...fixture, beaconResolution: { implementation: IMPLEMENTATION } }));
  assertFailure(await cli(['inspect', path], env), 'SNAPSHOT');
  assertFailure(await cli(['diff', path, path], env), 'SNAPSHOT');
  assert.equal(fake.calls.length, 0);
});
