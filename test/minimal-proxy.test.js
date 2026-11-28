import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { matchMinimalProxy, analyzeMinimalProxy, minimalProxyJson, MAX_MINIMAL_PROXY_REPORT_BYTES } from '../src/minimal-proxy.js';
import { cli, temporaryDirectory, ADDRESS, EMPTY, word, IMPLEMENTATION } from './helpers/fake-rpc.js';
import { json, hash, preserved } from './helpers/history-fixture.js';

const load = name => fs.readFile(new URL(`fixtures/minimal-proxy/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
const [vectors, base] = await Promise.all(['vectors', 'snapshot-v1'].map(load));
const reference = vectors[0], clone = value => structuredClone(value), h = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const execute = promisify(execFile);
async function input(t, value = base) {
  const directory = await temporaryDirectory(t), path = join(directory, 'PRIVATE_input.json');
  await fs.writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value), { mode: 0o600 });
  return { directory, path };
}
function failure(result, code = 'MINIMAL_PROXY_INPUT') {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]: [^\\n]+\\n$`));
  assert.doesNotMatch(result.stderr, /PRIVATE|secret|https?:|stack|at .*\.js/);
}
function snapshot(version, observed = true, fromVersion = 1) {
  const v = clone(base); v.schemaVersion = version;
  if (version === 2) v.implementation = { status: 'skipped', reason: 'EMPTY_SLOTS' };
  if (version === 3 || version === 4 && !observed) {
    v.migration = { fromVersion };
    v.implementation = fromVersion === 1 ? { status: 'not-recorded' } : { status: 'skipped', reason: 'EMPTY_SLOTS' };
  }
  if (version === 4) {
    v.genesis = observed ? { status: 'observed', hash: h(1234) } : { status: 'not-recorded' };
    if (observed) v.implementation = { status: 'not-recorded' };
  }
  return v;
}

for (const v of vectors) test(`independent bytecode vector: ${v.name}`, () => {
  const result = matchMinimalProxy(v.code, ADDRESS);
  assert.equal(result.status, v.status); assert.equal(result.delegateTarget?.address ?? null, v.target);
  if (v.target) {
    assert.equal(result.delegateTarget.zeroAddress, /^0x0{40}$/.test(v.target));
    assert.equal(result.delegateTarget.selfReference, v.target === ADDRESS);
    assert.deepEqual(result.delegateTarget.provenance, { field: 'code', firstByte: 10, lastByte: 29 });
    assert.equal(result.delegateTarget.availability, 'unverified'); assert.equal(result.delegateTarget.behavior, 'unverified');
  }
});

for (const index of [...Array.from({ length: 10 }, (_, n) => n), ...Array.from({ length: 15 }, (_, n) => n + 30)]) {
  test(`every fixed byte is required, including opcode/jump index ${index}`, () => {
    const bytes = Buffer.from(reference.code.slice(2), 'hex'); bytes[index] ^= 1;
    assert.deepEqual(matchMinimalProxy(`0x${bytes.toString('hex')}`, ADDRESS), { status: 'no-supported-match', delegateTarget: null });
  });
}

test('all twenty address-byte positions are variable and never lose leading zeros', () => {
  for (let i = 0; i < 20; i++) {
    const bytes = Buffer.from(vectors.find(v => v.name === 'zero').code.slice(2), 'hex'); bytes[10 + i] = 128 + i;
    const address = Buffer.alloc(20); address[i] = 128 + i;
    const d = matchMinimalProxy(`0x${bytes.toString('hex')}`, ADDRESS);
    assert.equal(d.status, 'matched'); assert.equal(d.delegateTarget.address, `0x${address.toString('hex')}`);
  }
});

test('every truncation, byte deletion, insertion and trailing byte is refused as a complete runtime', () => {
  const bytes = Buffer.from(reference.code.slice(2), 'hex');
  for (let length = 1; length < 45; length++) {
    for (const fragment of [bytes.subarray(0, length), bytes.subarray(45 - length)]) {
      assert.equal(matchMinimalProxy(`0x${fragment.toString('hex')}`, ADDRESS).status, 'no-supported-match');
    }
  }
  for (let i = 0; i <= 45; i++) {
    const inserted = Buffer.concat([bytes.subarray(0, i), Buffer.from([0]), bytes.subarray(i)]);
    assert.equal(matchMinimalProxy(`0x${inserted.toString('hex')}`, ADDRESS).status, 'no-supported-match');
    if (i < 45) {
      const deleted = Buffer.concat([bytes.subarray(0, i), bytes.subarray(i + 1)]);
      assert.equal(matchMinimalProxy(`0x${deleted.toString('hex')}`, ADDRESS).status, 'no-supported-match');
    }
  }
});

test('all shortened vanity PUSHn forms stay explicitly outside support', () => {
  for (let n = 1; n < 20; n++) {
    const z = 20 - n;
    const code = `0x363d3d373d3d3d363d${(0x5f + n).toString(16)}${'be'.repeat(n)}5af43d82803e903d9160${(0x2b - z).toString(16)}57fd5bf3`;
    assert.equal((code.length - 2) / 2, 45 - z);
    assert.deepEqual(matchMinimalProxy(code, ADDRESS), { status: 'no-supported-match', delegateTarget: null });
  }
});

for (const [version, observed, fromVersion] of [[1, false, 1], [2, false, 2], [3, false, 1], [3, false, 2], [4, true, 1], [4, false, 1], [4, false, 2]]) {
  test(`strict snapshot v${version}, genesis ${observed}, origin ${fromVersion}: provenance and unchanged sources`, async t => {
    const value = snapshot(version, observed, fromVersion), p = await input(t, value);
    await fs.chmod(p.path, 0o444); await fs.writeFile(join(p.directory, 'user.txt'), 'PRIVATE preserve');
    const result = await preserved(p.directory, () => cli(['minimal-proxy', p.path]));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    const d = JSON.parse(result.stdout);
    assert.equal(d.kind, 'contract-watch-minimal-proxy'); assert.equal(d.schemaVersion, 1); assert.equal(d.mode, 'offline');
    assert.equal(d.source, 'synthetic'); assert.equal(d.status, 'matched'); assert.equal(d.address, value.address);
    assert.equal(d.chainId, value.chainId); assert.deepEqual(d.block, value.block);
    assert.deepEqual(d.genesis, value.genesis ?? { status: 'not-recorded' });
    assert.deepEqual(d.snapshot, { schemaVersion: version, capturedAt: value.capturedAt, sha256: hash(json(value)), bytes: Buffer.byteLength(json(value)), migration: value.migration ?? null });
    assert.deepEqual(d.evidence, { field: 'code', bytes: 45, sha256: hash(Buffer.from(reference.code.slice(2), 'hex')), matchedRuntime: reference.code });
    assert.equal(d.delegateTarget.address, reference.target); assert.equal(d.implementationObservation, 'not-analyzed'); assert.equal(d.traversal, 'not-performed');
    assert.doesNotMatch(result.stdout, /PRIVATE|secret|http/);
  });
}

test('RPC source and full uint256 values remain exact without inferring genesis from height zero', async t => {
  const value = clone(base), max = (1n << 256n) - 1n; value.source = 'rpc'; value.chainId = max.toString(); value.block.number = `0x${max.toString(16)}`;
  const p = await input(t, value), d = await analyzeMinimalProxy(p.path);
  assert.equal(d.source, 'rpc'); assert.equal(d.chainId, max.toString()); assert.equal(d.block.number, value.block.number);
  for (const version of [1, 2, 3, 4]) {
    const zero = snapshot(version, false); zero.block.number = '0x0';
    const f = await input(t, zero), result = await analyzeMinimalProxy(f.path);
    assert.deepEqual(result.genesis, { status: 'not-recorded' });
  }
  const genesis = snapshot(4); genesis.block = { number: '0x0', hash: genesis.genesis.hash };
  assert.deepEqual((await analyzeMinimalProxy((await input(t, genesis)).path)).genesis, genesis.genesis);
});

for (const name of ['empty', 'ordinary-program', 'zero', 'self']) test(`CLI preserves distinct ${name} evidence without availability claims`, async t => {
  const vector = vectors.find(v => v.name === name), value = { ...clone(base), code: vector.code }, p = await input(t, value);
  const result = await cli(['minimal-proxy', p.path]); assert.equal(result.code, 0, result.stderr);
  const d = JSON.parse(result.stdout); assert.equal(d.status, vector.status);
  if (vector.target) { assert.equal(d.delegateTarget.address, vector.target); assert.equal(d.delegateTarget.availability, 'unverified'); }
  else { assert.equal(d.delegateTarget, null); assert.equal(d.evidence.matchedRuntime, null); }
});

test('zero and self flags can both be true without fetching or recursion', async t => {
  const value = { ...clone(base), code: vectors.find(v => v.name === 'zero').code, address: '0x' + '0'.repeat(40) };
  const d = await analyzeMinimalProxy((await input(t, value)).path);
  assert.equal(d.status, 'matched'); assert.equal(d.delegateTarget.zeroAddress, true); assert.equal(d.delegateTarget.selfReference, true);
  assert.equal(d.delegateTarget.availability, 'unverified'); assert.equal(d.traversal, 'not-performed');
});

test('only target code is analyzed; implementation code and EIP-1967 slots never override it', async t => {
  for (const [target, implementation, status] of [['0x6000', reference.code, 'no-supported-match'], [reference.code, '0x6000', 'matched'], [reference.code, '0x', 'matched']]) {
    const value = snapshot(2); value.code = target; value.slots.implementation = word(IMPLEMENTATION);
    value.implementation = { status: implementation === '0x' ? 'no-code' : 'observed', via: 'implementation-slot', address: IMPLEMENTATION, code: implementation };
    const d = await analyzeMinimalProxy((await input(t, value)).path);
    assert.equal(d.status, status); assert.equal(d.evidence.sha256, hash(Buffer.from(target.slice(2), 'hex')));
    assert.equal(d.delegateTarget?.address ?? null, status === 'matched' ? reference.target : null);
    assert.equal(d.implementationObservation, 'not-analyzed');
    if (status === 'matched') assert.equal(d.delegateTarget.availability, 'unverified');
  }
});

test('noncanonical slots are preserved by validation without changing bytecode evidence', async t => {
  const value = clone(base); value.slots.admin = '0x01' + '00'.repeat(31);
  const d = await analyzeMinimalProxy((await input(t, value)).path); assert.equal(d.status, 'matched');
});

const mutations = [
  ['version', v => v.schemaVersion = 5], ['unknown field', v => v.PRIVATE = 'secret'], ['unknown block field', v => v.block.extra = true],
  ['source', v => v.source = 'PRIVATE'], ['chain number', v => v.chainId = 1], ['chain overflow', v => v.chainId = (1n << 256n).toString()],
  ['address', v => v.address = '0x1234'], ['timestamp', v => v.capturedAt = 'PRIVATE'], ['number', v => v.block.number = '0x00'],
  ['hash', v => v.block.hash = '0x11'], ['missing slot', v => delete v.slots.admin], ['slot hex', v => v.slots.admin = 'PRIVATE'],
  ['odd code', v => v.code = '0x1'], ['invalid hex', v => v.code = '0xgg'], ['uppercase hex', v => v.code = reference.code.toUpperCase()],
  ['wrong code type', v => v.code = 0], ['array code', v => v.code = []], ['oversized code', v => v.code = '0x' + '00'.repeat(128 * 1024 + 1)],
  ['legacy genesis', v => v.genesis = { status: 'not-recorded' }], ['legacy implementation', v => v.implementation = { status: 'not-recorded' }]
];
for (const [name, mutate] of mutations) test(`file validation refuses ${name} with no partial stdout`, async t => {
  const value = clone(base); mutate(value); const p = await input(t, value);
  failure(await preserved(p.directory, () => cli(['minimal-proxy', p.path])));
});

for (const [name, value] of [
  ['incompatible v2 observation', { ...snapshot(2), implementation: { status: 'not-recorded' } }],
  ['invalid v3 provenance', { ...snapshot(3, false), migration: { fromVersion: 4 } }],
  ['unknown v4 genesis fields', { ...snapshot(4), genesis: { status: 'observed', hash: h(1234), extra: true } }],
  ['zero genesis', { ...snapshot(4), genesis: { status: 'observed', hash: EMPTY } }],
  ['contradictory genesis', { ...snapshot(4), block: { number: '0x0', hash: h(9999) } }],
  ['missing migration', { ...snapshot(4), genesis: { status: 'not-recorded' } }]
]) test(`version-specific strict structure: ${name}`, async t => failure(await cli(['minimal-proxy', (await input(t, value)).path])));

for (const [name, bytes] of [
  ['duplicate key', json(base).replace('"code":', '"code":"0x", "code":')],
  ['escaped duplicate', json(base).replace('"code":', '"co\\u0064e":"0x", "code":')],
  ['nested duplicate', json(base).replace('"number":', '"number":"0x1", "number":')],
  ['UTF8', Buffer.from([0xff])], ['UTF16', Buffer.from(json(base), 'utf16le')], ['BOM', '\ufeff' + json(base)],
  ['deep nesting', '{"x":'.repeat(7) + '0' + '}'.repeat(7)], ['trailing junk', json(base) + 'PRIVATE'],
  ['array', '[]'], ['null', 'null'], ['empty file', '']
]) test(`strict encoding/JSON refuses ${name}`, async t => failure(await cli(['minimal-proxy', (await input(t, bytes)).path])));

for (const version of [1, 2, 3, 4]) test(`actual file bytes obey snapshot v${version} cap`, async t => {
  const value = snapshot(version), limit = (version === 1 ? 512 : 768) * 1024, text = json(value);
  const p = await input(t, text + ' '.repeat(limit - Buffer.byteLength(text)));
  const d = await preserved(p.directory, () => analyzeMinimalProxy(p.path)); assert.equal(d.snapshot.bytes, limit);
  await fs.appendFile(p.path, ' '); failure(await cli(['minimal-proxy', p.path]));
});

test('maximum target and implementation code stay bounded, distinct and absent from large output', async t => {
  const value = snapshot(2); value.code = reference.code + '00'.repeat(128 * 1024 - 45);
  value.slots.implementation = word(IMPLEMENTATION);
  value.implementation = { status: 'observed', via: 'implementation-slot', address: IMPLEMENTATION, code: '0x' + 'ff'.repeat(128 * 1024) };
  const p = await input(t, value), d = await analyzeMinimalProxy(p.path);
  assert.equal(d.status, 'no-supported-match'); assert.equal(d.evidence.bytes, 128 * 1024);
  assert.equal(d.evidence.matchedRuntime, null); assert.ok(Buffer.byteLength(minimalProxyJson(d)) < MAX_MINIMAL_PROXY_REPORT_BYTES);
  value.implementation.code += 'ff'; await fs.writeFile(p.path, json(value)); failure(await cli(['minimal-proxy', p.path]));
});

for (const kind of ['directory', 'missing', 'symlink', 'broken-link', 'fifo']) test(`safe regular-file requirement: ${kind}`, async t => {
  const p = await input(t), path = join(p.directory, 'PRIVATE_special');
  if (kind === 'directory') await fs.mkdir(path);
  if (kind === 'symlink') await fs.symlink(p.path, path);
  if (kind === 'broken-link') await fs.symlink(join(p.directory, 'absent'), path);
  if (kind === 'fifo') await execute('mkfifo', [path]);
  failure(await cli(['minimal-proxy', path]));
});

test('reader checks actual bytes despite dishonest stat and refuses mutation during a read', async t => {
  for (const kind of ['size', 'mutation']) {
    const p = await input(t), preload = join(p.directory, 'race.mjs');
    if (kind === 'size') await fs.truncate(p.path, 768 * 1024 + 1);
    await fs.writeFile(preload, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const open=fs.open,stat=fs.lstat;
${kind === 'size' ? `fs.lstat=async(...a)=>{const s=await stat(...a);if(String(a[0])===${JSON.stringify(p.path)})s.size=1n;return s;};` : ''}
fs.open=async function(path,...a){const f=await open.call(this,path,...a);if(String(path)===${JSON.stringify(p.path)}){
${kind === 'size' ? `const s=f.stat.bind(f);f.stat=async(...a)=>{const v=await s(...a);v.size=1n;return v;};` : `const read=f.read.bind(f);let first=true;f.read=async(...a)=>{const result=await read(...a);if(first){first=false;await fs.appendFile(path,' ');}return result;};`}
}return f;};syncBuiltinESMExports();`);
    failure(await cli(['minimal-proxy', p.path], { NODE_OPTIONS: `--import=${preload}` }));
  }
});

test('a close failure suppresses output after releasing the real input handle', async t => {
  const p = await input(t), preload = join(p.directory, 'close-error.mjs');
  await fs.writeFile(preload, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const open=fs.open;fs.open=async function(path,...a){const f=await open.call(this,path,...a);if(String(path)===${JSON.stringify(p.path)}){const close=f.close.bind(f);f.close=async()=>{await close();throw Error('PRIVATE close error');};}return f;};syncBuiltinESMExports();`);
  failure(await preserved(p.directory, () => cli(['minimal-proxy', p.path], { NODE_OPTIONS: `--import=${preload}` })));
});

test('offline command makes no network, RPC/environment discovery, .env read or file writes', async t => {
  const p = await input(t), preload = join(p.directory, 'offline.mjs');
  await fs.writeFile(join(p.directory, '.env'), 'PRIVATE_RPC=secret');
  await fs.writeFile(preload, `import http from 'node:http';import https from 'node:https';import net from 'node:net';import dns from 'node:dns';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const no=()=>{throw Error('PRIVATE forbidden operation')};http.request=https.request=net.Socket.prototype.connect=dns.lookup=globalThis.fetch=no;
const env=process.env;process.env=new Proxy(env,{get(t,k){if(/RPC|API_KEY|SECRET/.test(String(k)))no();return Reflect.get(t,k);}});
const open=fs.open;fs.open=function(p,flags,...a){if(String(p).endsWith('/.env')||typeof flags==='string'&&/[wa+]/.test(flags)||typeof flags==='number'&&(flags&3)!==0)no();return open.call(this,p,flags,...a);};
for(const k of ['writeFile','appendFile','mkdir','rename','unlink','chmod','utimes'])fs[k]=no;syncBuiltinESMExports();`);
  const result = await preserved(p.directory, () => cli(['minimal-proxy', p.path], { NODE_OPTIONS: `--import=${preload}`, CONTRACT_WATCH_RPC_URL: 'PRIVATE' }));
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'matched');
});

for (const args of [[], ['--json'], ['--rpc', 'PRIVATE'], ['--out', 'PRIVATE'], ['--implementation-code'], ['--follow'], ['--depth', '2'], ['a', 'b']]) {
  test(`minimal-proxy rejects extra/missing arguments ${args.join(' ')}`, async t => {
    const p = await input(t), selected = args.length ? [p.path, ...args] : [];
    failure(await cli(['minimal-proxy', ...selected]), 'USAGE');
  });
}

test('analysis leaves existing inspect/diff bytes unchanged', async t => {
  const p = await input(t), inspect = await cli(['inspect', p.path]), diff = await cli(['diff', '--json', p.path, p.path]);
  await preserved(p.directory, () => analyzeMinimalProxy(p.path));
  assert.deepEqual(await cli(['inspect', p.path]), inspect);
  assert.deepEqual(await cli(['diff', '--json', p.path, p.path]), diff);
});

test('report serialization checks exact 8 KiB boundary before stdout', () => {
  const overhead = Buffer.byteLength(minimalProxyJson({ value: '' })), value = 'x'.repeat(MAX_MINIMAL_PROXY_REPORT_BYTES - overhead);
  assert.equal(Buffer.byteLength(minimalProxyJson({ value })), MAX_MINIMAL_PROXY_REPORT_BYTES);
  assert.throws(() => minimalProxyJson({ value: value + 'x' }), { code: 'MINIMAL_PROXY_REPORT' });
});
