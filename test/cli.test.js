import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { cli, fakeRpc, temporaryDirectory, ADDRESS, fixture, protocolResult } from './helpers/fake-rpc.js';

const args = target => ['snapshot', '--address', ADDRESS, '--chain-id', '1', '--out', target];

test('help and version work without an RPC or credentials', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /EIP-1898/);
  assert.equal((await cli(['--version'])).stdout, '0.1.0\n');
});

test('CLI captures through explicit or environment RPC, saves locally and compares offline', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t);
  const target = join(dir, 'first.json');
  const first = await cli([...args(target), '--rpc', `${fake.url}/secret-key`]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Snapshot saved/);
  assert.doesNotMatch(first.stdout + first.stderr, /secret-key|http:/);
  const saved = await readFile(target, 'utf8');
  assert.doesNotMatch(saved, /secret-key|http:/);
  assert.equal(JSON.parse(saved).source, 'rpc');
  const secondPath = join(dir, 'second.json');
  const second = await cli(args(secondPath), { CONTRACT_WATCH_RPC_URL: fake.url });
  assert.equal(second.code, 0, second.stderr);
  const callsBefore = fake.calls.length;
  const diff = await cli(['diff', target, secondPath]);
  assert.equal(diff.code, 0); assert.match(diff.stdout, /No code or EIP-1967 slot changes/);
  assert.equal(fake.calls.length, callsBefore);
  const duplicate = await cli([...args(target), '--rpc', fake.url]);
  assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /FILE_EXISTS/);
  assert.equal(await readFile(target, 'utf8'), saved);
});

test('CLI gives exit 0 for a meaningful offline diff and exit 1 for bad input', async t => {
  const dir = await temporaryDirectory(t);
  const before = fixture(); const after = fixture();
  after.block.number = '0x65'; after.block.hash = `0x${'cd'.repeat(32)}`; after.code = '0x';
  const a = join(dir, 'a.json'); const b = join(dir, 'b.json');
  await writeFile(a, JSON.stringify(before)); await writeFile(b, JSON.stringify(after));
  const diff = await cli(['diff', a, b]);
  assert.equal(diff.code, 0); assert.match(diff.stdout, /code:.* -> 0 bytes/);
  for (const invalid of [
    ['snapshot'], ['diff', a], ['unknown'],
    [...args(a), '--rpc', 'http://secret', '--rpc', 'http://secret'],
    [...args(a), '--bogus', 'secret'], [...args(a), '--timeout-ms', '999999'],
    ['snapshot', '--address', 'secret', '--chain-id', '1', '--out', a]
  ]) {
    const result = await cli(invalid);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /secret|at .*\.js/);
  }
});

test('failed RPC leaves no snapshot and never echoes endpoint, API key, remote message or data', async t => {
  const dir = await temporaryDirectory(t);
  const secret = 'SENSITIVE_TEST_KEY';
  const fake = await fakeRpc(t, request => request.method === 'eth_getStorageAt'
    ? { error: { code: -32000, message: `${secret} https://provider.invalid`, data: secret } }
    : { result: protocolResult(request) });
  const result = await cli([...args(join(dir, 'out.json')), '--rpc', `${fake.url}/${secret}?apiKey=${secret}`]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /RPC_REMOTE/);
  assert.doesNotMatch(result.stderr, /SENSITIVE_TEST_KEY|provider\.invalid|http:/);
  assert.deepEqual(await readdir(dir), []);
});

test('untrusted snapshot strings and file paths are not echoed on failure', async t => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'SENSITIVE_TEST_KEY.json');
  await writeFile(path, JSON.stringify({ ...fixture(), code: '\u001b[31mhttps://secret' }));
  const result = await cli(['diff', path, path]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SNAPSHOT/);
  assert.doesNotMatch(result.stderr, /SENSITIVE_TEST_KEY|https:|\u001b/);
});

test('synthetic demonstration is available without a network connection', async () => {
  const result = await cli(['diff', 'examples/before.json', 'examples/after.json']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /synthetic/);
  assert.match(result.stdout, /implementation:/);
});
