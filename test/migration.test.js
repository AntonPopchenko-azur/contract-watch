import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, chmod, readdir, symlink, link, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateFile, migrateSnapshot } from '../src/migration.js';
import { readSnapshot, validateSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_V3_BYTES } from '../src/snapshot.js';
import { snapshotReport, diffDocument, diffReport } from '../src/report.js';
import { MAX_CODE_BYTES } from '../src/validate.js';
import { cli, temporaryDirectory, EMPTY, word } from './helpers/fake-rpc.js';

const execute = promisify(execFile);
const corpus = JSON.parse(await readFile(new URL('./fixtures/migration/sources.json', import.meta.url), 'utf8'));
const source = name => structuredClone(corpus.cases.find(value => value.name === name).source);
const args = (input, output, version = '3') => ['migrate', input, '--to-version', version, '--out', output];
const common = ['source', 'capturedAt', 'chainId', 'address', 'block', 'code', 'slots'];
const flags = [[], ['--json'], ['--exit-code'], ['--json', '--exit-code']];
function failure(output, code) {
  assert.equal(output.code, 1);
  assert.equal(output.stdout, '');
  assert.ok(output.stderr.startsWith(`Error [${code}]: `), output.stderr);
  assert.doesNotMatch(output.stderr, /PRIVATE_|https?:|\.json|\u001b|at .*\.js/);
}
async function inputFile(t, snapshot = source('v1-implementation')) {
  const dir = await temporaryDirectory(t);
  const input = join(dir, 'PRIVATE_SOURCE.json');
  const output = join(dir, 'PRIVATE_OUTPUT.json');
  // Deliberate noncanonical JSON layout: original bytes must not be reformatted.
  await writeFile(input, ` \n${JSON.stringify(snapshot, null, 3)}\n\n`, { mode: 0o640 });
  return { dir, input, output };
}
async function unchanged(path, bytes, before) {
  assert.deepEqual(await readFile(path), bytes);
  const after = await stat(path);
  for (const key of ['mtimeMs', 'mode', 'size', 'ino']) assert.equal(after[key], before[key], key);
}

test('migration fixtures preserve exact common data and distinguish missing from every v2 state', async t => {
  for (const { name, source: original } of corpus.cases) await t.test(name, async t => {
    const before = structuredClone(original);
    const migrated = migrateSnapshot(before, '3');
    validateSnapshot(migrated);
    assert.deepEqual(before, original);
    for (const key of common) assert.deepEqual(migrated[key], original[key], key);
    assert.equal(migrated.schemaVersion, 3);
    assert.deepEqual(migrated.migration, { fromVersion: original.schemaVersion });
    assert.deepEqual(migrated.implementation, original.schemaVersion === 1 ? { status: 'not-recorded' } : original.implementation);
    assert.ok(!Object.hasOwn(migrated, 'migratedAt'));
    const { input, output, dir } = await inputFile(t, original);
    const bytes = await readFile(input);
    const metadata = await stat(input);
    const result = await cli(args(input, output));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'Snapshot migrated to version 3. Original preserved as backup.\n');
    assert.deepEqual(await readSnapshot(output), migrated);
    await unchanged(input, bytes, metadata);
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).sort(), ['PRIVATE_OUTPUT.json', 'PRIVATE_SOURCE.json']);
    const inspected = await cli(['inspect', output]);
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.equal(inspected.stdout, `${snapshotReport(migrated)}\n`);
    if (original.schemaVersion === 1) {
      assert.match(inspected.stdout, /not recorded in source v1/);
      assert.doesNotMatch(inspected.stdout, /Implementation address:|Implementation code:|Implementation code skipped:|implementation\(\) address observed/);
    }
  });
  for (const [name, original] of [['from-v1', source('v1-implementation')], ['from-beacon-v2', source('v2-beacon')]]) {
    const expected = await readSnapshot(new URL(`./fixtures/migration/${name}-v3.json`, import.meta.url));
    assert.deepEqual(migrateSnapshot(original, '3'), expected);
  }
});

test('migration result is independent of its source object and preserves the rpc source label', () => {
  const original = source('v2-beacon'); original.source = 'rpc';
  const migrated = migrateSnapshot(original, '3');
  const copy = structuredClone(migrated);
  original.block.number = '0x1'; original.slots.admin = '0x'; original.implementation.code = '0x';
  assert.deepEqual(migrated, copy);
  assert.equal(migrated.source, 'rpc');
});

test('strict v3 origin/observation validation never weakens v1 or v2', () => {
  const missing = migrateSnapshot(source('v1-implementation'), '3');
  const observed = migrateSnapshot(source('v2-beacon'), '3');
  for (const original of [missing, observed]) for (const mutate of [
    s => { delete s.migration; }, s => { delete s.implementation; }, s => { s.extra = 'PRIVATE_KEY'; },
    s => { s.migration.extra = 'PRIVATE_KEY'; }, s => { s.migration.fromVersion = '1'; },
    s => { s.migration.fromVersion = 3; }, s => { s.migration.fromVersion = 0; },
    s => { s.schemaVersion = 5; }, s => { s.implementation.secret = 'PRIVATE_KEY'; },
    s => { s.capturedAt = 'invalid'; }, s => { s.slots.admin = '0x0'; },
    s => { s.block.number = '0x01'; }, s => { s.chainId = '0x1'; }
  ]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => validateSnapshot(value), { code: 'SNAPSHOT' });
  }
  for (const mutate of [s => { s.implementation.address = s.address; }, s => { s.implementation.reason = 'EMPTY_SLOTS'; },
    s => { s.implementation.code = '0x'; }, s => { s.implementation.status = 'skipped'; },
    s => { s.migration.fromVersion = 2; }]) {
    const value = structuredClone(missing); mutate(value);
    assert.throws(() => validateSnapshot(value), { code: 'SNAPSHOT' });
  }
  for (const mutate of [s => { s.migration.fromVersion = 1; }, s => { s.implementation = { status: 'not-recorded' }; },
    s => { s.implementation.raw = EMPTY; }, s => { s.implementation.beacon = s.address; },
    s => { s.implementation.address = s.address; }, s => { s.implementation.status = 'no-code'; }]) {
    const value = structuredClone(observed); mutate(value);
    assert.throws(() => validateSnapshot(value), { code: 'SNAPSHOT' });
  }
  for (const version of [1, 2]) {
    assert.throws(() => validateSnapshot({ ...missing, schemaVersion: version }), { code: 'SNAPSHOT' });
    const relabeled = source(version === 1 ? 'v1-implementation' : 'v2-beacon'); relabeled.schemaVersion = 3;
    assert.throws(() => validateSnapshot(relabeled), { code: 'SNAPSHOT' });
  }
  const falseV2 = { ...source('v2-beacon'), implementation: { status: 'not-recorded' } };
  assert.throws(() => validateSnapshot(falseV2), { code: 'SNAPSHOT' });
  const malformedSkip = migrateSnapshot(source('v2-skipped'), '3'); malformedSkip.implementation.reason = 'EMPTY_SLOTS';
  assert.throws(() => validateSnapshot(malformedSkip), { code: 'SNAPSHOT' });
});

test('version negotiation rejects unsupported targets, repeats and already-v3 without creating output', async t => {
  const { dir, input, output } = await inputFile(t);
  for (const version of ['1', '2', '5', '04', '4.0', '03', '3.0', '-1', 'latest', 'PRIVATE_VERSION']) {
    failure(await cli(args(input, output, version)), 'MIGRATION_VERSION');
    await assert.rejects(migrateFile({ input: join(dir, 'missing'), output, toVersion: version }), { code: 'MIGRATION_VERSION' });
  }
  assert.deepEqual(await readdir(dir), ['PRIVATE_SOURCE.json']);
  assert.equal((await cli(args(input, output))).code, 0);
  const original = await readFile(output);
  failure(await cli(args(input, output)), 'FILE_EXISTS');
  const another = join(dir, 'another.json');
  failure(await cli(args(output, another)), 'MIGRATION_CURRENT');
  assert.deepEqual(await readFile(output), original);
  assert.deepEqual((await readdir(dir)).sort(), ['PRIVATE_OUTPUT.json', 'PRIVATE_SOURCE.json']);
  // Repeating the old source with a fresh path is an explicit deterministic copy.
  assert.equal((await cli(args(input, another))).code, 0);
  assert.deepEqual(await readFile(another), original);
});

test('original and existing destinations survive same paths, links and failed publication', async t => {
  const { dir, input, output } = await inputFile(t);
  const bytes = await readFile(input); const metadata = await stat(input);
  for (const destination of [input, join(dir, '.', 'PRIVATE_SOURCE.json')]) failure(await cli(args(input, destination)), 'MIGRATION_PATH');
  const sourceLink = join(dir, 'source-link.json'); await symlink(input, sourceLink);
  const hard = join(dir, 'hard.json'); await link(input, hard);
  const broken = join(dir, 'broken.json'); await symlink(join(dir, 'absent'), broken);
  const folder = join(dir, 'folder'); await mkdir(folder);
  await writeFile(output, 'PRIVATE_KEEP_DESTINATION');
  for (const destination of [sourceLink, hard, broken, folder, output]) {
    failure(await cli(args(input, destination)), 'FILE_EXISTS');
    await unchanged(input, bytes, metadata);
  }
  failure(await cli(args(input, join(dir, 'missing', 'out.json'))), 'FILE_WRITE');
  assert.equal(await readFile(output, 'utf8'), 'PRIVATE_KEEP_DESTINATION');
  assert.deepEqual(await readFile(hard), bytes);
  // A regular input symlink is accepted without modifying its target.
  const symlinkOutput = join(dir, 'from-link.json');
  assert.equal((await cli(args(sourceLink, symlinkOutput))).code, 0);
  await unchanged(input, bytes, metadata);
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('concurrent migrations publish exactly one complete private output', async t => {
  const { dir, input, output } = await inputFile(t);
  const second = join(dir, 'second.json'); await writeFile(second, JSON.stringify(source('v2-beacon')));
  const bytes = await readFile(input); const metadata = await stat(input);
  const outcomes = await Promise.allSettled([input, second].map(path => migrateFile({ input: path, output, toVersion: '3' })));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'FILE_EXISTS');
  const saved = await readSnapshot(output);
  assert.ok([1, 2].includes(saved.migration.fromVersion));
  assert.deepEqual(saved, outcomes.find(value => value.status === 'fulfilled').value);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
  await unchanged(input, bytes, metadata);
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('malformed and unusual inputs fail safely without new files or source mutation', async t => {
  const { dir, input, output } = await inputFile(t);
  for (const body of ['{PRIVATE_INVALID_JSON', 'null', JSON.stringify({ ...source('v1-admin'), secret: 'PRIVATE_KEY' }),
    JSON.stringify({ ...source('v2-beacon'), implementation: { status: 'not-recorded' } }),
    JSON.stringify({ ...source('v1-admin'), schemaVersion: 99 })]) {
    await writeFile(input, body);
    const metadata = await stat(input);
    failure(await cli(args(input, output)), 'SNAPSHOT');
    await unchanged(input, Buffer.from(body), metadata);
    assert.deepEqual(await readdir(dir), ['PRIVATE_SOURCE.json']);
  }
  const broken = join(dir, 'broken'); await symlink(join(dir, 'missing'), broken);
  for (const path of [dir, broken, join(dir, 'missing')]) failure(await cli(args(path, output)), 'FILE_READ');
  if (process.platform !== 'win32') {
    const fifo = join(dir, 'fifo'); await execute('mkfifo', [fifo]);
    failure(await cli(args(fifo, output)), 'FILE_READ');
    await writeFile(input, JSON.stringify(source('v1-admin')));
    failure(await cli(args(input, fifo)), 'FILE_EXISTS');
    await chmod(input, 0o000);
    try { failure(await cli(args(input, output)), 'FILE_READ'); }
    finally { await chmod(input, 0o640); }
  }
  assert.ok(!(await readdir(dir)).includes('PRIVATE_OUTPUT.json'));
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('bounded migration accepts both maximum blobs and per-version file limits, rejects overflow', async t => {
  const dir = await temporaryDirectory(t);
  for (const [name, original, limit] of [['v1', source('v1-beacon'), MAX_SNAPSHOT_BYTES], ['v2', source('v2-beacon'), MAX_SNAPSHOT_V3_BYTES]]) {
    original.code = `0x${'60'.repeat(MAX_CODE_BYTES)}`;
    if (original.schemaVersion === 2) original.implementation.code = `0x${'61'.repeat(MAX_CODE_BYTES)}`;
    const input = join(dir, `${name}.json`); const output = join(dir, `${name}-v3.json`);
    const body = JSON.stringify(original).padEnd(limit, ' ');
    await writeFile(input, body);
    assert.equal((await cli(args(input, output))).code, 0);
    const migrated = await readSnapshot(output);
    assert.deepEqual(migrated, migrateSnapshot(original, '3'));
    assert.ok((await stat(output)).size < MAX_SNAPSHOT_V3_BYTES);
    await writeFile(input, `${body} `);
    failure(await cli(args(input, join(dir, 'overflow.json'))), 'FILE_READ');
    assert.ok(!(await readdir(dir)).includes('overflow.json'));
  }
  const maximum = migrateSnapshot(source('v2-beacon'), '3');
  const path = join(dir, 'bounded-v3.json');
  await writeFile(path, JSON.stringify(maximum).padEnd(MAX_SNAPSHOT_V3_BYTES, ' '));
  assert.deepEqual(await readSnapshot(path), maximum);
  await writeFile(path, JSON.stringify(maximum).padEnd(MAX_SNAPSHOT_V3_BYTES + 1, ' '));
  await assert.rejects(readSnapshot(path), { code: 'FILE_READ' });
  for (const key of ['code', 'implementation']) {
    const invalid = source('v2-beacon');
    if (key === 'code') invalid.code = `0x${'60'.repeat(MAX_CODE_BYTES + 1)}`;
    else invalid.implementation.code = `0x${'61'.repeat(MAX_CODE_BYTES + 1)}`;
    assert.throws(() => migrateSnapshot(invalid, '3'), { code: 'SNAPSHOT' });
  }
});

test('CLI migration and v3 inspect/diff never read RPC env or invoke fetch/http', async t => {
  const { dir, input, output } = await inputFile(t);
  const preload = join(dir, 'offline-guard.mjs');
  await writeFile(preload, `import assert from 'node:assert/strict';
import http from 'node:http'; import https from 'node:https';
let envReads=0, networkCalls=0;
const original=process.env;
process.env=new Proxy(original,{get(target,key){if(key==='CONTRACT_WATCH_RPC_URL'){envReads++;throw new Error('PRIVATE_ENV_READ');}return Reflect.get(target,key);}});
const network=()=>{networkCalls++;throw new Error('PRIVATE_NETWORK_CALL');};
globalThis.fetch=network; http.request=network; http.get=network; https.request=network; https.get=network;
process.on('exit',()=>{assert.equal(envReads,0);assert.equal(networkCalls,0);});
`);
  const environment = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, CONTRACT_WATCH_RPC_URL: 'https://PRIVATE_RPC_KEY.invalid' };
  for (const command of [args(input, output), ['inspect', output], ['diff', '--json', '--exit-code', output, output]]) {
    const result = await cli(command, environment);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /PRIVATE_|https?:/);
  }
});

test('CLI requires explicit source, target and new path and rejects conflicting flags before I/O', async t => {
  const { dir, input, output } = await inputFile(t);
  for (const command of [
    ['migrate'], ['migrate', input], ['migrate', input, '--to-version', '3'], ['migrate', input, '--out', output],
    [...args(input, output), '--out', output], [...args(input, output), '--to-version', '3'],
    [...args(input, output), input], [...args(input, output), '--json'], [...args(input, output), '--exit-code'],
    [...args(input, output), '--rpc', 'https://PRIVATE_KEY'], [...args(input, output), '--block', 'latest'],
    [...args(input, output), '--implementation-code'], ['migrate', input, '--to-version=3', '--out', output],
    ['migrate', '', '--to-version', '3', '--out', output], ['migrate', input, '--to-version', '--out', output],
    ['migrate', '--PRIVATE_FILE', '--to-version', '3', '--out', output]
  ]) failure(await cli(command), 'USAGE');
  assert.deepEqual(await readdir(dir), ['PRIVATE_SOURCE.json']);
  const result = await cli(['migrate', '--out', output, '--to-version', '3', input]);
  assert.equal(result.code, 0, result.stderr);
  assert.match((await cli(['--help'])).stdout, /migrate SOURCE.json --to-version 3 --out NEW.json/);
});

test('v3 diffs treat missing observations as unavailable while preserving recorded v2 comparisons', async t => {
  const available = source('v2-beacon');
  const legacy = { ...structuredClone(available), schemaVersion: 1 }; delete legacy.implementation;
  const missing = migrateSnapshot(legacy, '3');
  const recorded = migrateSnapshot(available, '3');
  for (const [before, after] of [[missing, missing], [missing, recorded], [recorded, missing]]) {
    const document = diffDocument(before, after);
    assert.equal(document.schemaVersion, 3);
    assert.equal(document.changed, false);
    assert.equal(document.implementation.comparison, 'unavailable');
    assert.deepEqual(document.implementation.changes, []);
    assert.deepEqual(document.notices, []); // Missing record is not a same-hash contradiction.
    assert.doesNotMatch(diffReport(before, after), /No implementation address or code changes observed/);
    assert.match(diffReport(before, after), /historical observation not recorded/);
    const { input, output } = await inputFile(t, before); await writeFile(output, JSON.stringify(after));
    for (const options of flags) {
      const result = await cli(['diff', ...options, input, output]);
      assert.equal(result.code, 0, result.stderr);
      if (options.includes('--json')) assert.deepEqual(JSON.parse(result.stdout), document);
    }
  }
  for (const name of ['v2-direct', 'v2-beacon', 'v2-no-code', 'v2-skipped']) {
    const before = source(name); const after = structuredClone(before);
    after.block = { number: '0x65', hash: `0x${'cc'.repeat(32)}` };
    if (name !== 'v2-skipped') {
      after.implementation.code = before.implementation.code === '0x' ? '0x6000' : '0x';
      after.implementation.status = after.implementation.code === '0x' ? 'no-code' : 'observed';
    }
    const v2 = diffDocument(before, after);
    const v3 = diffDocument(migrateSnapshot(before, '3'), migrateSnapshot(after, '3'));
    assert.deepEqual(v3, { ...v2, schemaVersion: 3 });
  }
  const changedProvenance = structuredClone(recorded);
  changedProvenance.slots.beacon = word(changedProvenance.address);
  changedProvenance.implementation.beacon = changedProvenance.address;
  assert.equal(diffDocument(recorded, changedProvenance).implementation.comparison, 'provenance-changed');
  const changedTarget = structuredClone(missing); changedTarget.code = '0x6001';
  const changed = diffDocument(missing, changedTarget);
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.notices, ['INCONSISTENT_BLOCK_DATA']);
  assert.deepEqual(changed.implementation.changes, []);
  const fork = structuredClone(missing); fork.block.hash = `0x${'dd'.repeat(32)}`;
  assert.deepEqual(diffDocument(missing, fork).notices, ['SAME_HEIGHT_DIFFERENT_HASH']);
});

test('mixed formats and invalid v3 files fail safely in inspect/diff/migrate', async t => {
  const versions = [source('v1-admin'), source('v2-beacon'), migrateSnapshot(source('v2-beacon'), '3')];
  for (const before of versions) for (const after of versions) {
    if (before.schemaVersion === after.schemaVersion) continue;
    const { input, output } = await inputFile(t, before); await writeFile(output, JSON.stringify(after));
    for (const options of flags) failure(await cli(['diff', ...options, input, output]), 'DIFF_VERSION');
  }
  const invalid = structuredClone(versions[2]); invalid.migration.fromVersion = 1;
  const { dir, input, output } = await inputFile(t, invalid);
  failure(await cli(['inspect', input]), 'SNAPSHOT');
  failure(await cli(args(input, output)), 'SNAPSHOT');
  for (const options of flags) failure(await cli(['diff', ...options, input, input]), 'SNAPSHOT');
  assert.deepEqual(await readdir(dir), ['PRIVATE_SOURCE.json']);
});
