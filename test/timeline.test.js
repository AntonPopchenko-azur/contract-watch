import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { historyTimeline, timelineReport } from '../src/timeline.js';
import { historyOperation } from '../src/history.js';
import { temporaryDirectory, cli, fixture, ROOT, EMPTY, word, IMPLEMENTATION } from './helpers/fake-rpc.js';

const read = name => fs.readFile(new URL(`./fixtures/timeline/${name}`, import.meta.url), 'utf8');
const inputs = JSON.parse(await read('inputs.json'));
const expected = JSON.parse(await read('expected.json'));
const text = await read('expected.txt');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
// Independent fixture writer: construct the documented store directly, without
// history init/add, production canonicalization, migration or report builders.
function sorted(value) {
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
}
const id = value => hash(JSON.stringify(sorted(value)));
const name = value => `snapshot-${id(value)}.json`;
const next = (value, n = 1) => ({ ...structuredClone(value),
  capturedAt: new Date(Date.parse(value.capturedAt) + n * 1000).toISOString(),
  block: { number: `0x${(BigInt(value.block.number) + BigInt(n)).toString(16)}`, hash: `0x${n.toString(16).padStart(64, '0')}` } });
async function store(t, values = inputs, { pending = [], seed = values[0] ?? fixture(), bytes = json, indexBytes = json } = {}) {
  const parent = await temporaryDirectory(t), directory = join(parent, 'PRIVATE_history');
  await fs.mkdir(directory, { mode: 0o700 });
  const identity = { address: seed.address, chainId: seed.chainId, source: seed.source,
    snapshotVersion: seed.schemaVersion, genesis: seed.genesis ?? { status: 'not-recorded' } };
  const header = indexBytes({ kind: 'contract-watch-history', schemaVersion: 1, identity });
  await fs.writeFile(join(directory, 'index.json'), header, { mode: 0o600 });
  let previous = hash(header);
  for (const [i, value] of [...values, ...pending].entries()) {
    const raw = bytes(value);
    await fs.writeFile(join(directory, name(value)), raw, { mode: 0o600 });
    if (i >= values.length) continue;
    const entry = indexBytes({ kind: 'contract-watch-history-entry', schemaVersion: 1,
      ordinal: i + 1, previous, observationId: id(value), snapshot: name(value),
      sha256: hash(raw), bytes: Buffer.byteLength(raw), capturedAt: value.capturedAt, block: value.block });
    await fs.writeFile(join(directory, `entry-${String(i + 1).padStart(4, '0')}.json`), entry, { mode: 0o600 });
    previous = hash(entry);
  }
  return { parent, directory, args: ['history', 'timeline', '--dir', directory] };
}
function failure(result, code) {
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]: [^\\n]+\\n$`));
  assert.doesNotMatch(result.stderr, /PRIVATE|https?:|\.json|at .*\.js|\u001b/);
}
async function preserved(directory, action) {
  const paths = [directory, ...(await fs.readdir(directory)).sort().map(n => join(directory, n))];
  const capture = () => Promise.all(paths.map(async path => {
    const s = await fs.lstat(path, { bigint: true });
    return { path, mode: s.mode, ino: s.ino, size: s.size, mtime: s.mtimeNs,
      bytes: s.isFile() ? await fs.readFile(path) : null };
  }));
  const before = await capture();
  await action();
  assert.deepEqual(await capture(), before);
  assert.deepEqual((await fs.readdir(directory)).sort(), paths.slice(1).map(p => p.slice(directory.length + 1)));
}

test('independent synthetic text/JSON golden: separate target and implementation transitions', async t => {
  const p = await store(t);
  await preserved(p.directory, async () => {
    assert.deepEqual(await historyTimeline(p.directory), expected);
    assert.equal(`${timelineReport(expected)}\n`, text);
    for (const flags of [[], ['--json']]) {
      const result = await cli([...p.args, ...flags]);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
      assert.equal(result.stdout, flags.length ? json(expected) : text);
      assert.doesNotMatch(result.stdout, /PRIVATE|snapshot-[a-f0-9]+\.json|0x6[0-3](?:"|\s|$)/);
    }
  });
});

for (const count of [0, 1]) test(`timeline with ${count} committed observations has no invented pairs`, async t => {
  const p = await store(t, inputs.slice(0, count));
  const d = await historyTimeline(p.directory);
  assert.equal(d.committed, count); assert.equal(d.observations.length, count);
  assert.deepEqual(d.transitions, []); assert.deepEqual(d.notices, []);
  assert.match(timelineReport(d), /No adjacent pairs to compare/);
  if (!count) assert.match(timelineReport(d), /No committed observations/);
});

for (const version of [1, 2, 3, 4]) test(`strict snapshot v${version} preserves exact uint256 and unchanged endpoints`, async t => {
  const a = { ...fixture(), chainId: ((1n << 256n) - 1n).toString(), schemaVersion: version,
    block: { number: `0x${((1n << 256n) - 2n).toString(16)}`, hash: inputs[0].block.hash } };
  if (version > 1) a.implementation = { status: 'observed', via: 'implementation-slot', address: IMPLEMENTATION, code: '0x' + '60'.repeat(131072) };
  if (version === 3) a.migration = { fromVersion: 2 };
  if (version === 4) a.genesis = { status: 'observed', hash: inputs[0].block.hash };
  const p = await store(t, [a, next(a)]), d = await historyTimeline(p.directory);
  assert.equal(d.identity.snapshotVersion, version); assert.equal(d.identity.chainId, a.chainId);
  assert.equal(d.observations[1].block.number, `0x${((1n << 256n) - 1n).toString(16)}`);
  assert.match(timelineReport(d), new RegExp(((1n << 256n) - 1n).toString()));
  assert.equal(d.transitions[0].changed, false); assert.deepEqual(d.transitions[0].changes, []);
  assert.equal(d.transitions[0].implementation?.comparison ?? null, version === 1 ? null : 'comparable');
});

for (const count of [0, 1, 2]) for (const descending of [false, true]) test(`v4 unknown genesis: ${count} observations, descending ${descending}`, async t => {
  const a = { ...fixture(), schemaVersion: 4, implementation: { status: 'not-recorded' },
    migration: { fromVersion: 1 }, genesis: { status: 'not-recorded' } };
  const b = next(a, descending ? -1 : 1);
  // Negative test helper hash is replaced with a valid saved hash.
  b.block.hash = inputs[1].block.hash;
  const p = await store(t, [a, b].slice(0, count), { seed: a });
  for (const flags of [[], ['--json']]) {
    const result = await cli([...p.args, ...flags]);
    if (count > 1) failure(result, 'GENESIS_UNAVAILABLE');
    else { assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /not-recorded/); }
  }
});

test('v3 mixed migration origins keep missing observations unavailable without same-hash contradiction', async t => {
  const a = { ...fixture(), schemaVersion: 3, implementation: { status: 'not-recorded' }, migration: { fromVersion: 1 } };
  const b = { ...structuredClone(a), capturedAt: next(a).capturedAt, migration: { fromVersion: 2 },
    implementation: { status: 'observed', via: 'implementation-slot', address: IMPLEMENTATION, code: '0x60' } };
  const d = await historyTimeline((await store(t, [a, b])).directory);
  assert.equal(d.transitions[0].implementation.comparison, 'unavailable');
  assert.equal(d.transitions[0].changed, false); assert.deepEqual(d.notices, []);
});

for (const mode of ['skipped', 'no-code', 'beacon-changed', 'same-hash-code', 'same-hash-skipped', 'same-hash-not-recorded']) test(`implementation policy: ${mode}`, async t => {
  const a = structuredClone(inputs[0]), b = next(a);
  if (mode === 'skipped' || mode === 'same-hash-skipped') {
    a.code = b.code = '0x';
    a.implementation = b.implementation = { status: 'skipped', reason: 'NO_TARGET_CODE' };
  }
  if (mode === 'no-code') a.implementation = { ...a.implementation, status: 'no-code', code: '0x' };
  if (mode === 'beacon-changed') { b.slots.beacon = word(IMPLEMENTATION); b.implementation.beacon = IMPLEMENTATION; }
  if (mode === 'same-hash-code') b.implementation.code = '0x64';
  if (mode === 'same-hash-not-recorded') {
    a.schemaVersion = b.schemaVersion = 4;
    a.genesis = b.genesis = { status: 'observed', hash: a.block.hash };
    a.implementation = { status: 'not-recorded' };
  }
  if (mode.startsWith('same-hash')) b.block = a.block;
  const d = await historyTimeline((await store(t, [a, b])).directory), pair = d.transitions[0];
  const unavailable = mode.includes('skipped') || mode.includes('not-recorded');
  assert.equal(pair.implementation.comparison, unavailable ? 'unavailable' : mode === 'beacon-changed' ? 'provenance-changed' : 'comparable');
  assert.deepEqual(pair.implementation.changes.map(c => c.field), ['no-code', 'same-hash-code'].includes(mode) ? ['code'] : []);
  assert.deepEqual(d.notices.map(n => n.code), mode === 'same-hash-code' ? ['INCONSISTENT_BLOCK_DATA'] : []);
});

test('index order retains equal/decreasing heights and times, nonadjacent conflicts and repeated states', async t => {
  const a = fixture(), b = next(a), c = { ...next(a, 2), block: { ...a.block, hash: inputs[1].block.hash } };
  const d = { ...next(a, 3), code: '0x61', block: a.block, capturedAt: a.capturedAt };
  const e = { ...next(a, 4), block: { ...a.block, number: '0x63' } };
  const p = await store(t, [a, b, c, d, e]), report = await historyTimeline(p.directory);
  assert.deepEqual(report.observations.map(o => o.block.number), ['0x64', '0x65', '0x64', '0x64', '0x63']);
  assert.deepEqual(report.transitions.map(p => p.status), ['compared', 'unavailable', 'compared', 'unavailable']);
  for (const pair of report.transitions.filter(p => p.status === 'unavailable')) {
    assert.deepEqual(Object.keys(pair), ['from', 'to', 'status', 'reason']); assert.equal(pair.reason.code, 'ORDER');
  }
  assert.deepEqual(report.notices, [
    { code: 'BLOCK_HEIGHT_DECREASED', beforeOrdinal: 2, afterOrdinal: 3 },
    { code: 'SAME_HEIGHT_DIFFERENT_HASH', beforeOrdinal: 1, afterOrdinal: 3 },
    { code: 'CAPTURE_TIME_DECREASED', beforeOrdinal: 3, afterOrdinal: 4 },
    { code: 'SAME_HEIGHT_DIFFERENT_HASH', beforeOrdinal: 3, afterOrdinal: 4 },
    { code: 'INCONSISTENT_BLOCK_DATA', beforeOrdinal: 1, afterOrdinal: 4 },
    { code: 'BLOCK_HEIGHT_DECREASED', beforeOrdinal: 4, afterOrdinal: 5 },
    { code: 'INCONSISTENT_BLOCK_DATA', beforeOrdinal: 1, afterOrdinal: 5 }
  ]);
  assert.equal((await cli([...p.args, '--json'])).code, 0);
  assert.match(timelineReport(report), /intermediate events and their timing are unknown/);
});

test('identical captures remain idempotent; later timestamp at identical block is a separate observation', async t => {
  const a = fixture(), p = await store(t, [a]);
  const source = join(p.parent, 'PRIVATE_source.json'); await fs.writeFile(source, JSON.stringify(a));
  assert.equal((await historyOperation({ operation: 'add', input: source, directory: p.directory })).status, 'already-present');
  await fs.writeFile(source, json({ ...a, capturedAt: next(a).capturedAt }));
  await historyOperation({ operation: 'add', input: source, directory: p.directory });
  await preserved(p.parent, async () => {
    const d = await historyTimeline(p.directory);
    assert.equal(d.committed, 2); assert.deepEqual(d.notices, []); assert.equal(d.transitions[0].changed, false);
  });
});

test('equal height and capture time retain both hashes; a later return to prior state is not collapsed', async t => {
  const a = fixture(), b = { ...structuredClone(a), code: '0x61', block: { ...a.block, hash: inputs[1].block.hash } };
  const c = next(a), d = await historyTimeline((await store(t, [a, b, c])).directory);
  assert.deepEqual(d.observations.map(o => o.capturedAt), [a.capturedAt, a.capturedAt, c.capturedAt]);
  assert.deepEqual(d.transitions.map(p => [p.from, p.to, p.changed]), [[1, 2, true], [2, 3, true]]);
  assert.deepEqual(d.observations[0].code, d.observations[2].code);
  assert.deepEqual(d.notices, [{ code: 'SAME_HEIGHT_DIFFERENT_HASH', beforeOrdinal: 1, afterOrdinal: 2 }]);
});

const stage = n => `.cw-stage-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000.tmp`;
test('pending and partial stages are counted, excluded and preserved; corruption is never skipped', async t => {
  const pending = next(inputs[2]), p = await store(t, inputs, { pending: [pending] });
  await fs.writeFile(join(p.directory, stage(0)), '{partial PRIVATE');
  await preserved(p.directory, async () => {
    const d = await historyTimeline(p.directory);
    assert.equal(d.pending, 1); assert.equal(d.staged, 1); assert.equal(d.committed, 3);
    assert.deepEqual(d.observations, expected.observations);
    assert.equal((await cli(p.args)).code, 0);
  });
  await fs.writeFile(join(p.directory, name(pending)), '{PRIVATE');
  failure(await cli([...p.args, '--json']), 'HISTORY_CORRUPT');
});

for (const field of ['address', 'chainId', 'source', 'version', 'genesis-hash', 'genesis-unknown']) test(`timeline refuses store identity mismatch: ${field}`, async t => {
  const a = { ...inputs[0], schemaVersion: 4, genesis: { status: 'observed', hash: inputs[0].block.hash } }, b = next(a);
  if (field === 'address') b.address = IMPLEMENTATION;
  if (field === 'chainId') b.chainId = '2';
  if (field === 'source') b.source = 'rpc';
  if (field === 'version') { b.schemaVersion = 2; delete b.genesis; }
  if (field === 'genesis-hash') b.genesis.hash = inputs[1].block.hash;
  if (field === 'genesis-unknown') { b.genesis = { status: 'not-recorded' }; b.migration = { fromVersion: 2 }; }
  const p = await store(t, [a, b]);
  failure(await cli([...p.args, '--json']), 'HISTORY_CORRUPT');
});

for (const mutation of ['missing-snapshot', 'missing-header', 'entry-gap', 'hash-link', 'entry-path', 'header-extra', 'duplicate-key', 'utf8', 'bom', 'nesting', 'unknown-version', 'raw-byte-change', 'snapshot-symlink', 'entry-symlink', 'stage-symlink', 'fifo', 'directory', 'foreign']) test(`timeline rejects ${mutation} before stdout`, async t => {
  const p = await store(t), file = join(p.directory, name(inputs[0])), entry = join(p.directory, 'entry-0001.json');
  if (mutation === 'missing-snapshot') await fs.unlink(file);
  if (mutation === 'missing-header') await fs.unlink(join(p.directory, 'index.json'));
  if (mutation === 'entry-gap') await fs.unlink(entry);
  if (mutation === 'hash-link' || mutation === 'entry-path') {
    const value = JSON.parse(await fs.readFile(entry));
    value[mutation === 'hash-link' ? 'previous' : 'snapshot'] = '../../PRIVATE'; await fs.writeFile(entry, json(value));
  }
  if (mutation === 'header-extra') { const f = join(p.directory, 'index.json'), v = JSON.parse(await fs.readFile(f)); v.PRIVATE = 'https://PRIVATE'; await fs.writeFile(f, json(v)); }
  if (mutation === 'duplicate-key') await fs.writeFile(file, '{"schemaVersion":2,' + json(inputs[0]).slice(1));
  if (mutation === 'utf8') await fs.writeFile(file, Buffer.from([0xff]));
  if (mutation === 'bom') await fs.writeFile(file, '\ufeff' + json(inputs[0]));
  if (mutation === 'nesting') await fs.writeFile(file, '['.repeat(10000) + '0' + ']'.repeat(10000));
  if (mutation === 'unknown-version') await fs.writeFile(file, json({ ...inputs[0], schemaVersion: 5 }));
  if (mutation === 'raw-byte-change') await fs.appendFile(file, ' ');
  if (['snapshot-symlink', 'entry-symlink', 'stage-symlink', 'fifo', 'directory'].includes(mutation)) {
    const target = mutation === 'entry-symlink' ? entry : mutation === 'stage-symlink' ? join(p.directory, stage(0)) : file;
    if (mutation !== 'stage-symlink') await fs.unlink(target);
    if (mutation.endsWith('symlink')) await fs.symlink(join(p.directory, 'index.json'), target);
    else if (mutation === 'fifo') execFileSync('mkfifo', [target], { cwd: ROOT });
    else await fs.mkdir(target);
  }
  if (mutation === 'foreign') await fs.writeFile(join(p.directory, 'PRIVATE'), 'keep');
  for (const flags of [[], ['--json']]) failure(await cli([...p.args, ...flags]), mutation === 'foreign' ? 'HISTORY_DIRECTORY' : 'HISTORY_CORRUPT');
});

for (const [label, limit, version] of [['v1 file', 512 * 1024, 1], ['v2 file', 768 * 1024, 2], ['index', 4096, 2]]) for (const extra of [0, 1]) test(`${label} byte boundary +${extra}`, async t => {
  const a = version === 1 ? fixture() : inputs[0];
  const padded = value => json(value).padEnd(limit + extra, ' ');
  const p = await store(t, [a], label === 'index' ? { indexBytes: padded } : { bytes: padded });
  const result = await cli([...p.args, '--json']);
  if (extra) failure(result, 'HISTORY_CORRUPT'); else assert.equal(result.code, 0, result.stderr);
});

for (const count of [128, 129]) test(`indexed observation boundary ${count}`, async t => {
  const p = await store(t, Array.from({ length: count }, (_, n) => next(fixture(), n + 1)));
  const result = await cli([...p.args, '--json']);
  if (count === 129) failure(result, 'HISTORY_LIMIT');
  else { assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).transitions.length, 127); }
});

for (const count of [512, 513]) test(`directory filename boundary ${count}`, async t => {
  const p = await store(t, []);
  for (let n = 1; n < count; n++) await fs.writeFile(join(p.directory, stage(n)), '');
  const result = await cli([...p.args, '--json']);
  if (count === 513) failure(result, 'HISTORY_LIMIT');
  else { assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).staged, 511); }
});

for (const args of [[], ['PRIVATE.json'], ['--json', '--json'], ['--json=true'], ['--exit-code'], ['--dir'], ['--dir', 'PRIVATE'], ['--rpc', 'https://PRIVATE'], ['--config', 'PRIVATE'], ['--target', 'PRIVATE'], ['--genesis'], ['--concurrency', '2']]) test(`timeline rejects unsupported/duplicate arguments ${JSON.stringify(args)}`, async t => {
  const p = await store(t);
  const argv = args.length ? [...p.args, ...args] : ['history', 'timeline'];
  failure(await cli(argv), 'USAGE');
});

async function preload(p, code) {
  const file = join(p.parent, 'guard.mjs'); await fs.writeFile(file, code);
  return { NODE_OPTIONS: `--import=${pathToFileURL(file)}` };
}
test('timeline performs no RPC, env/config reads, writes, recovery or signal lifecycle changes', async t => {
  const p = await store(t);
  const environment = await preload(p, `
    import fs from 'node:fs/promises';
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
    import {syncBuiltinESMExports} from 'node:module';
    const denied=()=>{throw Error('PRIVATE forbidden side effect')};
    const oldOpen=fs.open, oldRead=fs.readFile, oldOn=process.on;
    for(const key of ['writeFile','appendFile','mkdir','rename','link','unlink','rm','rmdir','chmod','utimes','copyFile']) fs[key]=denied;
    fs.open=async(path,flags,...rest)=>{
      if(flags & (${constants.O_WRONLY}|${constants.O_RDWR}|${constants.O_CREAT}|${constants.O_TRUNC}|${constants.O_APPEND})) denied();
      return oldOpen(path,flags,...rest);
    };
    fs.readFile=(path,...rest)=>{if(/config|\\.env/.test(String(path)))denied();return oldRead(path,...rest)};
    http.request=http.get=https.request=https.get=net.connect=net.createConnection=globalThis.fetch=denied;
    process.env=new Proxy(process.env,{get(target,key){if(/RPC|PRIVATE/.test(String(key)))denied();return target[key]}});
    process.on=function(event,...args){if(['SIGINT','SIGTERM'].includes(event))denied();return oldOn.call(this,event,...args)};
    syncBuiltinESMExports();
  `);
  await preserved(p.directory, async () => {
    for (const flags of [[], ['--json']]) {
      const result = await cli([...p.args, ...flags], environment);
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, flags.length ? json(expected) : text);
    }
  });
});

for (const change of ['snapshot-replaced', 'pending-changed', 'header-reformatted', 'root-replaced', 'directory-appended', 'close-error', 'read-error']) test(`read-only validation catches ${change} without partial stdout`, async t => {
  const p = await store(t, inputs, { pending: [next(inputs[2])] });
  const environment = await preload(p, `
    import fs from 'node:fs/promises'; import {join} from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const root=${JSON.stringify(p.directory)}, mutation=${JSON.stringify(change)};
    const original=fs.open; let triggered=false, snapshotOpens=0;
    fs.open=async(path,...args)=>{
      const target=String(path), file=await original(path,...args);
      if(target===root && mutation==='close-error') file.close=async()=>{throw Error('PRIVATE')};
      if(target.includes('/snapshot-')) snapshotOpens++;
      // First four opens validate all snapshots; the next opens revisit committed data.
      if(!triggered && snapshotOpens===5 && target.includes('/snapshot-')) {
        triggered=true;
        if(mutation==='snapshot-replaced') { const bytes=await fs.readFile(target); await fs.rename(target,target+'.saved'); await fs.writeFile(target,bytes); }
        if(mutation==='pending-changed') await fs.appendFile(join(root,${JSON.stringify(name(next(inputs[2])))}),' ');
        if(mutation==='header-reformatted') await fs.appendFile(join(root,'index.json'),' ');
        if(mutation==='root-replaced') {await fs.rename(root,root+'.saved');await fs.mkdir(root)};
        if(mutation==='directory-appended') await fs.writeFile(join(root,${JSON.stringify(stage(7))}),'');
        if(mutation==='read-error') file.read=async()=>{throw Error('https://PRIVATE')};
      }
      return file;
    }; syncBuiltinESMExports();
  `);
  const result = await cli([...p.args, '--json'], environment);
  failure(result, ['snapshot-replaced', 'root-replaced', 'close-error', 'read-error', 'header-reformatted'].includes(change) ? 'HISTORY_CORRUPT' : 'HISTORY_CHANGED');
});

test('timeline root symlink and missing directory fail safely', async t => {
  const p = await store(t), alias = join(p.parent, 'PRIVATE_alias'); await fs.symlink(p.directory, alias);
  for (const directory of [alias, join(p.parent, 'PRIVATE_missing')]) failure(await cli(['history', 'timeline', '--dir', directory]), 'HISTORY_DIRECTORY');
});

test('nonadjacent implementation conflicts survive an intervening missing observation', async t => {
  const a = { ...structuredClone(inputs[0]), schemaVersion: 4, genesis: { status: 'observed', hash: inputs[0].block.hash } };
  const b = { ...next(a), block: a.block, implementation: { status: 'not-recorded' } };
  const c = { ...next(a, 2), block: a.block }; c.implementation.code = '0x65';
  const d = await historyTimeline((await store(t, [a, b, c])).directory);
  assert.deepEqual(d.transitions.map(p => p.implementation.comparison), ['unavailable', 'unavailable']);
  assert.deepEqual(d.notices, [{ code: 'INCONSISTENT_BLOCK_DATA', beforeOrdinal: 1, afterOrdinal: 3 }]);
});

test('empty/noncanonical raw target words remain exact, with no inferred implementation', async t => {
  const a = fixture(), b = next(a); b.slots = { implementation: EMPTY, admin: `0x${'f'.repeat(64)}`, beacon: word(IMPLEMENTATION) };
  const d = await historyTimeline((await store(t, [a, b])).directory);
  assert.deepEqual(d.transitions[0].changes.map(c => c.field), ['implementation', 'admin', 'beacon']);
  assert.deepEqual(d.observations[1].slots.admin, { raw: b.slots.admin, status: 'noncanonical', address: null });
  assert.equal(d.transitions[0].implementation, null);
  assert.match(timelineReport(d), /noncanonical/);
});

test('regular hard-linked snapshot is read-only and over-limit stage is rejected', async t => {
  const p = await store(t, [fixture()]), source = join(p.parent, 'source.json');
  await fs.link(join(p.directory, name(fixture())), source);
  await preserved(p.parent, async () => assert.equal((await cli(p.args)).code, 0));
  await fs.writeFile(join(p.directory, stage(0)), Buffer.alloc(768 * 1024 + 1));
  failure(await cli(p.args), 'HISTORY_CORRUPT');
});

for (const target of ['snapshot', 'header', 'entry']) test(`actual ${target} reads remain bounded when stat lies`, async t => {
  const p = await store(t, [fixture()]);
  const path = join(p.directory, target === 'snapshot' ? name(fixture()) : target === 'header' ? 'index.json' : 'entry-0001.json');
  const limit = target === 'snapshot' ? 768 * 1024 : 4096;
  const environment = await preload(p, `
    import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const target=${JSON.stringify(path)}, limit=${limit}, open=fs.open; let consumed=0;
    fs.open=async(path,...args)=>{const file=await open(path,...args); if(String(path)===target) {
      file.read=async(buffer,offset,length)=>{
        if(buffer.length!==limit+1 || consumed+length>limit+1) process.exit(91);
        buffer.fill(32,offset,offset+length); consumed+=length; return {bytesRead:length};
      };
    } return file};
    process.on('exit',()=>{if(consumed!==limit+1)process.exitCode=92}); syncBuiltinESMExports();
  `);
  failure(await cli(p.args, environment), 'HISTORY_CORRUPT');
});
