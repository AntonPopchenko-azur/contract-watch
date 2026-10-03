import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { depth } from '../src/validate.js';
import { capture, SLOTS, validateSnapshot } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, protocolResult, ADDRESS, HASH } from './helpers/fake-rpc.js';

const MAX = (1n << 256n) - 1n;
const HEAD_HASH = `0x${'cd'.repeat(32)}`;
const errorCode = code => error => error.code === code;
const options = url => ({ rpcUrl: url, address: ADDRESS, chainId: '1' });
const args = path => ['snapshot', '--address', ADDRESS, '--chain-id', '1', '--out', path];
const INVALID = ['-1', '-0', '+1', '00', '01', '0x1', '1.0', '1e2', '1_000',
  ' 1', '1 ', '1\n', '１', 'SENSITIVE_TEST_DEPTH', (MAX + 1n).toString(), '9'.repeat(79)];

function expectedCalls(value, number, hash, target = ADDRESS) {
  const selector = { blockHash: hash, requireCanonical: true };
  return [
    ['eth_chainId', []], ['eth_getBlockByNumber', ['latest', false]],
    ...(value === '0' ? [] : [['eth_getBlockByNumber', [number, false]]]),
    ['eth_getCode', [target, selector]],
    ...Object.values(SLOTS).map(slot => ['eth_getStorageAt', [target, slot, selector]]),
    ['eth_getBlockByNumber', [number, false]], ['eth_chainId', []]
  ];
}

function resultFor(request, value = '1') {
  if (request.method === 'eth_getBlockByNumber') {
    return request.params[0] === 'latest' || value === '0'
      ? { number: '0x64', hash: HEAD_HASH } : { number: '0x63', hash: HASH };
  }
  return protocolResult(request);
}

test('depth accepts only canonical decimal uint256 and rejects conflicts before RPC', async t => {
  for (const value of ['0', '1', '9007199254740993', MAX.toString()]) {
    assert.equal(depth(value), BigInt(value));
  }
  assert.throws(() => depth(undefined), errorCode('DEPTH'));
  const fake = await fakeRpc(t);
  for (const value of [...INVALID, '', null, 1, 1n, {}, []]) {
    assert.throws(() => depth(value), errorCode('DEPTH'));
    await assert.rejects(capture({ ...options(fake.url), depth: value }), errorCode('DEPTH'));
  }
  for (const selector of [{ block: 'latest' }, { block: '0' }, { blockHash: HASH }, { block: null }]) {
    await assert.rejects(capture({ ...options(fake.url), ...selector, depth: '0' }), errorCode('USAGE'));
  }
  assert.equal(fake.calls.length, 0);
});

test('depth fixes an exact target from one initial latest header with bounded calls', async t => {
  const cases = [
    ['depth 0 reuses head', '0x64', '0', '0x64'],
    ['depth 1 selects parent height', '0x64', '1', '0x63'],
    ['depth equals head reaches genesis', '0x64', '100', '0x0'],
    ['genesis head with depth 0', '0x0', '0', '0x0'],
    ['height beyond safe integer', '0x20000000000001', '1', '0x20000000000000'],
    ['depth beyond safe integer', '0x20000000000002', '9007199254740993', '0x1'],
    ['uint256 maximum head with depth 0', `0x${'f'.repeat(64)}`, '0', `0x${'f'.repeat(64)}`],
    ['uint256 maximum head minus one', `0x${'f'.repeat(64)}`, '1', `0x${'f'.repeat(63)}e`],
    ['uint256 maximum depth reaches genesis', `0x${'f'.repeat(64)}`, MAX.toString(), '0x0'],
    ['uint256 large subtraction leaves one', `0x${'f'.repeat(64)}`, (MAX - 1n).toString(), '0x1']
  ];
  for (const [name, head, value, number] of cases) {
    await t.test(name, async t => {
      const hash = value === '0' ? HEAD_HASH : HASH;
      let latestCalls = 0;
      const fake = await fakeRpc(t, request => {
        if (request.method !== 'eth_getBlockByNumber') return { result: protocolResult(request) };
        if (request.params[0] === 'latest') {
          latestCalls++;
          // A later latest lookup would observe a different head. The target must stay fixed.
          return { result: { number: latestCalls === 1 ? head : '0x20000000000010', hash: HEAD_HASH } };
        }
        return { result: { number, hash } };
      });
      const snapshot = await capture({ ...options(fake.url), depth: value });
      assert.deepEqual(snapshot.block, { number, hash });
      assert.equal(validateSnapshot(snapshot), snapshot);
      assert.equal(snapshot.schemaVersion, 1);
      assert.deepEqual(fake.calls.map(call => [call.method, call.params]), expectedCalls(value, number, hash));
      assert.equal(fake.calls.length, value === '0' ? 8 : 9);
      assert.equal(latestCalls, 1);
      assert.equal(new Set(fake.calls.map(call => call.id)).size, fake.calls.length);
    });
  }
});

test('CLI depth works with RPC precedence, checksum, no-overwrite and offline v1 readers', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t, request => ({ result: resultFor(request) }));
  const ignored = await fakeRpc(t);
  const target = '0x52908400098527886E0F7030069857D2E4169EE7';
  const path = join(dir, 'first.json');
  const command = ['snapshot', '--depth', '1', '--address', target, '--strict-checksum',
    '--chain-id', '0x1', '--timeout-ms', '1000', '--out', path, '--rpc', `${fake.url}/SENSITIVE_TEST_KEY`];
  const environment = { CONTRACT_WATCH_RPC_URL: `${ignored.url}/SENSITIVE_TEST_ENV` };
  const first = await cli(command, environment);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.deepEqual(fake.calls.map(call => [call.method, call.params]), expectedCalls('1', '0x63', HASH, target.toLowerCase()));
  assert.equal(ignored.calls.length, 0);
  const original = await readFile(path, 'utf8');
  const snapshot = JSON.parse(original);
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.deepEqual(snapshot.block, { number: '0x63', hash: HASH });
  assert.doesNotMatch(original + first.stdout, /SENSITIVE_TEST_|http:/);
  const secondPath = join(dir, 'second.json');
  const second = await cli(['snapshot', '--address', target, '--chain-id', '1', '--out', secondPath, '--depth', '1'],
    { CONTRACT_WATCH_RPC_URL: fake.url });
  assert.equal(second.code, 0, second.stderr);
  const calls = fake.calls.length;
  assert.equal(calls, 18);
  assert.equal((await cli(['inspect', path], environment)).code, 0);
  const diff = await cli(['diff', '--json', path, '--exit-code', secondPath], environment);
  assert.equal(diff.code, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).schemaVersion, 1);
  assert.equal(JSON.parse(diff.stdout).changed, false);
  assert.equal(fake.calls.length, calls);
  assert.equal(ignored.calls.length, 0);
  const duplicate = await cli(command, environment);
  assert.equal(duplicate.code, 1);
  assert.equal(duplicate.stdout, '');
  assert.match(duplicate.stderr, /FILE_EXISTS/);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual((await readdir(dir)).sort(), ['first.json', 'second.json']);
});

test('CLI invalid depth syntax, flags, conflicts and checksum fail without RPC or files', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t);
  const base = [...args(join(dir, 'SENSITIVE_TEST_PATH.json')), '--rpc', `${fake.url}/SENSITIVE_TEST_KEY`];
  const invalid = [
    ...INVALID.map(value => [[...base, '--depth', value], 'DEPTH']),
    ...[
      ['--depth'], ['--depth', ''], ['--depth', '--strict-checksum'], ['--depth=1'],
      ['--depth', '0', '--depth', '0'], ['--depth', '1', 'extra'], ['--depth', '1', '--unknown'],
      ['--depth', '0', '--block', 'latest'], ['--block', 'latest', '--depth', '0'],
      ['--depth', '1', '--block', 'finalized'], ['--depth', '1', '--block', '0x64'],
      ['--depth', '1', '--block-hash', HASH], ['--block-hash', HASH, '--depth', '1']
    ].map(flags => [[...base, ...flags], 'USAGE']),
    [['inspect', '--depth', '1', 'SENSITIVE_TEST_PATH'], 'USAGE'],
    [['diff', '--json', '--exit-code', '--depth', '1', 'SENSITIVE_TEST_PATH', 'b'], 'USAGE']
  ];
  const wrongCase = [...base, '--depth', '1', '--strict-checksum'];
  wrongCase[wrongCase.indexOf('--address') + 1] = '0x52908400098527886e0f7030069857d2e4169ee7';
  invalid.push([wrongCase, 'ADDRESS_CHECKSUM']);
  for (const [command, code] of invalid) {
    const result = await cli(command, { CONTRACT_WATCH_RPC_URL: fake.url });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
    assert.doesNotMatch(result.stderr, /SENSITIVE_TEST_|0x[0-9a-fA-F]{40}|http:|at .*\.js/);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await readdir(dir), []);
  }
});

test('short chains and every depth RPC failure leave no snapshot or fallback reads', async t => {
  const remote = code => ({ error: { code, message: 'SENSITIVE_TEST_REMOTE', data: 'https://secret.invalid' } });
  const cases = [
    ['short chain', '101', 2, 'DEPTH_UNDERFLOW', { result: { number: '0x64', hash: HEAD_HASH } }],
    ['genesis underflow', '1', 2, 'DEPTH_UNDERFLOW', { result: { number: '0x0', hash: HEAD_HASH } }],
    ['large depth underflow', MAX.toString(), 2, 'DEPTH_UNDERFLOW', { result: { number: `0x${'f'.repeat(63)}e`, hash: HEAD_HASH } }],
    ['wrong chain', '1', 1, 'CHAIN_MISMATCH', { result: '0x2' }],
    ['latest rejected', '1', 2, 'RPC_REMOTE', remote(-32001)],
    ['target rejected', '1', 3, 'RPC_REMOTE', remote(-32001)],
    ['target height mismatch', '1', 3, 'RPC_DATA', { result: { number: '0x64', hash: HASH } }],
    ['target number is not minimal', '1', 3, 'RPC_DATA', { result: { number: '0x063', hash: HASH } }]
  ];
  for (const [stage, step] of [['latest', 2], ['target', 3]]) {
    cases.push([`${stage} missing`, '1', step, 'BLOCK_UNAVAILABLE', { result: null }]);
    for (const [index, result] of [[], {}, 'SENSITIVE_TEST_HEADER', { number: null, hash: null },
      { number: 100, hash: HASH }, { number: `0x1${'0'.repeat(64)}`, hash: HASH },
      { number: '0x63', hash: null }, { number: '0x63', hash: 'SENSITIVE_TEST_HEADER' }].entries()) {
      cases.push([`${stage} malformed ${index}`, '1', step, 'RPC_DATA', { result }]);
    }
  }
  for (const value of ['0', '1']) {
    const stateStep = value === '0' ? 3 : 4;
    cases.push(
      [`depth ${value} EIP-1898 unsupported`, value, stateStep, 'RPC_REMOTE', remote(-32602)],
      [`depth ${value} pruned state`, value, stateStep, 'RPC_REMOTE', remote(-32001)],
      [`depth ${value} reorg`, value, stateStep + 4, 'BLOCK_CHANGED', { result: { number: value === '0' ? '0x64' : '0x63', hash: `0x${'ef'.repeat(32)}` } }],
      [`depth ${value} final block missing`, value, stateStep + 4, 'BLOCK_UNAVAILABLE', { result: null }],
      [`depth ${value} final header malformed`, value, stateStep + 4, 'RPC_DATA', { result: { number: '0x63', hash: null } }],
      [`depth ${value} late chain change`, value, stateStep + 5, 'CHAIN_MISMATCH', { result: '0x2' }]
    );
    for (let slot = 1; slot <= 3; slot++) {
      cases.push([`depth ${value} noncanonical slot ${slot}`, value, stateStep + slot, 'RPC_REMOTE', remote(-32000)]);
    }
  }
  for (const [name, value, step, code, envelope] of cases) {
    await t.test(name, async t => {
      const dir = await temporaryDirectory(t);
      let count = 0;
      const fake = await fakeRpc(t, request => ++count === step ? envelope : { result: resultFor(request, value) });
      const result = await cli([...args(join(dir, 'SENSITIVE_TEST_PATH.json')), '--depth', value,
        '--rpc', `${fake.url}/SENSITIVE_TEST_KEY`]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
      assert.doesNotMatch(result.stderr, /SENSITIVE_TEST_|secret\.invalid|http:|0x[0-9a-fA-F]{40}|at .*\.js/);
      const expected = expectedCalls(value, value === '0' ? '0x64' : '0x63', value === '0' ? HEAD_HASH : HASH);
      assert.deepEqual(fake.calls.map(call => [call.method, call.params]), expected.slice(0, step));
      assert.deepEqual(await readdir(dir), []);
    });
  }
});
