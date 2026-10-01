import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { cli, temporaryDirectory, ROOT } from './helpers/fake-rpc.js';

const execute = promisify(execFile);
const formats = [['text', []], ['JSON', ['--json']]];

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/json-diff/${name}.json`, import.meta.url), 'utf8'));
}

async function writePair(t, before, after) {
  const dir = await temporaryDirectory(t);
  await mkdir(join(dir, 'snapshots'));
  const paths = [join(dir, 'snapshots/first.json'), join(dir, 'snapshots/second.json')];
  await writeFile(paths[0], JSON.stringify(before));
  await writeFile(paths[1], JSON.stringify(after));
  return { dir, paths };
}

test('opt-in status follows changed for both formats while preserving golden reports and default status', async t => {
  for (const name of ['changed', 'unchanged', 'forked']) {
    const value = await fixture(name);
    const { paths } = await writePair(t, value.before, value.after);
    for (const [format, flags] of formats) {
      await t.test(`${name}, ${format}`, async () => {
        const standard = await cli(['diff', ...flags, ...paths]);
        const optIn = await cli(['diff', ...flags, ...paths, '--exit-code']);
        assert.equal(standard.code, 0, standard.stderr);
        assert.equal(optIn.code, value.expected.changed ? 2 : 0, optIn.stderr);
        const expected = format === 'JSON' ? `${JSON.stringify(value.expected, null, 2)}\n` : value.expectedHuman;
        assert.equal(standard.stdout, expected);
        assert.equal(optIn.stdout, expected);
        assert.equal(standard.stderr, '');
        assert.equal(optIn.stderr, '');
      });
    }
  }
});

test('each changed field independently triggers 2, including code changes of equal length', async t => {
  const { before, after } = await fixture('changed');
  for (const field of ['code', 'implementation', 'admin', 'beacon']) {
    await t.test(field, async t => {
      const single = structuredClone(before);
      single.block = after.block;
      if (field === 'code') single.code = after.code;
      else single.slots[field] = after.slots[field];
      const { paths } = await writePair(t, before, single);
      const result = await cli(['diff', '--exit-code', '--json', ...paths]);
      assert.equal(result.code, 2, result.stderr);
      const document = JSON.parse(result.stdout);
      assert.equal(document.changed, true);
      assert.deepEqual(document.changes.map(change => change.field), [field]);
    });
  }
});

test('notices do not trigger 2 by themselves and do not suppress 2 for actual changes', async t => {
  const { before, after } = await fixture('changed');
  for (const [name, mutate, changed, notice] of [
    ['same hash different height', value => { value.block.number = after.block.number; }, false, 'INCONSISTENT_BLOCK_DATA'],
    ['same hash changed code', value => { value.code = after.code; }, true, 'INCONSISTENT_BLOCK_DATA'],
    ['fork with changed code', value => { value.block.hash = after.block.hash; value.code = after.code; }, true, 'SAME_HEIGHT_DIFFERENT_HASH']
  ]) {
    await t.test(name, async t => {
      const candidate = structuredClone(before); mutate(candidate);
      const { paths } = await writePair(t, before, candidate);
      for (const [, flags] of formats) {
        const result = await cli(['diff', '--exit-code', ...flags, ...paths]);
        assert.equal(result.code, changed ? 2 : 0, result.stderr);
        assert.equal(result.stderr, '');
        if (flags.length) {
          const document = JSON.parse(result.stdout);
          assert.equal(document.changed, changed);
          assert.deepEqual(document.notices, [notice]);
        }
      }
    });
  }
});

test('read, parse, validation, compatibility and ordering errors remain safe status 1 in both formats', async t => {
  for (const [name, code, prepare] of [
    ['missing file', 'FILE_READ', async (paths) => unlink(paths[1])],
    ['invalid JSON', 'SNAPSHOT', async (paths) => writeFile(paths[1], '{PRIVATE_TEST_SECRET')],
    ['invalid schema', 'SNAPSHOT', async (paths, after) => writeFile(paths[1], JSON.stringify({ ...after, rpcUrl: 'https://PRIVATE_TEST_SECRET' }))],
    ['different chain', 'INCOMPARABLE', async (paths, after) => writeFile(paths[1], JSON.stringify({ ...after, chainId: '2' }))],
    ['different address', 'INCOMPARABLE', async (paths, after) => writeFile(paths[1], JSON.stringify({ ...after, address: `0x${'9'.repeat(40)}` }))],
    ['different source', 'INCOMPARABLE', async (paths, after) => writeFile(paths[1], JSON.stringify({ ...after, source: 'rpc' }))],
    ['reversed blocks', 'ORDER', async (paths, after) => writeFile(paths[1], JSON.stringify({ ...after, block: { ...after.block, number: '0x1' } }))]
  ]) {
    await t.test(name, async t => {
      const { before, after } = await fixture('changed');
      const { dir, paths } = await writePair(t, before, after);
      await prepare(paths, after);
      for (const [, flags] of formats) {
        const result = await cli(['diff', '--exit-code', ...flags, ...paths]);
        assert.equal(result.code, 1);
        assert.equal(result.stdout, '');
        assert.ok(result.stderr.startsWith(`Error [${code}]: `));
        assert.ok(!result.stderr.includes(dir));
        assert.doesNotMatch(result.stderr, /PRIVATE_TEST_SECRET|https?:|\.json|at .*\.js/);
      }
    });
  }
});

test('exit-code flag supports any diff position and rejects duplicate, valued or incompatible flags', async t => {
  const { before, after, expected } = await fixture('changed');
  const { paths } = await writePair(t, before, after);
  for (const args of [
    ['--exit-code', '--json', ...paths], ['--json', paths[0], '--exit-code', paths[1]],
    [...paths, '--json', '--exit-code'], ['--exit-code', ...paths, '--json']
  ]) {
    const result = await cli(['diff', ...args]);
    assert.equal(result.code, 2, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  for (const args of [
    ['diff', '--exit-code', ...paths, '--exit-code'],
    ['diff', '--exit-code', '--json', ...paths, '--json'],
    ['diff', ...paths, '--exit-code=true'], ['diff', '--exit-code', '2', ...paths],
    ['diff', '--exit-code', paths[0]], ['diff', '--exit-code', ...paths, '--unknown'],
    ['diff', '--exit-code', ...paths, '--rpc', 'https://PRIVATE_TEST_SECRET'],
    ['snapshot', '--address', before.address, '--chain-id', '1', '--out', paths[0], '--exit-code'],
    ['--exit-code', 'diff', ...paths], ['--version', '--exit-code'], ['--help', '--exit-code']
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Error [USAGE]: Invalid command or options. Run contract-watch --help.\n');
  }
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--exit-code\s+Exit 2 for state changes/);
});

test('README shell example captures 0, 2 and 1 safely under set -e and keeps JSON separate', async t => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const script = readme.match(/```sh\n(set -e\n[\s\S]*?)\n```/)?.[1];
  assert.ok(script, 'README must include the set -e example');
  for (const [name, expectedStatus, message] of [
    ['unchanged', 0, 'No code or slot changes'],
    ['changed', 0, 'Code or slot changes detected'],
    ['incomparable', 1, 'Comparison failed']
  ]) {
    await t.test(name, async t => {
      const { before, after, expected } = await fixture(name);
      const { dir } = await writePair(t, before, after);
      await symlink(join(ROOT, 'bin'), join(dir, 'bin'));
      let result;
      try {
        result = { ...await execute('/bin/sh', ['-c', script], { cwd: dir, timeout: 10000 }), code: 0 };
      } catch (error) { result = { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
      assert.equal(result.code, expectedStatus);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(message));
      const report = await readFile(join(dir, 'diff.json'), 'utf8');
      if (expectedStatus === 0) assert.deepEqual(JSON.parse(report), expected);
      else assert.equal(report, '');
    });
  }
});
