import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, chmod, readdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { MAX_SNAPSHOT_BYTES } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, fixture, ROOT } from './helpers/fake-rpc.js';

const execute = promisify(execFile);
const errors = {
  USAGE: 'Error [USAGE]: Invalid command or options. Run contract-watch --help.\n',
  SNAPSHOT: 'Error [SNAPSHOT]: Invalid or unsupported snapshot; expected the documented version 1 format.\n',
  FILE_READ: 'Error [FILE_READ]: Cannot read snapshot as a regular file (maximum 512 KiB).\n'
};

function assertFailure(result, code) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, errors[code]);
  assert.doesNotMatch(result.stderr, /PRIVATE_|https?:|\u001b|at .*\.js/);
}

async function inputFile(t, contents) {
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'PRIVATE_INPUT_FILE.json');
  await writeFile(path, contents);
  return { dir, path };
}

test('inspect reuses golden v1 reports for synthetic data, exact large integers and noncanonical slots', async t => {
  for (const name of ['changed', 'unchanged']) {
    await t.test(name, async t => {
      const value = JSON.parse(await readFile(new URL(`./fixtures/json-diff/${name}.json`, import.meta.url), 'utf8'));
      const raw = `${JSON.stringify(value.after, null, 2)}\n`;
      const { dir, path } = await inputFile(t, raw);
      await chmod(path, 0o444);
      const initial = await stat(path);
      const result = await cli(['inspect', path]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, value.expectedSnapshotHuman);
      assert.match(result.stdout, /Source: synthetic \(demonstration only\)/);
      assert.match(result.stdout, /chain 9007199254740993/);
      assert.match(result.stdout, /Block: 9007199254740994/);
      assert.doesNotMatch(result.stdout, /PRIVATE_INPUT_FILE|Snapshot saved/);
      assert.equal(await readFile(path, 'utf8'), raw);
      const final = await stat(path);
      assert.equal(final.mtimeMs, initial.mtimeMs);
      assert.equal(final.ino, initial.ino);
      assert.equal(final.mode, initial.mode);
      assert.deepEqual(await readdir(dir), ['PRIVATE_INPUT_FILE.json']);
    });
  }
});

test('inspect accepts rpc source without network calls and ignores valid or malformed RPC environment values', async t => {
  const value = fixture(); value.source = 'rpc';
  const raw = JSON.stringify(value);
  const { path } = await inputFile(t, raw);
  const fake = await fakeRpc(t);
  for (const endpoint of [`${fake.url}/PRIVATE_RPC_KEY`, 'PRIVATE_INVALID_URL']) {
    const result = await cli(['inspect', path], { CONTRACT_WATCH_RPC_URL: endpoint });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^Source: rpc$/m);
    assert.match(result.stdout, /Implementation slot populated; proxy behavior unverified\./);
    assert.doesNotMatch(result.stdout, /synthetic|PRIVATE_|https?:/);
  }
  assert.deepEqual(fake.calls, []);
  assert.equal(await readFile(path, 'utf8'), raw);
});

test('inspect explains empty code, empty slots and ordinary contract observations', async t => {
  const emptyPath = join(ROOT, 'test/fixtures/inspect/empty.json');
  const raw = await readFile(emptyPath, 'utf8');
  const result = await cli(['inspect', emptyPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Code: 0 bytes, SHA-256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/);
  for (const name of ['implementation', 'admin', 'beacon']) assert.match(result.stdout, new RegExp(`^${name}: empty$`, 'm'));
  assert.match(result.stdout, /No code at this block; proxy behavior is not established\./);
  assert.equal(await readFile(emptyPath, 'utf8'), raw);
  const ordinary = JSON.parse(raw); ordinary.code = '0x00';
  const { path } = await inputFile(t, JSON.stringify(ordinary));
  const contract = await cli(['inspect', path]);
  assert.equal(contract.code, 0, contract.stderr);
  assert.match(contract.stdout, /No EIP-1967 target found; other proxy patterns may exist\./);
});

test('inspect rejects corrupt JSON and unsupported/malformed v1 files without exposing input', async t => {
  const cases = [
    ['broken JSON', '{PRIVATE_JSON_SECRET'], ['null', 'null'], ['array', '[]']
  ];
  for (const [name, mutate] of [
    ['future version', value => { value.schemaVersion = 2; }],
    ['legacy version', value => { value.schemaVersion = 0; }],
    ['string version', value => { value.schemaVersion = '1'; }],
    ['missing version', value => { delete value.schemaVersion; }],
    ['unknown root field', value => { value.rpcUrl = 'https://PRIVATE_RPC_KEY'; }],
    ['unknown block field', value => { value.block.url = 'https://PRIVATE_RPC_KEY'; }],
    ['unknown slot field', value => { value.slots.extra = 'PRIVATE_RPC_KEY'; }],
    ['missing slot', value => { delete value.slots.admin; }],
    ['invalid code', value => { value.code = '\u001b[31mPRIVATE_CODE_SECRET'; }],
    ['invalid slot', value => { value.slots.beacon = '0x0'; }]
  ]) {
    const value = fixture(); mutate(value);
    cases.push([name, JSON.stringify(value)]);
  }
  for (const [name, raw] of cases) {
    await t.test(name, async t => {
      const { dir, path } = await inputFile(t, raw);
      assertFailure(await cli(['inspect', path]), 'SNAPSHOT');
      assert.equal(await readFile(path, 'utf8'), raw);
      assert.deepEqual(await readdir(dir), ['PRIVATE_INPUT_FILE.json']);
    });
  }
});

test('inspect preserves the size boundary and refuses missing, directory, FIFO and broken-link inputs', async t => {
  const raw = JSON.stringify(fixture());
  const { dir, path } = await inputFile(t, raw.padEnd(MAX_SNAPSHOT_BYTES, ' '));
  const atLimit = await cli(['inspect', path]);
  assert.equal(atLimit.code, 0, atLimit.stderr);
  await writeFile(path, raw.padEnd(MAX_SNAPSHOT_BYTES + 1, ' '));
  assertFailure(await cli(['inspect', path]), 'FILE_READ');
  assert.equal((await stat(path)).size, MAX_SNAPSHOT_BYTES + 1);
  const missing = join(dir, 'PRIVATE_MISSING_FILE');
  const broken = join(dir, 'PRIVATE_BROKEN_LINK');
  const fifo = join(dir, 'PRIVATE_FIFO');
  await symlink(missing, broken);
  await execute('mkfifo', [fifo]);
  for (const input of [missing, dir, broken, fifo]) {
    assertFailure(await cli(['inspect', input]), 'FILE_READ');
  }
});

test('inspect rejects flags, missing/extra files and empty paths before reading files', async () => {
  const path = 'PRIVATE_NONEXISTENT_FILE';
  const flags = ['--json', '--exit-code', '--rpc', '--address', '--chain-id', '--out', '--block', '--timeout-ms', '--help', '-h', '--version', '--'];
  const cases = [['inspect'], ['inspect', ''], ['inspect', path, path]];
  for (const flag of flags) {
    cases.push(['inspect', flag], ['inspect', flag, path], ['inspect', path, flag]);
  }
  for (const args of cases) assertFailure(await cli(args), 'USAGE');
});

test('README offline inspect command works and help exposes inspect without changing example data', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('node bin/contract-watch.js inspect examples/before.json'));
  const path = join(ROOT, 'examples/before.json');
  const raw = await readFile(path, 'utf8');
  const result = await cli(['inspect', 'examples/before.json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Source: synthetic \(demonstration only\)/);
  assert.match(result.stdout, /Block: 100 /);
  assert.equal(await readFile(path, 'utf8'), raw);
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /contract-watch inspect FILE/);
});
