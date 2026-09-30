import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, symlink, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readSnapshot, saveSnapshot, validateSnapshot, MAX_SNAPSHOT_BYTES } from '../src/snapshot.js';
import { compare, diffReport, snapshotReport, slotValue, observation } from '../src/report.js';
import { fixture, temporaryDirectory, EMPTY, word, IMPLEMENTATION } from './helpers/fake-rpc.js';

test('writes a complete versioned snapshot with private permissions and round-trips it', async t => {
  const dir = await temporaryDirectory(t);
  const target = join(dir, 'snapshot.json');
  const original = fixture();
  await saveSnapshot(target, original);
  assert.deepEqual(await readSnapshot(target), original);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['snapshot.json']);
  assert.ok(!JSON.stringify(await readSnapshot(target)).includes('rpcUrl'));
});

test('refuses existing files and symlinks without changing them or leaving temporary files', async t => {
  const dir = await temporaryDirectory(t);
  const original = join(dir, 'original.json');
  const alias = join(dir, 'alias.json');
  await writeFile(original, 'keep my changes');
  await symlink(original, alias);
  for (const path of [original, alias]) await assert.rejects(saveSnapshot(path, fixture()), { code: 'FILE_EXISTS' });
  assert.equal(await readFile(original, 'utf8'), 'keep my changes');
  assert.deepEqual((await readdir(dir)).sort(), ['alias.json', 'original.json']);
});

test('concurrent snapshot writers publish exactly one intact file', async t => {
  const dir = await temporaryDirectory(t);
  const target = join(dir, 'race.json');
  const first = fixture();
  const second = fixture(); second.code = '0x00';
  const results = await Promise.allSettled([saveSnapshot(target, first), saveSnapshot(target, second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'FILE_EXISTS');
  const saved = await readSnapshot(target);
  assert.ok(saved.code === first.code || saved.code === second.code);
  assert.deepEqual(await readdir(dir), ['race.json']);
});

test('handles missing parents, existing directories, invalid JSON, large and non-file inputs', async t => {
  const dir = await temporaryDirectory(t);
  await assert.rejects(saveSnapshot(join(dir, 'missing', 's.json'), fixture()), { code: 'FILE_WRITE' });
  const folder = join(dir, 'folder'); await mkdir(folder);
  await assert.rejects(saveSnapshot(folder, fixture()), { code: 'FILE_EXISTS' });
  await assert.rejects(readSnapshot(folder), { code: 'FILE_READ' });
  await assert.rejects(readSnapshot(join(dir, 'missing.json')), { code: 'FILE_READ' });
  const invalid = join(dir, 'invalid.json'); await writeFile(invalid, '{secret');
  await assert.rejects(readSnapshot(invalid), { code: 'SNAPSHOT' });
  const large = join(dir, 'large.json'); await writeFile(large, ' '.repeat(MAX_SNAPSHOT_BYTES + 1));
  await assert.rejects(readSnapshot(large), { code: 'FILE_READ' });
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('rejects unsupported schemas, extra secret fields, malformed canonical data and dates', () => {
  for (const mutate of [
    value => { value.schemaVersion = 2; }, value => { value.rpcUrl = 'https://secret'; },
    value => { value.slots.secret = 'secret'; }, value => { value.chainId = '0x1'; },
    value => { value.address = 'hello'; }, value => { value.slots.admin = '0x0'; },
    value => { value.code = '0xz'; }, value => { value.block.number = '0x01'; },
    value => { value.block.hash = `0x${'AB'.repeat(32)}`; },
    value => { value.capturedAt = '2026-02-30T10:00:00.000Z'; },
    value => { value.source = 'https://secret'; }, value => { delete value.slots.beacon; }
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => validateSnapshot(value), { code: 'SNAPSHOT' });
  }
  assert.throws(() => validateSnapshot(null), { code: 'SNAPSHOT' });
});

test('diff detects implementation/admin/beacon additions and removals and same-size code changes', () => {
  const before = fixture();
  const after = fixture();
  after.block = { number: '0x65', hash: `0x${'cd'.repeat(32)}` };
  after.code = '0x60016000';
  after.slots = { implementation: EMPTY, admin: word(IMPLEMENTATION), beacon: word(IMPLEMENTATION) };
  const result = compare(before, after);
  assert.deepEqual(result.changes.map(change => change.field), ['code', 'implementation', 'admin', 'beacon']);
  assert.equal(result.changes[1].after, 'empty');
  const report = diffReport(before, after);
  assert.match(report, /Blocks: 100 -> 101/);
  assert.match(report, /implementation: 0x2+ -> empty/);
  assert.match(report, /admin: empty -> 0x2+/);
  assert.match(report, /synthetic \(demonstration only\)/);
});

test('metadata changes do not masquerade as contract changes', () => {
  const before = fixture(); const after = fixture();
  after.capturedAt = '2026-09-30T12:00:00.000Z';
  after.block = { number: '0x65', hash: `0x${'cd'.repeat(32)}` };
  assert.equal(compare(before, after).changes.length, 0);
  assert.match(diffReport(before, after), /No code or EIP-1967 slot changes/);
});

test('rejects cross-target, cross-source and backwards comparisons, flags fork/inconsistent data', () => {
  const before = fixture();
  for (const mutate of [value => { value.chainId = '2'; }, value => { value.address = IMPLEMENTATION; }, value => { value.source = 'rpc'; }]) {
    const after = fixture(); mutate(after);
    assert.throws(() => compare(before, after), { code: 'INCOMPARABLE' });
  }
  const earlier = fixture(); earlier.block.number = '0x63';
  assert.throws(() => compare(before, earlier), { code: 'ORDER' });
  const fork = fixture(); fork.block.hash = `0x${'cd'.repeat(32)}`;
  assert.match(diffReport(before, fork), /possible reorg/);
  const conflict = fixture(); conflict.code = '0x';
  assert.match(diffReport(before, conflict), /inconsistent data/);
});

test('reports empty, beacon, conflicting, admin-only and noncanonical slot evidence honestly', () => {
  const value = fixture();
  assert.equal(slotValue(EMPTY), 'empty');
  assert.equal(slotValue(word(IMPLEMENTATION)), IMPLEMENTATION);
  assert.match(snapshotReport(value), /proxy behavior unverified/);
  value.slots.beacon = word(IMPLEMENTATION);
  assert.match(observation(value), /ambiguous/);
  value.slots.implementation = EMPTY;
  assert.match(observation(value), /implementation is not resolved/);
  value.slots.beacon = EMPTY;
  value.slots.admin = word(IMPLEMENTATION);
  assert.match(observation(value), /Admin slot only/);
  value.slots.admin = EMPTY;
  assert.match(observation(value), /other proxy patterns may exist/);
  value.slots.admin = `0x01${'0'.repeat(62)}`;
  assert.match(snapshotReport(value), /noncanonical word 0x01/);
  assert.match(observation(value), /Noncanonical/);
  value.code = '0x';
  assert.match(observation(value), /No code at this block/);
});
