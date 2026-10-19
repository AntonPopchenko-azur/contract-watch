import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pruneHistory, retentionPlan } from '../src/retention.js';
import { historyOperation } from '../src/history.js';
import { historyTimeline, timelineReport } from '../src/timeline.js';
import { fixture, cli, ROOT, IMPLEMENTATION } from './helpers/fake-rpc.js';
import { store, next, hash, json, sorted, snapshotName, stageName, preserved } from './helpers/history-fixture.js';

const inputs = JSON.parse(await fs.readFile(new URL('./fixtures/retention/inputs.json', import.meta.url)));
const expected = JSON.parse(await fs.readFile(new URL('./fixtures/retention/plan.json', import.meta.url)));
const options = (p, keepLast = '2', apply) => ({ directory: p.directory, keepLast, ...(apply ? { apply, output: p.output } : {}) });
const args = (p, keepLast = '2', apply) => ['history', 'prune', '--dir', p.directory, '--keep-last', keepLast,
  ...(apply ? ['--apply', apply, '--out-dir', p.output] : [])];
const verify = directory => historyOperation({ operation: 'verify', directory });
async function apply(p, keepLast = '2') {
  const plan = await pruneHistory(options(p, keepLast));
  return { plan, result: await pruneHistory(options(p, keepLast, plan.planId)) };
}
function failure(result, code) {
  assert.equal(result.code, 1, result.stderr); assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]: [^\\n]+\\n$`));
  assert.doesNotMatch(result.stderr, /PRIVATE|https?:|\.json|at .*\.js|\u001b/);
}
async function missing(path) { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }); }

test('independent retention plan fixture: baseline plus last two, with exact reasons and ordinals', async t => {
  const p = await store(t, inputs, { pending: [next(inputs[4])], stages: ['partial PRIVATE'] });
  assert.deepEqual(retentionPlan(p.state, 'f'.repeat(64), 2), expected);
  await preserved(p.directory, async () => {
    const plan = await pruneHistory(options(p));
    assert.deepEqual(plan.observations, expected.observations);
    assert.deepEqual(plan.source, expected.source);
    const { planId, ...body } = plan;
    assert.equal(planId, hash(JSON.stringify(sorted(body))));
    assert.deepEqual(await pruneHistory(options(p)), plan);
    const result = await cli(args(p));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(result.stdout, json(plan)); assert.doesNotMatch(result.stdout, /PRIVATE|\.json|0x60"/);
    await missing(p.output);
  });
});

for (const count of [0, 1, 2, 5]) for (const keepLast of ['0', '1', '2', '128']) test(`retention ${count} observations, last ${keepLast}: copy and no-op selection`, async t => {
  const p = await store(t, inputs.slice(0, count));
  await preserved(p.directory, async () => {
    const { plan, result } = await apply(p, keepLast);
    const wanted = Array.from({ length: count }, (_, n) => n + 1).filter(n => n === 1 || n > count - Number(keepLast));
    assert.deepEqual(result.retention.ordinals, wanted); assert.equal(plan.selectionChanged, wanted.length < count);
    assert.equal(result.retained, wanted.length); assert.equal(result.freesSpace, false); assert.equal(result.sourceUnchanged, true);
    const state = await verify(p.output); assert.equal(state.committed, wanted.length); assert.equal(state.pending, 0); assert.equal(state.staged, 0);
    assert.equal((await fs.stat(p.output)).mode & 0o777, 0o700);
    for (const name of await fs.readdir(p.output)) assert.equal((await fs.stat(join(p.output, name))).mode & 0o777, 0o600);
    for (const n of wanted) {
      const name = snapshotName(inputs[n - 1]);
      assert.deepEqual(await fs.readFile(join(p.output, name)), await fs.readFile(join(p.directory, name)));
      assert.notEqual((await fs.stat(join(p.output, name))).ino, (await fs.stat(join(p.directory, name))).ino);
    }
    const timeline = await historyTimeline(p.output);
    assert.equal(timeline.schemaVersion, 2); assert.equal(timeline.committed, wanted.length);
    assert.deepEqual(timeline.retention, result.retention);
    assert.match(timelineReport(timeline), /source observations excluded from this copy/);
    await assert.rejects(pruneHistory(options(p, keepLast, plan.planId)), { code: 'HISTORY_EXISTS' });
  });
});

test('apply preserves pending, abandoned stages, source metadata and neighboring user files', async t => {
  const p = await store(t, inputs, { pending: [next(inputs[4])], stages: [Buffer.from([0xff, 0, 5])] });
  const neighbor = join(p.parent, 'PRIVATE_notes'); await fs.writeFile(neighbor, 'PRIVATE keep', { mode: 0o640 });
  await fs.chmod(join(p.directory, snapshotName(inputs[0])), 0o440);
  await preserved(neighbor, () => preserved(p.directory, async () => {
    const plan = await pruneHistory(options(p)), result = await cli(args(p, '2', plan.planId));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'copied'); assert.doesNotMatch(result.stdout, /PRIVATE|\.json/);
    assert.deepEqual((await fs.readdir(p.output)).sort(), ['index.json', ...[1, 2, 3].map(n => `entry-000${n}.json`), ...[0, 3, 4].map(n => snapshotName(inputs[n]))].sort());
  }));
});

function variants() {
  const a = fixture(), b = { ...fixture(), schemaVersion: 2,
    implementation: { status: 'observed', via: 'implementation-slot', address: IMPLEMENTATION, code: '0x60' } };
  return [a, b, { ...a, schemaVersion: 3, migration: { fromVersion: 1 }, implementation: { status: 'not-recorded' } },
    { ...b, schemaVersion: 3, migration: { fromVersion: 2 } },
    { ...b, schemaVersion: 4, genesis: { status: 'observed', hash: a.block.hash } },
    { ...a, schemaVersion: 4, migration: { fromVersion: 1 }, implementation: { status: 'not-recorded' }, genesis: { status: 'not-recorded' } },
    { ...b, schemaVersion: 4, migration: { fromVersion: 2 }, genesis: { status: 'not-recorded' } }];
}
for (const [i, value] of variants().entries()) test(`v1-v4 identity and migration provenance preserved, variant ${i}`, async t => {
  const p = await store(t, [value, next(value), next(value, 2)]);
  await preserved(p.directory, async () => {
    const { plan } = await apply(p, '1');
    assert.equal(plan.identity.snapshotVersion, value.schemaVersion);
    assert.deepEqual(plan.identity.genesis, value.genesis ?? { status: 'not-recorded' });
    assert.deepEqual(JSON.parse(await fs.readFile(join(p.output, snapshotName(value)))), value);
    assert.equal((await cli(['inspect', join(p.output, snapshotName(value))])).code, 0);
    const timeline = await cli(['history', 'timeline', '--dir', p.output, '--json']);
    if (value.genesis?.status === 'not-recorded') failure(timeline, 'GENESIS_UNAVAILABLE');
    else assert.equal(timeline.code, 0, timeline.stderr);
  });
});

test('selection ignores height/time ordering, exact uint256 and repeated states; omitted changes remain explicit', async t => {
  const a = { ...fixture(), chainId: ((1n << 256n) - 1n).toString(), block: { number: `0x${((1n << 256n) - 1n).toString(16)}`, hash: fixture().block.hash } };
  const b = { ...structuredClone(a), capturedAt: '2026-10-19T16:00:00.000Z', code: '0x61' };
  const c = { ...structuredClone(a), capturedAt: '2026-10-18T16:00:00.000Z' };
  const p = await store(t, [a, b, c]), { plan } = await apply(p, '1');
  assert.deepEqual(plan.observations.map(o => o.newOrdinal), [1, null, 2]);
  assert.equal(plan.identity.chainId, a.chainId); assert.equal(plan.observations[2].block.number, a.block.number);
  const timeline = await historyTimeline(p.output);
  assert.equal(timeline.transitions[0].changed, false);
  assert.equal(timeline.retention.sourceCommitted, 3); assert.deepEqual(timeline.retention.ordinals, [1, 3]);
  assert.match(timeline.caveats.at(-1), /excluded observations may contain changes/);
});

test('v2 copies support add/recover/verify and another explicit retention without losing their prefix mapping', async t => {
  const p = await store(t, inputs); await apply(p, '1');
  const header = await fs.readFile(join(p.output, 'index.json'));
  const extra = next(inputs[4]), source = join(p.parent, 'extra.json'); await fs.writeFile(source, json(extra));
  await fs.writeFile(join(p.output, snapshotName(extra)), json(extra));
  assert.equal((await historyOperation({ operation: 'recover', directory: p.output, input: source })).ordinal, 3);
  assert.equal((await historyOperation({ operation: 'add', directory: p.output, input: source })).status, 'already-present');
  assert.deepEqual(await fs.readFile(join(p.output, 'index.json')), header);
  const timeline = await historyTimeline(p.output); assert.equal(timeline.committed, 3); assert.deepEqual(timeline.retention.ordinals, [1, 5]);
  const second = { ...p, directory: p.output, output: join(p.parent, 'second') };
  const { result } = await apply(second, '1'); assert.deepEqual(result.retention.ordinals, [1, 3]);
  assert.equal((await verify(p.directory)).committed, 5); assert.equal((await verify(p.output)).committed, 3);
});

for (const mutation of ['append', 'stage-content', 'stage-added', 'pending-added', 'chmod', 'mtime', 'tail-encoding', 'directory-copy', 'policy', 'token']) test(`stale/substituted plan refuses ${mutation} before destination creation`, async t => {
  const p = await store(t, inputs, { stages: ['one'] }), plan = await pruneHistory(options(p));
  let keepLast = '2', token = plan.planId;
  if (mutation === 'append') { const source = join(p.parent, 'extra.json'); await fs.writeFile(source, json(next(inputs[4]))); await historyOperation({ operation: 'add', directory: p.directory, input: source }); }
  if (mutation === 'stage-content') await fs.writeFile(join(p.directory, stageName(0)), 'two');
  if (mutation === 'stage-added') await fs.writeFile(join(p.directory, stageName(1)), '');
  if (mutation === 'pending-added') await fs.writeFile(join(p.directory, snapshotName(next(inputs[4]))), json(next(inputs[4])));
  if (mutation === 'chmod') await fs.chmod(join(p.directory, snapshotName(inputs[0])), 0o400);
  if (mutation === 'mtime') await fs.utimes(join(p.directory, snapshotName(inputs[0])), 1, 1);
  if (mutation === 'tail-encoding') await fs.appendFile(join(p.directory, 'entry-0005.json'), ' ');
  if (mutation === 'directory-copy') { await fs.rename(p.directory, p.directory + '-backup'); await fs.cp(p.directory + '-backup', p.directory, { recursive: true, preserveTimestamps: true }); }
  if (mutation === 'policy') keepLast = '1';
  if (mutation === 'token') token = '0'.repeat(64);
  await preserved(p.directory, async () => failure(await cli(args(p, keepLast, token)), 'RETENTION_PLAN'));
  await missing(p.output);
});

for (const kind of ['foreign', 'corrupt-pending', 'missing', 'entry-gap', 'entry-hash', 'identity', 'duplicate-key', 'bom', 'utf8', 'deep', 'snapshot-link', 'stage-link', 'fifo', 'subdirectory']) test(`retention refuses ${kind} and preserves unrelated data`, async t => {
  const p = await store(t, inputs), file = join(p.directory, snapshotName(inputs[0]));
  if (kind === 'foreign') await fs.writeFile(join(p.directory, 'PRIVATE_unknown'), 'keep');
  if (kind === 'corrupt-pending') await fs.writeFile(join(p.directory, `snapshot-${'a'.repeat(64)}.json`), '{PRIVATE');
  if (kind === 'missing') await fs.unlink(file);
  if (kind === 'entry-gap') await fs.unlink(join(p.directory, 'entry-0002.json'));
  if (kind === 'entry-hash') { const path = join(p.directory, 'entry-0001.json'), value = JSON.parse(await fs.readFile(path)); value.previous = 'f'.repeat(64); await fs.writeFile(path, json(value)); }
  if (kind === 'identity') { const path = join(p.directory, 'index.json'), value = JSON.parse(await fs.readFile(path)); value.identity.chainId = '2'; await fs.writeFile(path, json(value)); }
  if (kind === 'duplicate-key') await fs.writeFile(file, '{"schemaVersion":2,' + json(inputs[0]).slice(1));
  if (kind === 'bom') await fs.writeFile(file, '\ufeff' + json(inputs[0]));
  if (kind === 'utf8') await fs.writeFile(file, Buffer.from([0xff]));
  if (kind === 'deep') await fs.writeFile(file, '['.repeat(10000) + '0' + ']'.repeat(10000));
  if (kind === 'snapshot-link') { await fs.rename(file, join(p.parent, 'PRIVATE_original')); await fs.symlink(join(p.parent, 'PRIVATE_original'), file); }
  if (kind === 'stage-link') await fs.symlink(file, join(p.directory, stageName(0)));
  if (kind === 'fifo') { await fs.unlink(file); execFileSync('mkfifo', [file], { cwd: ROOT }); }
  if (kind === 'subdirectory') { await fs.unlink(file); await fs.mkdir(file); }
  await preserved(p.directory, async () => {
    for (const token of [undefined, '0'.repeat(64)]) failure(await cli(args(p, '2', token)), kind === 'foreign' ? 'HISTORY_DIRECTORY' : 'HISTORY_CORRUPT');
  });
  await missing(p.output);
});

for (const [label, limit, version] of [['snapshot-v1', 512 * 1024, 1], ['snapshot-v2', 768 * 1024, 2], ['index', 4096, 2], ['stage', 768 * 1024, 2]]) for (const extra of [0, 1]) test(`retention ${label} byte bound +${extra}`, async t => {
  const value = version === 1 ? fixture() : inputs[0], padded = v => json(v).padEnd(limit + extra, ' ');
  const p = await store(t, [value], label === 'index' ? { indexBytes: padded } : label === 'stage' ? { stages: [Buffer.alloc(limit + extra)] } : { bytes: padded });
  if (extra) { failure(await cli(args(p)), 'HISTORY_CORRUPT'); await missing(p.output); }
  else await preserved(p.directory, async () => { const { result } = await apply(p); assert.equal(result.retained, 1); });
});

for (const count of [128, 129]) test(`retention observation count ${count}`, async t => {
  const p = await store(t, Array.from({ length: count }, (_, i) => next(fixture(), i + 1)));
  if (count === 129) failure(await cli(args(p, '128')), 'HISTORY_LIMIT');
  else { const { result } = await apply(p, '128'); assert.equal(result.retained, 128); assert.equal((await verify(p.output)).committed, 128); }
});
for (const count of [512, 513]) test(`retention directory count ${count}`, async t => {
  const p = await store(t, [], { stages: Array.from({ length: count - 1 }, () => '') });
  if (count === 513) failure(await cli(args(p)), 'HISTORY_LIMIT');
  else { const { result } = await apply(p, '0'); assert.equal(result.retention.sourceStaged, 511); assert.equal((await verify(p.output)).committed, 0); }
});

for (const n of ['00', '01', '129', '256', '1.0', '1e0', '0x1', '+1', ' 1', '1 ', '999999999999999999999999999999']) test(`strict keep-last rejects ${JSON.stringify(n)}`, async () => {
  failure(await cli(['history', 'prune', '--dir', 'PRIVATE_missing', '--keep-last', n]), 'RETENTION_KEEP');
});
for (const extra of [[], ['--keep-last', '1'], ['--apply', 'a'], ['--apply', '0'.repeat(64)], ['--out-dir', 'PRIVATE'], ['--json'], ['--exit-code'], ['--rpc', 'https://PRIVATE'], ['--config', 'PRIVATE'], ['--target', 'PRIVATE'], ['--apply=true'], ['PRIVATE'], ['toString', 'PRIVATE'], ['constructor', 'PRIVATE'], ['__proto__', 'PRIVATE']]) test(`prune CLI rejects conflicts/unsupported flags ${JSON.stringify(extra)}`, async t => {
  const p = await store(t, inputs);
  failure(await cli(extra.length ? [...args(p), ...extra] : ['history', 'prune']), 'USAGE');
});

for (const kind of ['directory', 'file', 'symlink', 'hardlink', 'inside-source', 'source-alias']) test(`apply refuses destination ${kind} without overwrite`, async t => {
  const p = await store(t, inputs), plan = await pruneHistory(options(p));
  if (kind === 'directory') await fs.mkdir(p.output);
  if (kind === 'file') await fs.writeFile(p.output, 'PRIVATE keep');
  if (kind === 'symlink') await fs.symlink(p.directory, p.output);
  if (kind === 'hardlink') await fs.link(join(p.directory, snapshotName(inputs[0])), p.output);
  if (kind === 'inside-source') p.output = join(p.directory, 'new');
  if (kind === 'source-alias') { const alias = join(p.parent, 'alias'); await fs.symlink(p.parent, alias); p.output = join(alias, 'PRIVATE_history', 'new'); }
  // A hard link changes source nlink/ctime, so explicitly preview its new state.
  const token = kind === 'hardlink' ? (await pruneHistory(options(p))).planId : plan.planId;
  await preserved(p.parent, async () => failure(await cli(args(p, '2', token)), ['inside-source', 'source-alias'].includes(kind) ? 'RETENTION_DESTINATION' : 'HISTORY_EXISTS'));
});

test('regular hard-linked source remains unchanged and copy is an independent inode', async t => {
  const p = await store(t, [fixture()]), alias = join(p.parent, 'alias.json');
  await fs.link(join(p.directory, snapshotName(fixture())), alias);
  await preserved(alias, async () => { await preserved(p.directory, () => apply(p)); });
  assert.notEqual((await fs.stat(alias)).ino, (await fs.stat(join(p.output, snapshotName(fixture())))).ino);
});

test('source directory symlink and missing source are rejected', async t => {
  const p = await store(t, inputs), alias = join(p.parent, 'PRIVATE_alias'); await fs.symlink(p.directory, alias);
  for (const directory of [alias, join(p.parent, 'missing')]) failure(await cli(args({ ...p, directory })), 'HISTORY_DIRECTORY');
});

test('maximum target and implementation bytecode survives exact copy with unknown genesis', async t => {
  const value = { ...variants().at(-1), code: `0x${'60'.repeat(128 * 1024)}` };
  value.implementation = { ...value.implementation, code: `0x${'61'.repeat(128 * 1024)}` };
  const p = await store(t, [value]);
  await preserved(p.directory, async () => {
    await apply(p);
    assert.deepEqual(await fs.readFile(join(p.output, snapshotName(value))), await fs.readFile(join(p.directory, snapshotName(value))));
  });
});
