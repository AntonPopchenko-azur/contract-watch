import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { blockHash } from '../src/validate.js';
import { capture, SLOTS } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, protocolResult, ADDRESS, HASH } from './helpers/fake-rpc.js';

const UPPER_HASH = `0x${'AB'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const HEADER = { number: '0x64', hash: HASH };
const METHODS = [
  'eth_chainId', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_getStorageAt', 'eth_getStorageAt', 'eth_getStorageAt',
  'eth_getBlockByNumber', 'eth_chainId'
];
const options = url => ({ rpcUrl: url, address: ADDRESS, chainId: '1', blockHash: HASH });
const args = (url, path) => ['snapshot', '--address', ADDRESS, '--chain-id', '1',
  '--rpc', `${url}/SENSITIVE_TEST_KEY`, '--out', path];
const errorCode = code => error => error.code === code;

function assertPinned(calls) {
  for (const call of calls.filter(call => ['eth_getCode', 'eth_getStorageAt'].includes(call.method))) {
    assert.deepEqual(call.params.at(-1), { blockHash: HASH, requireCanonical: true });
  }
}

test('validates and normalizes exactly 32 hash bytes before opening RPC', async t => {
  assert.equal(blockHash(UPPER_HASH), HASH);
  assert.equal(blockHash(`0x${'aB'.repeat(32)}`), HASH);
  assert.equal(blockHash(`0x${'0'.repeat(64)}`), `0x${'0'.repeat(64)}`);
  const fake = await fakeRpc(t);
  for (const value of [null, 1, {}, [], '', 'latest', '123', '0x64', HASH.slice(2),
    HASH.replace('0x', '0X'), `${HASH}0`, HASH.slice(0, -1), `0x${'z'.repeat(64)}`,
    ` ${HASH}`, `${HASH}\n`]) {
    assert.throws(() => blockHash(value), errorCode('BLOCK_HASH'));
    await assert.rejects(capture({ ...options(fake.url), blockHash: value }), errorCode('BLOCK_HASH'));
  }
  for (const block of ['latest', 'finalized', '100', HASH, null]) {
    await assert.rejects(capture({ ...options(fake.url), block }), errorCode('USAGE'));
  }
  assert.equal(fake.calls.length, 0);
});

test('hash capture uses nine exact read calls, canonical checks and large block numbers', async t => {
  const number = '0x20000000000001'; // Above Number.MAX_SAFE_INTEGER.
  const fake = await fakeRpc(t, request => ({ result: request.method.startsWith('eth_getBlockBy')
    ? { number, hash: UPPER_HASH, transactions: [] } : protocolResult(request) }));
  const snapshot = await capture({ ...options(fake.url), blockHash: UPPER_HASH });
  assert.deepEqual(snapshot.block, { number, hash: HASH });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.source, 'rpc');
  assert.deepEqual(fake.calls.map(call => [call.method, call.params]), [
    ['eth_chainId', []],
    ['eth_getBlockByHash', [HASH, false]],
    ['eth_getBlockByNumber', [number, false]],
    ['eth_getCode', [ADDRESS, { blockHash: HASH, requireCanonical: true }]],
    ...Object.values(SLOTS).map(slot => ['eth_getStorageAt', [ADDRESS, slot, { blockHash: HASH, requireCanonical: true }]]),
    ['eth_getBlockByNumber', [number, false]],
    ['eth_chainId', []]
  ]);
  assert.equal(new Set(fake.calls.map(call => call.id)).size, 9);
});

test('existing block tags and integers including 64-digit hex remain number lookups', async t => {
  for (const block of [undefined, 'latest', 'safe', 'finalized', '100', '0x0064', HASH]) {
    await t.test(String(block), async t => {
      const number = block === HASH ? HASH : '0x64';
      const tag = block === undefined ? 'latest'
        : ['latest', 'safe', 'finalized'].includes(block) ? block : number;
      const fake = await fakeRpc(t, request => ({ result: request.method === 'eth_getBlockByNumber'
        ? { number, hash: OTHER_HASH } : protocolResult(request) }));
      const snapshot = await capture({ rpcUrl: fake.url, address: ADDRESS, chainId: '1', block });
      assert.deepEqual(snapshot.block, { number, hash: OTHER_HASH });
      assert.equal(fake.calls.length, 8);
      assert.deepEqual(fake.calls[1].params, [tag, false]);
      assert.deepEqual(fake.calls[6].params, [number, false]);
      assert.ok(fake.calls.every(call => call.method !== 'eth_getBlockByHash'));
      for (const call of fake.calls.slice(2, 6)) {
        assert.deepEqual(call.params.at(-1), { blockHash: OTHER_HASH, requireCanonical: true });
      }
    });
  }
});

test('CLI hash capture composes with strict checksum, existing files and offline v1 commands', async t => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'snapshot.json');
  const target = '0x52908400098527886E0F7030069857D2E4169EE7';
  const fake = await fakeRpc(t);
  const command = ['snapshot', '--block-hash', UPPER_HASH, '--address', target, '--strict-checksum',
    '--chain-id', '0x1', '--timeout-ms', '1000', '--out', path];
  const env = { CONTRACT_WATCH_RPC_URL: `${fake.url}/SENSITIVE_TEST_KEY` };
  const result = await cli(command, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(fake.calls.map(call => call.method), METHODS);
  assertPinned(fake.calls);
  for (const call of fake.calls.slice(3, 7)) assert.equal(call.params[0], target.toLowerCase());
  const saved = await readFile(path, 'utf8');
  const snapshot = JSON.parse(saved);
  assert.equal(snapshot.address, target.toLowerCase());
  assert.deepEqual(snapshot.block, HEADER);
  assert.equal(snapshot.schemaVersion, 1);
  assert.doesNotMatch(saved + result.stdout, /SENSITIVE_TEST_KEY|http:/);
  const inspect = await cli(['inspect', path], env);
  assert.equal(inspect.code, 0, inspect.stderr);
  const diff = await cli(['diff', '--json', path, '--exit-code', path], env);
  assert.equal(diff.code, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).schemaVersion, 1);
  assert.equal(JSON.parse(diff.stdout).changed, false);
  assert.equal(fake.calls.length, 9);
  const duplicate = await cli(command, env);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /FILE_EXISTS/);
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.deepEqual(await readdir(dir), ['snapshot.json']);
});

test('CLI rejects invalid hash options before RPC or file creation without echoing input', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t);
  const base = args(fake.url, join(dir, 'SENSITIVE_TEST_PATH.json'));
  const invalid = [
    ...['SENSITIVE_TEST_HASH', 'latest', '0x64', HASH.slice(2), `${HASH}0`, `${HASH}\n`,
      HASH.replace('0x', '0X'), `0x${'g'.repeat(64)}`].map(value => [[...base, '--block-hash', value], 'BLOCK_HASH']),
    ...[
      ['--block-hash'], ['--block-hash', ''], ['--block-hash', '--strict-checksum'],
      ['--block-hash', HASH, '--block-hash', HASH], ['--block-hash', HASH, 'extra'],
      [`--block-hash=${HASH}`], ['--block-hash', HASH, '--unknown'],
      ['--block-hash', HASH, '--block', 'latest'], ['--block', 'latest', '--block-hash', HASH],
      ['--block-hash', HASH, '--block', '100'], ['--block-hash', HASH, '--block', HASH]
    ].map(flags => [[...base, ...flags], 'USAGE']),
    [['inspect', '--block-hash', HASH], 'USAGE'],
    [['diff', '--json', '--exit-code', '--block-hash', HASH, 'a.json', 'b.json'], 'USAGE']
  ];
  // The existing strict checksum still rejects an address before any RPC call.
  const wrongCase = [...base, '--block-hash', HASH, '--strict-checksum'];
  wrongCase[wrongCase.indexOf('--address') + 1] = '0x52908400098527886e0f7030069857d2e4169ee7';
  invalid.push([wrongCase, 'ADDRESS_CHECKSUM']);
  for (const [command, code] of invalid) {
    const result = await cli(command);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
    assert.doesNotMatch(result.stderr, /SENSITIVE_TEST_|0x[0-9a-fA-F]{40}|http:|at .*\.js/);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await readdir(dir), []);
  }
});

test('hash/header/canonical/state/chain failures stop at the failing call and never save', async t => {
  const remote = code => ({ error: { code, message: 'SENSITIVE_TEST_REMOTE', data: 'https://secret.invalid' } });
  const cases = [
    ['wrong chain', 1, 'CHAIN_MISMATCH', { result: '0x2' }],
    ['hash lookup unsupported', 2, 'RPC_REMOTE', remote(-32601)],
    ['missing hash', 2, 'BLOCK_UNAVAILABLE', { result: null }],
    ...[[], {}, 'SENSITIVE_TEST_HEADER', { number: null, hash: null },
      { hash: HASH }, { number: 100, hash: HASH }, { number: '0x064', hash: HASH },
      { number: `0x1${'0'.repeat(64)}`, hash: HASH }, { number: '0x64' },
      { number: '0x64', hash: 'SENSITIVE_TEST_HEADER' }, { number: '0x64', hash: '0xab' },
      { number: '0x64', hash: OTHER_HASH }]
      .map((result, index) => [`bad hash header ${index}`, 2, 'RPC_DATA', { result }]),
    ['missing canonical header', 3, 'BLOCK_UNAVAILABLE', { result: null }],
    ['malformed canonical header', 3, 'RPC_DATA', { result: { number: null, hash: HASH } }],
    ['canonical height mismatch', 3, 'RPC_DATA', { result: { number: '0x65', hash: HASH } }],
    ['noncanonical hash', 3, 'BLOCK_NOT_CANONICAL', { result: { number: '0x64', hash: OTHER_HASH } }],
    ['canonical lookup rejected', 3, 'RPC_REMOTE', remote(-32001)],
    ['EIP-1898 unsupported', 4, 'RPC_REMOTE', remote(-32602)],
    ['state pruned', 4, 'RPC_REMOTE', remote(-32001)],
    ...[4, 5, 6, 7].map(step => [`noncanonical state call ${step}`, step, 'RPC_REMOTE', remote(-32000)]),
    ['late reorg', 8, 'BLOCK_CHANGED', { result: { number: '0x64', hash: OTHER_HASH } }],
    ['late wrong number', 8, 'BLOCK_CHANGED', { result: { number: '0x65', hash: HASH } }],
    ['late missing header', 8, 'BLOCK_UNAVAILABLE', { result: null }],
    ['late malformed header', 8, 'RPC_DATA', { result: { number: '0x64', hash: null } }],
    ['late chain change', 9, 'CHAIN_MISMATCH', { result: '0x2' }]
  ];
  for (const [name, step, code, envelope] of cases) {
    await t.test(name, async t => {
      const dir = await temporaryDirectory(t);
      let count = 0;
      const fake = await fakeRpc(t, request => ++count === step ? envelope : { result: protocolResult(request) });
      const result = await cli([...args(fake.url, join(dir, 'SENSITIVE_TEST_PATH.json')), '--block-hash', HASH]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
      assert.doesNotMatch(result.stderr, /SENSITIVE_TEST_|secret\.invalid|0x[0-9a-fA-F]{40}|http:|at .*\.js/);
      assert.deepEqual(fake.calls.map(call => call.method), METHODS.slice(0, step));
      for (const call of fake.calls.filter(call => call.method === 'eth_getBlockByNumber')) {
        assert.deepEqual(call.params, ['0x64', false]);
      }
      assertPinned(fake.calls);
      assert.deepEqual(await readdir(dir), []);
    });
  }
});
