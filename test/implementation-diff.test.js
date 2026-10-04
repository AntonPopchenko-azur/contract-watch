import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { diffDocument, diffReport, compare } from '../src/report.js';
import { validateSnapshot, MAX_SNAPSHOT_V2_BYTES } from '../src/snapshot.js';
import { MAX_CODE_BYTES } from '../src/validate.js';
import { cli, fakeRpc, temporaryDirectory, EMPTY, word, fixture } from './helpers/fake-rpc.js';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const beforeExample = await readJson('../examples/beacon-before-v2.json');
const afterExample = await readJson('../examples/beacon-after-v2.json');
const expectedExample = await readJson('./fixtures/json-diff-v2/beacon-change.json');
const expectedText = await readFile(new URL('./fixtures/json-diff-v2/beacon-change.txt', import.meta.url), 'utf8');
const OTHER = `0x${'44'.repeat(20)}`;
const CODE = '0x60056006';
const formats = [[], ['--json'], ['--exit-code'], ['--json', '--exit-code']];
const details = code => ({ bytes: (code.length - 2) / 2, sha256: createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex') });
function pair() {
  const before = structuredClone(beforeExample);
  return [before, { ...structuredClone(before), block: structuredClone(afterExample.block) }];
}
function implementation(snapshot, address, code) {
  snapshot.implementation.address = address;
  snapshot.implementation.code = code;
  snapshot.implementation.status = code === '0x' ? 'no-code' : 'observed';
  if (snapshot.implementation.via === 'beacon') snapshot.implementation.raw = word(address);
  else snapshot.slots.implementation = word(address);
}
function direct(snapshot) {
  snapshot.slots = { ...snapshot.slots, implementation: word(snapshot.implementation.address), beacon: EMPTY };
  snapshot.implementation.via = 'implementation-slot';
  delete snapshot.implementation.beacon;
  delete snapshot.implementation.raw;
}
function emptySlots(snapshot) {
  snapshot.slots = { implementation: EMPTY, admin: EMPTY, beacon: EMPTY };
  snapshot.implementation = { status: 'skipped', reason: 'EMPTY_SLOTS' };
}
function noTarget(snapshot) {
  snapshot.code = '0x';
  snapshot.implementation = { status: 'skipped', reason: 'NO_TARGET_CODE' };
}
async function files(t, before, after) {
  const dir = await temporaryDirectory(t);
  const paths = [join(dir, 'PRIVATE_BEFORE.json'), join(dir, 'PRIVATE_AFTER.json')];
  await writeFile(paths[0], JSON.stringify(before));
  await writeFile(paths[1], JSON.stringify(after));
  return { dir, paths };
}
function failure(output, code) {
  assert.equal(output.code, 1);
  assert.equal(output.stdout, '');
  assert.ok(output.stderr.startsWith(`Error [${code}]: `), output.stderr);
  assert.doesNotMatch(output.stderr, /PRIVATE_|https?:|\.json|\u001b|at .*\.js/);
}

test('unchanged beacon and target expose implementation changes in independent golden text/JSON fixtures', async t => {
  assert.deepEqual(beforeExample.slots, afterExample.slots);
  assert.equal(beforeExample.code, afterExample.code);
  assert.deepEqual(diffDocument(beforeExample, afterExample), expectedExample);
  assert.equal(`${diffReport(beforeExample, afterExample)}\n`, expectedText);
  const { paths } = await files(t, beforeExample, afterExample);
  for (const flags of formats) {
    const output = await cli(['diff', ...flags, ...paths]);
    assert.equal(output.code, flags.includes('--exit-code') ? 2 : 0, output.stderr);
    assert.equal(output.stderr, '');
    assert.equal(output.stdout, flags.includes('--json') ? `${JSON.stringify(expectedExample, null, 2)}\n` : expectedText);
  }
  const result = compare(beforeExample, afterExample);
  assert.equal(result.changed, true);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.implementation, expectedExample.implementation);
});

test('v2 comparison semantics keep target changes separate from comparable implementation changes', async t => {
  const cases = [
    ['unchanged beacon', () => {}, [], [], 'comparable'],
    ['beacon address only', (b, a) => implementation(a, OTHER, b.implementation.code), [], ['address'], 'comparable'],
    ['same address different code', (b, a) => implementation(a, b.implementation.address, CODE), [], ['code'], 'comparable'],
    ['beacon address and code', (b, a) => implementation(a, OTHER, CODE), [], ['address', 'code'], 'comparable'],
    ['no-code to observed', (b) => implementation(b, b.implementation.address, '0x'), [], ['code'], 'comparable'],
    ['observed to no-code', (b, a) => implementation(a, a.implementation.address, '0x'), [], ['code'], 'comparable'],
    ['both no-code', (b, a) => { implementation(b, b.implementation.address, '0x'); implementation(a, a.implementation.address, '0x'); }, [], [], 'comparable'],
    ['different addresses both no-code', (b, a) => { implementation(b, b.implementation.address, '0x'); implementation(a, OTHER, '0x'); }, [], ['address'], 'comparable'],
    ['direct code change', (b, a) => { direct(b); direct(a); implementation(a, a.implementation.address, CODE); }, [], ['code'], 'comparable'],
    ['direct address and code', (b, a) => { direct(b); direct(a); implementation(a, OTHER, CODE); }, ['implementation'], ['address', 'code'], 'comparable'],
    ['same skips', (b, a) => { emptySlots(b); emptySlots(a); }, [], [], 'unavailable'],
    ['different skips', (b, a) => { emptySlots(b); emptySlots(a); noTarget(a); }, ['code'], [], 'unavailable'],
    ['skip becomes observed', (b) => emptySlots(b), ['beacon'], [], 'unavailable'],
    ['observation becomes skipped', (b, a) => noTarget(a), ['code'], [], 'unavailable'],
    ['different beacon same implementation', (b, a) => { a.slots.beacon = word(OTHER); a.implementation.beacon = OTHER; }, ['beacon'], [], 'provenance-changed'],
    ['different beacon and implementation', (b, a) => { a.slots.beacon = word(OTHER); a.implementation.beacon = OTHER; implementation(a, OTHER, CODE); }, ['beacon'], [], 'provenance-changed'],
    ['beacon to direct', (b, a) => direct(a), ['implementation', 'beacon'], [], 'provenance-changed'],
    ['direct to beacon different implementation', (b, a) => { direct(b); implementation(a, OTHER, CODE); }, ['implementation', 'beacon'], [], 'provenance-changed'],
    ['combined target admin and implementation', (b, a) => { a.code = '0x60'; a.slots.admin = word(OTHER); implementation(a, OTHER, CODE); }, ['code', 'admin'], ['address', 'code'], 'comparable'],
    ['noncanonical raw slot', (b, a) => { emptySlots(b); emptySlots(a); a.slots.admin = `0x01${'00'.repeat(31)}`; a.implementation.reason = 'NONCANONICAL_SLOT'; }, ['admin'], [], 'unavailable']
  ];
  for (const [name, mutate, targetFields, implementationFields, comparison] of cases) await t.test(name, async t => {
    const [before, after] = pair(); mutate(before, after);
    validateSnapshot(before); validateSnapshot(after);
    const original = JSON.stringify({ before, after });
    const document = diffDocument(before, after);
    const changed = targetFields.length > 0 || implementationFields.length > 0;
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.changed, changed);
    assert.deepEqual(document.changes.map(c => c.field), targetFields);
    assert.deepEqual(document.implementation.changes.map(c => c.field), implementationFields);
    assert.equal(document.implementation.comparison, comparison);
    assert.deepEqual(document.notices, []);
    assert.equal(JSON.stringify({ before, after }), original);
    for (const [side, snapshot] of [['before', before], ['after', after]]) {
      const endpoint = document.implementation[side];
      assert.equal(endpoint.status, snapshot.implementation.status);
      if (endpoint.status === 'skipped') assert.deepEqual(endpoint, snapshot.implementation);
      else assert.deepEqual(endpoint, { ...snapshot.implementation, code: details(snapshot.implementation.code) });
    }
    const { paths } = await files(t, before, after);
    for (const flags of formats) {
      const output = await cli(['diff', ...flags, ...paths]);
      assert.equal(output.code, flags.includes('--exit-code') && changed ? 2 : 0, output.stderr);
      assert.equal(output.stderr, '');
      if (flags.includes('--json')) assert.deepEqual(JSON.parse(output.stdout), document);
      else {
        assert.equal(output.stdout, `${diffReport(before, after)}\n`);
        assert.match(output.stdout, /do not prove an upgrade transaction/);
        if (comparison !== 'comparable') {
          assert.match(output.stdout, /Implementation not compared:/);
          assert.doesNotMatch(output.stdout, /No implementation address or code changes observed|Implementation code: .* ->/);
        }
      }
    }
  });
});

test('fork and same-hash notices cover implementation observations without changing exit semantics', async t => {
  for (const [name, mutate, changed, notices] of [
    ['fork unchanged', (b, a) => { a.block.number = b.block.number; }, false, ['SAME_HEIGHT_DIFFERENT_HASH']],
    ['fork changed implementation', (b, a) => { a.block.number = b.block.number; implementation(a, OTHER, CODE); }, true, ['SAME_HEIGHT_DIFFERENT_HASH']],
    ['same hash changed implementation', (b, a) => { a.block = { ...b.block }; implementation(a, OTHER, CODE); }, true, ['INCONSISTENT_BLOCK_DATA']],
    ['same hash changed code', (b, a) => { a.block = { ...b.block }; implementation(a, a.implementation.address, CODE); }, true, ['INCONSISTENT_BLOCK_DATA']],
    ['same hash wrong height only', (b, a) => { a.block.hash = b.block.hash; }, false, ['INCONSISTENT_BLOCK_DATA']],
    ['same hash changed availability', (b, a) => { a.block = { ...b.block }; noTarget(a); }, true, ['INCONSISTENT_BLOCK_DATA']],
    ['same hash changed provenance', (b, a) => { a.block = { ...b.block }; direct(a); }, true, ['INCONSISTENT_BLOCK_DATA']],
    ['same block reordered keys', (b, a) => { a.block = { ...b.block }; a.implementation = Object.fromEntries(Object.entries(a.implementation).reverse()); }, false, []]
  ]) await t.test(name, async t => {
    const [before, after] = pair(); mutate(before, after);
    const document = diffDocument(before, after);
    assert.equal(document.changed, changed);
    assert.deepEqual(document.notices, notices);
    const { paths } = await files(t, before, after);
    for (const flags of [['--exit-code'], ['--json', '--exit-code']]) {
      const output = await cli(['diff', ...flags, ...paths]);
      assert.equal(output.code, changed ? 2 : 0, output.stderr);
      if (flags.includes('--json')) assert.deepEqual(JSON.parse(output.stdout).notices, notices);
    }
  });
});

test('large chain IDs and heights remain exact; capture time alone is not state', () => {
  const [before, after] = pair();
  before.chainId = after.chainId = (2n ** 256n - 1n).toString();
  before.block.number = `0x${(2n ** 256n - 2n).toString(16)}`;
  after.block.number = `0x${(2n ** 256n - 1n).toString(16)}`;
  const expected = diffDocument(before, after);
  assert.equal(expected.changed, false);
  before.capturedAt = after.capturedAt; // Metadata cannot create a change.
  after.capturedAt = '2026-10-04T00:00:00.000Z';
  assert.deepEqual(diffDocument(before, after), expected);
  assert.equal(expected.chainId, before.chainId);
  assert.equal(expected.blocks.before.number, before.block.number);
  assert.ok(diffReport(before, after).includes(`Blocks: ${2n ** 256n - 2n} -> ${2n ** 256n - 1n}`));
  assert.throws(() => diffDocument(after, before), { code: 'ORDER' });
});

test('v2 diff is offline and preserves inputs and filesystem contents in every format', async t => {
  const { dir, paths } = await files(t, beforeExample, afterExample);
  const fake = await fakeRpc(t);
  const originals = await Promise.all(paths.map(p => readFile(p, 'utf8')));
  const metadata = await Promise.all(paths.map(p => stat(p)));
  for (const flags of formats) {
    const output = await cli(['diff', ...flags, ...paths], { CONTRACT_WATCH_RPC_URL: `${fake.url}/PRIVATE_KEY?apiKey=PRIVATE_KEY` });
    assert.equal(output.code, flags.includes('--exit-code') ? 2 : 0, output.stderr);
    assert.doesNotMatch(output.stdout + output.stderr, /PRIVATE_|https?:|capturedAt|\.json/);
  }
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p, 'utf8'))), originals);
  const after = await Promise.all(paths.map(p => stat(p)));
  for (let i = 0; i < paths.length; i++) {
    assert.equal(after[i].mtimeMs, metadata[i].mtimeMs);
    assert.equal(after[i].size, metadata[i].size);
  }
  assert.deepEqual((await readdir(dir)).sort(), ['PRIVATE_AFTER.json', 'PRIVATE_BEFORE.json']);
});

test('v2 validation, compatibility, version and read errors are safe in all output/exit modes', async t => {
  const cases = [
    ['chain', 'INCOMPARABLE', a => { a.chainId = '2'; }],
    ['target', 'INCOMPARABLE', a => { a.address = OTHER; }],
    ['source', 'INCOMPARABLE', a => { a.source = 'rpc'; }],
    ['order', 'ORDER', a => { a.block.number = '0x1'; }],
    ['unknown version', 'SNAPSHOT', a => { a.schemaVersion = 3; }],
    ['unknown root', 'SNAPSHOT', a => { a.rpcUrl = 'https://PRIVATE_KEY'; }],
    ['unknown block', 'SNAPSHOT', a => { a.block.secret = 'PRIVATE_KEY'; }],
    ['unknown slot', 'SNAPSHOT', a => { a.slots.secret = 'PRIVATE_KEY'; }],
    ['unknown observation', 'SNAPSHOT', a => { a.implementation.error = 'PRIVATE_PROVIDER_ERROR'; }],
    ['missing observation', 'SNAPSHOT', a => { delete a.implementation; }],
    ['invalid provenance', 'SNAPSHOT', a => { a.implementation.beacon = OTHER; }],
    ['invalid raw return', 'SNAPSHOT', a => { a.implementation.raw = EMPTY; }],
    ['invalid status', 'SNAPSHOT', a => { a.implementation.status = 'no-code'; }],
    ['invalid skip', 'SNAPSHOT', a => { a.implementation = { status: 'skipped', reason: 'PRIVATE_REASON' }; }],
    ['invalid code', 'SNAPSHOT', a => { a.implementation.code = '\u001b[31mPRIVATE_CODE'; }],
    ['oversize implementation', 'SNAPSHOT', a => { a.implementation.code = `0x${'60'.repeat(MAX_CODE_BYTES + 1)}`; }],
    ['oversize target', 'SNAPSHOT', a => { a.code = `0x${'60'.repeat(MAX_CODE_BYTES + 1)}`; }]
  ];
  for (const [name, code, mutate] of cases) await t.test(name, async t => {
    const [before, after] = pair(); mutate(after);
    const { paths } = await files(t, before, after);
    for (const flags of formats) failure(await cli(['diff', ...flags, ...paths]), code);
  });
  for (const [before, after] of [[beforeExample, fixture()], [fixture(), afterExample]]) {
    const { paths } = await files(t, before, after);
    for (const flags of formats) failure(await cli(['diff', ...flags, ...paths]), 'DIFF_VERSION');
  }
  const { paths } = await files(t, beforeExample, afterExample);
  for (const [body, code] of [['{PRIVATE_INVALID_JSON', 'SNAPSHOT'], [' '.repeat(MAX_SNAPSHOT_V2_BYTES + 1), 'FILE_READ']]) {
    await writeFile(paths[1], body);
    for (const flags of formats) failure(await cli(['diff', ...flags, ...paths]), code);
  }
  for (const flags of formats) failure(await cli(['diff', ...flags, paths[0], `${paths[1]}.missing`]), 'FILE_READ');
});

test('maximum code and exact v2 file size remain readable without dumping bytecode into reports', async t => {
  const [before, after] = pair();
  for (const s of [before, after]) {
    s.code = `0x${'60'.repeat(MAX_CODE_BYTES)}`;
    implementation(s, s.implementation.address, `0x${'61'.repeat(MAX_CODE_BYTES)}`);
  }
  after.implementation.code = `${after.implementation.code.slice(0, -2)}62`;
  const { paths } = await files(t, before, after);
  for (const path of paths) await writeFile(path, (await readFile(path, 'utf8')).padEnd(MAX_SNAPSHOT_V2_BYTES, ' '));
  const output = await cli(['diff', '--json', '--exit-code', ...paths]);
  assert.equal(output.code, 2, output.stderr);
  assert.ok(output.stdout.length < 4000);
  const document = JSON.parse(output.stdout);
  assert.equal(document.implementation.before.code.bytes, MAX_CODE_BYTES);
  assert.deepEqual(document.implementation.changes.map(c => c.field), ['code']);
  assert.deepEqual(document.changes, []);
});

test('v2 flags remain positional and reject duplicates or capture options before output', async t => {
  const { paths } = await files(t, beforeExample, afterExample);
  for (const args of [[paths[0], '--json', paths[1], '--exit-code'], ['--exit-code', ...paths, '--json']]) {
    const output = await cli(['diff', ...args]);
    assert.equal(output.code, 2, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout), expectedExample);
  }
  for (const flags of [['--json', '--json'], ['--exit-code', '--exit-code'], ['--implementation-code'],
    ['--rpc', 'https://PRIVATE_KEY'], ['--json=true']]) failure(await cli(['diff', ...flags, ...paths]), 'USAGE');
});
