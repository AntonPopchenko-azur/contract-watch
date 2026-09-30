import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diffDocument, diffReport, snapshotReport } from '../src/report.js';
import { cli, fakeRpc, temporaryDirectory } from './helpers/fake-rpc.js';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/json-diff/${name}.json`, import.meta.url), 'utf8'));
}

async function writePair(t, before, after) {
  const dir = await temporaryDirectory(t);
  const paths = [join(dir, 'PRIVATE_INPUT_MARKER-before.json'), join(dir, 'PRIVATE_INPUT_MARKER-after.json')];
  await writeFile(paths[0], JSON.stringify(before));
  await writeFile(paths[1], JSON.stringify(after));
  return paths;
}

test('version 1 JSON fixtures describe changed, unchanged and forked comparisons exactly', async t => {
  for (const name of ['changed', 'unchanged', 'forked']) {
    await t.test(name, async () => {
      const { before, after, expected, expectedHuman, expectedSnapshotHuman } = await fixture(name);
      const original = JSON.stringify({ before, after });
      assert.deepEqual(diffDocument(before, after), expected);
      // Golden text was captured from published baseline 283e808, not the JSON renderer.
      assert.equal(`${diffReport(before, after)}\n`, expectedHuman);
      assert.equal(`${snapshotReport(after)}\n`, expectedSnapshotHuman);
      assert.equal(JSON.stringify({ before, after }), original);
      assert.equal(typeof expected.chainId, 'string');
      assert.ok(BigInt(expected.chainId) > BigInt(Number.MAX_SAFE_INTEGER));
      assert.equal(expected.blocks.before.number, '0x20000000000001');
    });
  }
});

test('CLI emits only one JSON document and keeps human output and success status for all fixtures', async t => {
  for (const name of ['changed', 'unchanged', 'forked']) {
    await t.test(name, async t => {
      const { before, after, expected, expectedHuman } = await fixture(name);
      const paths = await writePair(t, before, after);
      const result = await cli(['diff', '--json', ...paths]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), expected);
      assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
      assert.doesNotMatch(result.stdout, /PRIVATE_INPUT_MARKER|https?:|capturedAt|Error|Observation/);
      const human = await cli(['diff', ...paths]);
      assert.equal(human.code, 0);
      assert.equal(human.stderr, '');
      assert.equal(human.stdout, expectedHuman);
    });
  }
});

test('incomparable fixture produces no partial JSON and preserves the fixed safe error', async t => {
  const { before, after, errorCode } = await fixture('incomparable');
  assert.throws(() => diffDocument(before, after), { code: errorCode });
  const paths = await writePair(t, before, after);
  const result = await cli(['diff', ...paths, '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Error [INCOMPARABLE]: Snapshots must have the same chain ID, address, and source kind.\n');
});

test('JSON flags work before, between or after filenames; duplicate and unsupported flags fail safely', async t => {
  const { before, after, expected } = await fixture('unchanged');
  const paths = await writePair(t, before, after);
  for (const args of [['--json', ...paths], [paths[0], '--json', paths[1]], [...paths, '--json']]) {
    const result = await cli(['diff', ...args]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  for (const args of [
    ['diff', '--json', ...paths, '--json'], ['diff', '--json', paths[0]],
    ['diff', '--json', ...paths, 'PRIVATE_INPUT_MARKER'],
    ['diff', ...paths, '--json=true'], ['diff', '--json', ...paths, '--exit-code'],
    ['snapshot', '--json']
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Error [USAGE]: Invalid command or options. Run contract-watch --help.\n');
  }
});

test('JSON diff remains offline even when a key-bearing RPC environment variable is configured', async t => {
  const { before, after } = await fixture('changed');
  const paths = await writePair(t, before, after);
  const fake = await fakeRpc(t);
  const result = await cli(['diff', '--json', ...paths], {
    CONTRACT_WATCH_RPC_URL: `${fake.url}/PRIVATE_RPC_KEY?apiKey=PRIVATE_RPC_KEY`
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fake.calls.length, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_RPC_KEY|PRIVATE_INPUT_MARKER|https?:/);
});

test('invalid, cross-target and reversed JSON inputs fail without stdout or leaked input', async t => {
  const { before, after } = await fixture('unchanged');
  for (const [code, mutate] of [
    ['INCOMPARABLE', value => { value.address = `0x${'5'.repeat(40)}`; }],
    ['INCOMPARABLE', value => { value.source = 'rpc'; }],
    ['ORDER', value => { value.block.number = '0x1'; }],
    ['SNAPSHOT', value => { value.rpcUrl = 'https://PRIVATE_RPC_KEY'; }],
    ['SNAPSHOT', value => { value.slots.admin = '\u001b[31mPRIVATE_RPC_KEY'; }],
    ['SNAPSHOT', value => { value.schemaVersion = 99; }]
  ]) {
    await t.test(code, async t => {
      const invalid = structuredClone(after); mutate(invalid);
      const paths = await writePair(t, before, invalid);
      const result = await cli(['diff', '--json', ...paths]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.startsWith(`Error [${code}]: `));
      assert.doesNotMatch(result.stderr, /PRIVATE_|https?:|\u001b|\.json|at .*\.js/);
    });
  }
  const paths = await writePair(t, before, after);
  await writeFile(paths[1], '{PRIVATE_RPC_KEY');
  const corrupt = await cli(['diff', '--json', ...paths]);
  assert.equal(corrupt.code, 1); assert.equal(corrupt.stdout, '');
  assert.match(corrupt.stderr, /^Error \[SNAPSHOT\]: /);
  const missing = await cli(['diff', '--json', paths[0], `${paths[1]}.missing`]);
  assert.equal(missing.code, 1); assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /^Error \[FILE_READ\]: /);
  assert.doesNotMatch(corrupt.stderr + missing.stderr, /PRIVATE_|\.json/);
});

test('notice codes distinguish same-hash inconsistencies from slot/code changes', async () => {
  const { before } = await fixture('unchanged');
  const changed = structuredClone(before);
  changed.code = '0x';
  const report = diffDocument(before, changed);
  assert.equal(report.changed, true);
  assert.deepEqual(report.notices, ['INCONSISTENT_BLOCK_DATA']);
  assert.deepEqual(report.changes[0].after, {
    bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  });
  const wrongHeight = structuredClone(before);
  wrongHeight.block.number = '0x20000000000002';
  const sameState = diffDocument(before, wrongHeight);
  assert.equal(sameState.changed, false);
  assert.deepEqual(sameState.changes, []);
  assert.deepEqual(sameState.notices, ['INCONSISTENT_BLOCK_DATA']);
});

test('metadata-only changes do not enter the JSON report or affect deterministic output', async () => {
  const { before, after } = await fixture('unchanged');
  const first = JSON.stringify(diffDocument(before, after));
  before.capturedAt = '2026-09-30T12:00:00.000Z';
  after.capturedAt = '2026-09-30T13:00:00.000Z';
  assert.equal(JSON.stringify(diffDocument(before, after)), first);
});
