import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { correlateHistory, correlationJson, MAX_CORRELATION_BYTES } from '../src/correlation.js';
import { validateRangeReport, readRangeFile, recheckRangeFile } from '../src/event-range-import.js';
import { readEventRange } from '../src/event-range.js';
import { historyTimeline } from '../src/timeline.js';
import { store, preserved, tree, json, hash, id, snapshotName, stageName } from './helpers/history-fixture.js';
import { cli, fakeRpc, EMPTY } from './helpers/fake-rpc.js';

const load = name => fs.readFile(new URL(`fixtures/correlation/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
const [report, snapshots, expected, split] = await Promise.all(['range', 'observations', 'expected', 'split-range'].map(load));
const h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const q = n => `0x${BigInt(n).toString(16)}`;
const clone = value => structuredClone(value);
const args = (p, extra = []) => ['history', 'correlate', '--dir', p.directory, '--events', p.events, ...extra];
async function input(t, values = snapshots, range = report, options = {}) {
  const p = await store(t, clone(values), { seed: values[0] ?? snapshots[0], ...options });
  p.events = join(p.parent, 'PRIVATE_range.json');
  await fs.writeFile(p.events, typeof range === 'string' || Buffer.isBuffer(range) ? range : json(range), { mode: 0o600 });
  return p;
}
const repeat = (value, n) => ({ ...clone(value), capturedAt: new Date(Date.parse(value.capturedAt) + n * 10000).toISOString() });
function failure(result, code) {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]: [^\\n]+\\n$`));
  assert.doesNotMatch(result.stderr, /PRIVATE|secret|127\.0\.0\.1|stack|Error:/);
}
const projection = d => ({ relations: d.observations.map(o => o.relation),
  intervals: d.intervals.map(i => ({ slot: i.slot, before: i.before?.ordinals ?? null, after: i.after?.ordinals ?? null,
    candidateIds: i.candidateIds, endpointChange: i.endpointChange.status })),
  candidates: d.candidates.map(c => ({ id: c.id, before: c.valueComparison.before.status, after: c.valueComparison.after.status,
    sameBlockAsAfter: c.sameBlockAsAfter, later: c.laterReturnedSameSlotEventsInBlock, last: c.lastReturnedSameSlotEventInBlock })) });

test('independent A/B/A, admin and beacon fixture: exact provenance, end-of-block semantics and no source changes', async t => {
  const pending = repeat(snapshots[4], 5), p = await input(t, snapshots, report, { pending: [pending], stages: ['PRIVATE partial'] });
  await fs.writeFile(join(p.parent, 'user.txt'), 'PRIVATE preserve');
  const before = await historyTimeline(p.directory), result = await preserved(p.parent, () => cli(args(p)));
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const d = JSON.parse(result.stdout);
  assert.equal(d.kind, 'contract-watch-event-correlation'); assert.equal(d.schemaVersion, 1);
  assert.deepEqual(projection(d), expected);
  assert.equal(d.mode, 'offline'); assert.equal(d.inputValidation, 'internally-consistent');
  assert.equal(d.completeness, 'unverified'); assert.equal(d.causation, 'unverified'); assert.equal(d.sourceUnchanged, true);
  assert.equal(d.history.pending, 1); assert.equal(d.history.staged, 1); assert.equal(d.history.committed, 5);
  assert.deepEqual(d.candidates.map(c => c.event), report.logs);
  assert.deepEqual(d.observations.map(o => o.observationId), snapshots.map(id));
  assert.deepEqual(d.observations.map(o => o.snapshotSha256), snapshots.map(s => hash(json(s))));
  assert.deepEqual(d.observations.map(o => o.snapshotBytes), snapshots.map(s => Buffer.byteLength(json(s))));
  assert.deepEqual(d.observations.map(o => o.block), snapshots.map(s => s.block));
  assert.deepEqual(d.observations.map(o => o.originalOrdinal), [1, 2, 3, 4, 5]);
  assert.ok(d.observations.every(o => o.implementation.status === 'not-recorded'));
  assert.ok(d.candidates.every(c => c.association === 'candidate-only'));
  assert.equal(d.eventSource.sha256, hash(json(report))); assert.equal(d.eventSource.authenticity, 'unverified');
  assert.deepEqual(await historyTimeline(p.directory), before);
  assert.doesNotMatch(result.stdout, /PRIVATE|secret|127\.0\.0\.1/);
});

test('independent split-tree report and consistent duplicate counters give the same candidates', async t => {
  const r = clone(split); r.pages[6].returnedLogs += 2; r.pages[6].duplicates = 2;
  r.verification.receivedLogs += 2; r.verification.duplicateLogs = 2;
  const p = await input(t, snapshots, r), d = await correlateHistory(p);
  assert.deepEqual(projection(d), expected);
});

test('all ties retained in index order; nearest uses height, not publication or capture order', async t => {
  const values = [snapshots[3], snapshots[1], repeat(snapshots[1], 8), snapshots[0], snapshots[2]];
  const p = await input(t, values), d = await correlateHistory(p);
  assert.deepEqual(d.observations.map(o => o.ordinal), [1, 2, 3, 4, 5]);
  assert.deepEqual(d.intervals[0].before.ordinals, [4]); assert.deepEqual(d.intervals[0].after.ordinals, [2, 3]);
  assert.ok(d.notices.some(n => n.code === 'HEIGHT_DECREASED'));
  assert.ok(d.notices.some(n => n.code === 'CAPTURE_TIME_DECREASED'));
  assert.ok(d.notices.some(n => n.code === 'REPEATED_HEIGHT'));
});

for (const [label, values, bracketing] of [
  ['empty', [], 'both-missing'], ['before missing', [snapshots[1]], 'before-missing'],
  ['after missing', [snapshots[0]], 'after-missing'],
  ['outside only', [{ ...clone(snapshots[0]), block: { number: '0x63', hash: h(9000) } }, { ...clone(snapshots[4]), block: { number: '0x69', hash: h(9001) } }], 'both-missing']
]) test(`missing neighbors: ${label}`, async t => {
  const p = await input(t, values), d = await correlateHistory(p);
  assert.equal(d.intervals[0].bracketing, bracketing); assert.equal(d.intervals[0].endpointChange.status, 'unavailable');
  assert.equal(d.intervals[0].retentionGap, null); assert.equal(d.candidates.length, 4);
});

test('same-height fork is explicit and never selected; known hash at wrong height stays unknown', async t => {
  const fork = repeat(snapshots[1], 1); fork.block.hash = h(9999);
  const wrong = repeat(snapshots[0], 2); wrong.block = { number: '0x69', hash: snapshots[4].block.hash };
  const p = await input(t, [snapshots[0], fork, snapshots[1], wrong]), d = await correlateHistory(p);
  assert.deepEqual(d.observations.map(o => o.relation), ['matched', 'different-hash', 'matched', 'unknown']);
  assert.equal(d.observations[3].reason, 'SAVED_NUMBER_MISMATCH');
  assert.deepEqual(d.intervals[0].after.ordinals, [3]);
  assert.ok(d.notices.some(n => n.code === 'SAME_HEIGHT_DIFFERENT_HASH'));
});

for (const field of ['slots', 'code', 'height', 'implementation']) test(`all occurrences of contradictory saved hash are excluded: ${field}`, async t => {
  const a = repeat(snapshots[1], 1), b = repeat(snapshots[1], 2), c = repeat(snapshots[1], 3);
  if (field === 'slots') b.slots.admin = h(5);
  if (field === 'code') b.code = '0x61';
  if (field === 'height') b.block.number = '0x65ff';
  if (field === 'implementation') {
    for (const v of [a, b, c]) v.implementation = { status: 'observed', via: 'implementation-slot', address: '0x' + '2'.repeat(40), code: '0x60' };
    b.implementation.code = '0x61';
  }
  const p = await input(t, [snapshots[0], a, b, c, snapshots[2]]), d = await correlateHistory(p);
  assert.deepEqual(d.observations.slice(1, 4).map(o => o.relation), ['conflicting', 'conflicting', 'conflicting']);
  assert.deepEqual(d.intervals[0].after.ordinals, [5]); assert.equal(d.candidates[0].sameBlockAsAfter, false);
});

test('missing implementation is not invented or made contradictory; noncanonical raw slots remain visible', async t => {
  const a = clone(snapshots[0]), b = repeat(a, 1);
  b.implementation = { status: 'skipped', reason: 'NONCANONICAL_SLOT' };
  a.slots.admin = b.slots.admin = '0x01' + '00'.repeat(31);
  const p = await input(t, [a, b, snapshots[2]]), d = await correlateHistory(p);
  assert.ok(d.observations.every(o => o.relation === 'matched'));
  assert.deepEqual(d.intervals[0].before.ordinals, [1, 2]);
  assert.equal(d.observations[0].implementation.status, 'not-recorded');
  assert.equal(d.candidates[2].valueComparison.before.observed.status, 'noncanonical');
  assert.equal(d.candidates[2].valueComparison.before.status, 'differs');
});

test('retained history v2 keeps original ordinal gaps and unknown appended origins', async t => {
  const values = [snapshots[0], snapshots[1], snapshots[2], snapshots[3]], p = await input(t, values);
  const header = p.state.header;
  header.schemaVersion = 2;
  header.retention = { policy: 'baseline-and-last', keepLast: 2, sourceState: 'a'.repeat(64), sourceCommitted: 7,
    sourcePending: 2, sourceStaged: 1, ordinals: [1, 6, 7], observationsSha256: id(values.slice(0, 3).map(id)), planId: 'b'.repeat(64) };
  const headerBytes = json(header); await fs.writeFile(join(p.directory, 'index.json'), headerBytes);
  let previous = hash(headerBytes);
  for (const name of p.state.entries) {
    const path = join(p.directory, name), record = JSON.parse(await fs.readFile(path)); record.previous = previous;
    const bytes = json(record); await fs.writeFile(path, bytes); previous = hash(bytes);
  }
  const d = await preserved(p.parent, () => correlateHistory(p));
  assert.equal(d.history.schemaVersion, 2); assert.deepEqual(d.history.retention, header.retention);
  assert.deepEqual(d.observations.map(o => o.originalOrdinal), [1, 6, 7, null]);
  assert.deepEqual(d.intervals.map(i => i.retentionGap), [true, false, null]);
});

function rebuild(r) {
  r.range = { fromBlock: r.blocks[0].number, toBlock: r.blocks.at(-1).number, toHash: r.blocks.at(-1).hash };
  r.pages = [{ id: 1, parentId: null, depth: 0, ...r.range, status: r.logs.length ? 'read' : 'read-empty', attempt: 1,
    returnedLogs: r.logs.length, duplicates: 0, anchorBefore: true, anchorAfter: true, error: null }];
  delete r.pages[0].toHash;
  r.coverage = r.blocks.map(b => { const uniqueLogs = r.logs.filter(l => l.blockNumber === b.number).length;
    return { number: b.number, status: uniqueLogs ? 'read' : 'read-empty', pageId: 1, uniqueLogs }; });
  Object.assign(r.verification, { requests: 2 * r.blocks.length + 8, logRequests: 1, receivedLogs: r.logs.length,
    duplicateLogs: 0, rangeSha256: hash(JSON.stringify(r.blocks)) });
  return r;
}

test('empty range yields no candidates without an unchanged-state claim', async t => {
  const r = clone(report); r.logs = []; rebuild(r);
  const p = await input(t, snapshots, r), d = await correlateHistory(p);
  assert.deepEqual(d.candidates, []); assert.deepEqual(d.intervals, []); assert.equal(d.observations.length, 5);
  assert.equal(d.completeness, 'unverified');
});

test('uint256 maximum heights, indices and chain IDs select strictly earlier and same-block neighbors exactly', async t => {
  const r = clone(report), max = (1n << 256n) - 1n; r.chainId = max.toString();
  const mapping = new Map(r.blocks.map((b, i) => [b.number, q(max - 4n + BigInt(i))]));
  for (const b of r.blocks) b.number = mapping.get(b.number);
  for (const l of r.logs) { l.blockNumber = mapping.get(l.blockNumber); l.logIndex = q(max - 8n + BigInt(l.logIndex)); }
  rebuild(r);
  const values = clone(snapshots); for (const v of values) { v.block.number = mapping.get(v.block.number); v.chainId = r.chainId; }
  const p = await input(t, values, r), d = await correlateHistory(p);
  assert.deepEqual(projection(d), expected); assert.equal(d.identity.chainId, max.toString());
  assert.equal(d.observations.at(-1).block.number, q(max));
});

test('single genesis block event is before its end-of-block observation and has no prior neighbor', async t => {
  const r = clone(report), b = clone(r.blocks[0]), l = clone(r.logs[0]);
  b.number = '0x0'; b.hash = r.expectedGenesisHash; b.parentHash = EMPTY;
  Object.assign(l, { blockNumber: b.number, blockHash: b.hash, transactionHash: b.transactions[0], transactionIndex: '0x0' });
  r.blocks = [b]; r.logs = [l]; rebuild(r);
  const v = clone(snapshots[0]); v.block = { number: b.number, hash: b.hash };
  const p = await input(t, [v], r), d = await correlateHistory(p);
  assert.equal(d.intervals[0].before, null); assert.deepEqual(d.intervals[0].after.ordinals, [1]);
  assert.equal(d.candidates[0].sameBlockAsAfter, true);
});

const mutations = [
  ['complete flag', r => r.status = 'incomplete'], ['coverage flag', r => r.coverageVerified = false],
  ['schema', r => r.schemaVersion = 2], ['source', r => r.source = 'synthetic'], ['completeness', r => r.completeness = 'complete'],
  ['failure', r => r.failure = {}], ['unknown field', r => r.PRIVATE = 'secret'], ['address casing', r => r.address = '0X' + '1'.repeat(40)],
  ['chain precision', r => r.chainId = 1], ['zero genesis', r => r.expectedGenesisHash = EMPTY], ['zero anchor', r => r.range.toHash = EMPTY],
  ['range gap', r => r.range.fromBlock = '0x63'], ['wide range', r => r.range.toBlock = '0x84'], ['range extra', r => r.range.latest = true],
  ['missing header', r => r.blocks.pop()], ['header order', r => r.blocks.reverse()], ['header number', r => r.blocks[1].number = '0x65ff'],
  ['parent link', r => r.blocks[1].parentHash = h(999)], ['boundary cycle', r => r.blocks[0].parentHash = r.blocks.at(-1).hash],
  ['timestamp', r => r.blocks[0].timestamp = '0x00'], ['header unknown', r => r.blocks[0].extra = true],
  ['null header', r => r.blocks[0] = null], ['duplicate tx', r => r.blocks[0].transactions[1] = r.blocks[0].transactions[0]],
  ['cross-block tx', r => r.blocks[1].transactions[0] = r.blocks[0].transactions[0]], ['zero tx', r => r.blocks[0].transactions[0] = EMPTY],
  ['digest', r => r.verification.rangeSha256 = '0'.repeat(64)], ['requests', r => r.verification.requests++],
  ['log requests', r => r.verification.logRequests++], ['received count', r => r.verification.receivedLogs++],
  ['duplicate count', r => r.verification.duplicateLogs++], ['bytes zero', r => r.verification.responseBytes = 0],
  ['bytes overflow', r => r.verification.responseBytes = 16777217], ['final checks', r => r.verification.chainGenesisRechecked = false],
  ['phase', r => r.verification.phase = 'binding'], ['invalid time', r => r.verification.startedAt = 'PRIVATE'],
  ['unknown verification', r => r.verification.secret = true], ['limits', r => r.limits.blocks = 33],
  ['budget', r => r.limits.maxPages = 0], ['timeout', r => r.limits.timeoutMs = 99], ['deadline', r => r.limits.deadlineMs = 600001],
  ['coverage missing', r => r.coverage.pop()], ['coverage order', r => r.coverage.reverse()],
  ['coverage unread', r => r.coverage[0].status = 'unread'], ['coverage count', r => r.coverage[1].uniqueLogs++],
  ['coverage page', r => r.coverage[1].pageId++], ['coverage extra', r => r.coverage[0].extra = 0],
  ['page gap', r => r.pages[0].fromBlock = '0x65'], ['page unread', r => r.pages[0].status = 'read-unverified'],
  ['page anchor', r => r.pages[0].anchorAfter = false], ['page parent', r => r.pages[0].parentId = 1],
  ['page attempts', r => r.pages[0].attempt = 2], ['page counts', r => r.pages[0].returnedLogs++],
  ['page empty lie', r => r.pages[0].status = 'read-empty'], ['page error', r => r.pages[0].error = {}],
  ['page depth', r => r.pages[0].depth = 1], ['page duplicate excess', r => r.pages[0].duplicates = 257],
  ['duplicate log', r => r.logs.push(clone(r.logs[0]))], ['order', r => r.logs.reverse()],
  ['removed', r => r.logs[0].removed = true], ['pending log', r => r.logs[0].blockHash = null],
  ['log target', r => r.logs[0].address = '0x' + '9'.repeat(40)], ['log hash', r => r.logs[0].blockHash = h(99)],
  ['out-of-range', r => r.logs[0].blockNumber = '0x69'], ['tx membership', r => r.logs[0].transactionHash = h(99)],
  ['tx index', r => r.logs[0].transactionIndex = '0xf'], ['log index', r => r.logs[0].logIndex = '0x00'],
  ['signature', r => r.logs[0].topics[0] = h(99)], ['topic count', r => r.logs[0].topics.push(EMPTY)],
  ['padding', r => r.logs[0].topics[1] = '0x01' + '00'.repeat(31)], ['data', r => r.logs[0].data = EMPTY],
  ['decoded name', r => r.logs[0].event = 'AdminChanged'], ['decoded slot', r => r.logs[0].slot = 'admin'],
  ['decoded arguments', r => r.logs[0].arguments.implementation = '0x' + '9'.repeat(40)],
  ['decoded new word', r => r.logs[0].valueWord = EMPTY], ['decoded old word', r => r.logs[0].previousWord = EMPTY],
  ['optional timestamp', r => r.logs[0].blockTimestamp = '0x1'], ['log extra', r => r.logs[0].extra = 'PRIVATE'],
  ['unbounded caveat', r => r.caveats[0] = 'x'.repeat(513)], ['unknown limits', r => r.limits.extra = 1]
];
for (const [name, mutate] of mutations) test(`strict saved range refuses ${name}`, () => {
  const r = clone(report); mutate(r); assert.throws(() => validateRangeReport(r), { code: 'CORRELATION_INPUT' });
});

for (const [name, mutate] of [
  ['wrong split midpoint', r => r.pages[1].toBlock = '0x65'], ['overlap', r => r.pages[2].fromBlock = '0x66'],
  ['split children missing', r => r.pages.pop()], ['wrong DFS', r => r.pages[2].attempt = 3],
  ['non-limit split', r => r.pages[0].error.code = 'RPC_REMOTE'], ['changed safe error', r => r.pages[0].error.message = 'PRIVATE'],
  ['fake empty duplicate', r => { r.pages[5].duplicates = 1; r.pages[5].returnedLogs = 1; r.pages[5].status = 'read'; }],
  ['budget below nodes', r => r.limits.maxPages = 8], ['leaf pretending split', r => r.pages[5].status = 'split']
]) test(`strict page topology refuses ${name}`, () => {
  const r = clone(split); mutate(r); assert.throws(() => validateRangeReport(r), { code: 'CORRELATION_INPUT' });
});

for (const [label, mutate] of [
  ['address', v => v.address = '0x' + '9'.repeat(40)], ['chain', v => v.chainId = '2'],
  ['genesis', v => v.genesis.hash = h(99)], ['synthetic', v => v.source = 'synthetic'],
  ['v1', v => { v.schemaVersion = 1; delete v.genesis; delete v.implementation; }],
  ['v2', v => { v.schemaVersion = 2; delete v.genesis; v.implementation = { status: 'observed', via: 'implementation-slot', address: '0x' + '2'.repeat(40), code: '0x60' }; }],
  ['v3', v => { v.schemaVersion = 3; delete v.genesis; v.migration = { fromVersion: 1 }; }],
  ['unknown genesis', v => { v.genesis = { status: 'not-recorded' }; v.migration = { fromVersion: 1 }; }]
]) test(`history identity is never guessed: ${label}`, async t => {
  const v = clone(snapshots[0]); mutate(v); const p = await input(t, [v]);
  failure(await preserved(p.parent, () => cli(args(p))), 'CORRELATION_IDENTITY');
});

for (const [name, bytes] of [
  ['duplicate key', json(report).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')],
  ['escaped duplicate', json(report).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersi\\u006fn": 1')],
  ['invalid UTF8', Buffer.from([0xff])], ['nesting', '{"x":'.repeat(7) + '0' + '}'.repeat(7)],
  ['trailing garbage', json(report) + 'PRIVATE'], ['BOM', '\ufeff' + json(report)]
]) test(`strict file input: ${name}`, async t => {
  const p = await input(t, snapshots, bytes); failure(await preserved(p.parent, () => cli(args(p))), 'CORRELATION_INPUT');
});

test('forged complete flags and derived values fail with no partial stdout or paths', async t => {
  const r = clone(report); r.logs[0].arguments.implementation = 'PRIVATE secret';
  const p = await input(t, snapshots, r); failure(await preserved(p.parent, () => cli(args(p))), 'CORRELATION_INPUT');
});

test('actual range-file byte cap accepts exact bytes including whitespace and refuses growth by one', async t => {
  const text = json(report), limit = 2 * 1024 * 1024, p = await input(t, snapshots, text + ' '.repeat(limit - Buffer.byteLength(text)));
  assert.equal((await preserved(p.parent, () => readRangeFile(p.events))).bytes, limit);
  await fs.appendFile(p.events, ' '); failure(await cli(args(p)), 'CORRELATION_INPUT');
});

for (const kind of ['symlink', 'directory', 'missing']) test(`range input refuses ${kind}`, async t => {
  const p = await input(t), name = p.events + '.other';
  if (kind === 'symlink') await fs.symlink(p.events, name);
  if (kind === 'directory') await fs.mkdir(name);
  p.events = name; failure(await preserved(p.parent, () => cli(args(p))), 'CORRELATION_INPUT');
});

test('event-source final recheck binds bytes, mtime, permissions and inode', async t => {
  for (const kind of ['bytes', 'mtime', 'permissions', 'inode']) {
    const p = await input(t), before = await readRangeFile(p.events);
    if (kind === 'bytes') await fs.appendFile(p.events, ' ');
    if (kind === 'mtime') await fs.utimes(p.events, new Date(), new Date(0));
    if (kind === 'permissions') await fs.chmod(p.events, 0o640);
    if (kind === 'inode') { await fs.rename(p.events, p.events + '.old'); await fs.writeFile(p.events, json(report)); }
    await assert.rejects(recheckRangeFile(p.events, before), { code: 'CORRELATION_CHANGED' });
  }
});

test('CLI rejects a report changed during history reads without partial successful output', async t => {
  const p = await input(t), preload = join(p.parent, 'race.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.lstat; let changed=false;
fs.lstat=async function(path,...a){if(!changed&&String(path).endsWith('/index.json')){changed=true;await fs.appendFile(${JSON.stringify(p.events)},' ');}return original.call(this,path,...a);};syncBuiltinESMExports();`);
  failure(await cli(args(p), { NODE_OPTIONS: `--import=${preload}` }), 'CORRELATION_CHANGED');
});

test('history checkpoint catches changed committed bytes before any output', async t => {
  const p = await input(t), preload = join(p.parent, 'history-race.mjs'), target = join(p.directory, snapshotName(snapshots[0]));
  await fs.writeFile(preload, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.lstat; let reads=0;
fs.lstat=async function(path,...a){if(String(path)===${JSON.stringify(target)}&&++reads===3){const b=await fs.readFile(path,'utf8');await fs.writeFile(path,b.replace('0x6000','0x6001'));}return original.call(this,path,...a);};syncBuiltinESMExports();`);
  failure(await cli(args(p), { NODE_OPTIONS: `--import=${preload}` }), 'HISTORY_CHANGED');
});

test('untrusted human caveats are not echoed or used as authority, and wall clocks do not order events', async t => {
  const r = clone(report); r.caveats[0] = 'PRIVATE secret provider claims proven safety';
  r.verification.completedAt = '2026-11-27T00:00:00.000Z';
  const p = await input(t, snapshots, r), result = await cli(args(p));
  assert.equal(result.code, 0, result.stderr); assert.doesNotMatch(result.stdout, /PRIVATE|secret|proven safety/);
  assert.deepEqual(projection(JSON.parse(result.stdout)), expected);
});

test('correlation performs no RPC, DNS, fetch, .env or RPC environment access', async t => {
  const p = await input(t), preload = join(p.parent, 'offline.mjs');
  await fs.writeFile(join(p.parent, '.env'), 'PRIVATE_RPC=secret');
  await fs.writeFile(preload, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import dns from 'node:dns'; import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const no=()=>{throw Error('PRIVATE forbidden network/env')}; http.request=https.request=net.Socket.prototype.connect=dns.lookup=globalThis.fetch=no;
const env=process.env; process.env=new Proxy(env,{get(t,k){if(/RPC|API_KEY|SECRET/.test(String(k)))no();return Reflect.get(t,k);}});
const read=fs.readFile;fs.readFile=function(p,...a){if(String(p).endsWith('/.env'))no();return read.call(this,p,...a);};syncBuiltinESMExports();`);
  const result = await preserved(p.parent, () => cli(args(p), { NODE_OPTIONS: `--import=${preload}` }));
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).candidates.length, 4);
});

for (const extra of [['--rpc', 'PRIVATE'], ['--rpc-env', 'PRIVATE'], ['--out', 'PRIVATE'], ['--json'], ['--dir', 'PRIVATE'],
  ['--events', 'PRIVATE'], ['--events'], ['--config', 'PRIVATE'], ['--retries', '1']]) test(`closed offline CLI rejects ${extra[0]}`, async t => {
  const p = await input(t); failure(await preserved(p.parent, () => cli(args(p, extra))), 'USAGE');
});
test('both explicit local inputs are required', async () => {
  for (const args of [['history', 'correlate'], ['history', 'correlate', '--dir', 'PRIVATE'], ['history', 'correlate', '--events', 'PRIVATE']]) failure(await cli(args), 'USAGE');
});

test('corrupt pending snapshots and oversized stages are not hidden by correlation', async t => {
  const pending = repeat(snapshots[4], 4), p = await input(t, snapshots, report, { pending: [pending], stages: ['stage'] });
  await fs.appendFile(join(p.directory, snapshotName(pending)), 'PRIVATE');
  failure(await cli(args(p)), 'HISTORY_CORRUPT');
  await fs.writeFile(join(p.directory, snapshotName(pending)), json(pending));
  await fs.truncate(join(p.directory, stageName(0)), 768 * 1024 + 1);
  failure(await cli(args(p)), 'HISTORY_CORRUPT');
});

test('history count/name limits apply at 128/512 and refuse the next entry/name', async t => {
  const values = Array.from({ length: 128 }, (_, i) => repeat(snapshots[1], i)), p = await input(t, values, report, { stages: Array(255).fill('') });
  const d = await correlateHistory(p); assert.equal(d.history.committed, 128); assert.equal(d.history.staged, 255);
  assert.equal(d.intervals[0].after.ordinals.length, 128);
  await fs.writeFile(join(p.directory, stageName(255)), ''); failure(await cli(args(p)), 'HISTORY_LIMIT');
  const p2 = await input(t, [...values, repeat(snapshots[1], 129)]); failure(await cli(args(p2)), 'HISTORY_LIMIT');
});

test('output serialization has an exact 4 MiB boundary before stdout', () => {
  const base = Buffer.byteLength(correlationJson({ value: '' })), value = 'x'.repeat(MAX_CORRELATION_BYTES - base);
  assert.equal(Buffer.byteLength(correlationJson({ value })), MAX_CORRELATION_BYTES);
  assert.throws(() => correlationJson({ value: value + 'x' }), { code: 'CORRELATION_SIZE' });
});

test('32 headers, 4096 transactions, 512 unique/1024 received logs and 128 observations fit together', async t => {
  const r = clone(report);
  r.blocks = Array.from({ length: 32 }, (_, i) => ({ number: q(100 + i), hash: h(6000 + i), timestamp: q(1700000000 + i),
    transactions: Array.from({ length: 128 }, (_, j) => h(100000 + i * 128 + j)), parentHash: i ? h(5999 + i) : h(4095) }));
  r.logs = [0, 8, 16, 24].flatMap(n => Array.from({ length: 128 }, (_, index) => ({ ...clone(report.logs[0]),
    blockNumber: r.blocks[n].number, blockHash: r.blocks[n].hash, transactionHash: r.blocks[n].transactions[0], transactionIndex: '0x0', logIndex: q(index) })));
  rebuild(r);
  const spec = [[1, null, 0, 100, 131, 1], [2, 1, 1, 100, 115, 2], [3, 1, 1, 116, 131, 5],
    [4, 2, 2, 100, 107, 3], [5, 2, 2, 108, 115, 4], [6, 3, 2, 116, 123, 6], [7, 3, 2, 124, 131, 7]];
  r.pages = spec.map(([id, parentId, depth, lo, hi, attempt]) => ({ id, parentId, depth, fromBlock: q(lo), toBlock: q(hi),
    status: id <= 3 ? 'split' : 'read', attempt, returnedLogs: id <= 3 ? null : 256, duplicates: id <= 3 ? null : 128,
    anchorBefore: true, anchorAfter: true, error: id <= 3 ? clone(split.pages[0].error) : null }));
  for (const [i, entry] of r.coverage.entries()) entry.pageId = 4 + Math.floor(i / 8);
  Object.assign(r.verification, { requests: 90, logRequests: 7, receivedLogs: 1024, duplicateLogs: 512 });
  const values = Array.from({ length: 128 }, (_, i) => ({ ...repeat(snapshots[0], i),
    block: { number: r.blocks[i % 32].number, hash: r.blocks[i % 32].hash } }));
  const p = await input(t, values, r), d = await preserved(p.parent, () => correlateHistory(p));
  assert.equal(d.candidates.length, 512); assert.equal(d.observations.length, 128);
  assert.equal(d.eventSource.headers.length, 32); assert.ok(Buffer.byteLength(correlationJson(d)) < MAX_CORRELATION_BYTES);
  const extraTx = clone(r); extraTx.blocks[31].transactions.push(h(999999));
  assert.throws(() => validateRangeReport(extraTx), { code: 'CORRELATION_INPUT' });
  const extraLog = clone(r); extraLog.logs.push({ ...clone(r.logs.at(-1)), logIndex: '0xff' });
  assert.throws(() => validateRangeReport(extraLog), { code: 'CORRELATION_INPUT' });
  const extraHeader = clone(r); extraHeader.blocks.push(clone(r.blocks[31]));
  assert.throws(() => validateRangeReport(extraHeader), { code: 'CORRELATION_INPUT' });
});

test('actual live range v1 output remains importable without changing its request protocol', async t => {
  const rawKeys = ['address', 'blockHash', 'blockNumber', 'transactionHash', 'transactionIndex', 'logIndex', 'removed', 'topics', 'data', 'blockTimestamp'];
  const rpc = await fakeRpc(t, r => {
    if (r.method === 'eth_chainId') return { result: '0x1' };
    if (r.method === 'eth_getBlockByNumber') return { result: r.params[0] === '0x0'
      ? { number: '0x0', hash: report.expectedGenesisHash, parentHash: EMPTY }
      : report.blocks.find(b => b.number === r.params[0]) };
    if (r.method === 'eth_getBlockByHash') return { result: report.blocks.find(b => b.hash === r.params[0]) };
    if (r.method === 'eth_getLogs') return { result: report.logs.map(l => Object.fromEntries(rawKeys.filter(k => Object.hasOwn(l, k)).map(k => [k, l[k]]))) };
    assert.fail('unexpected method');
  });
  const live = await readEventRange({ rpc: rpc.url, address: report.address, chainId: report.chainId, genesisHash: report.expectedGenesisHash,
    fromBlock: '100', toBlock: '104', toHash: report.range.toHash });
  assert.equal(live.status, 'complete'); assert.equal(rpc.calls.length, 18);
  const p = await input(t, snapshots, live), d = await correlateHistory(p); assert.deepEqual(projection(d), expected);
});
