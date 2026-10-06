import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, symlink, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateConfig, readConfig, configuredCapture, MAX_CONFIG_BYTES, MAX_CONFIG_TARGETS } from '../src/config.js';
import { SLOTS, readSnapshot } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, protocolResult, ADDRESS, HASH, EMPTY, word } from './helpers/fake-rpc.js';

const execute = promisify(execFile);
const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const GENESIS = `0x${'c1'.repeat(32)}`;
const OTHER_HASH = `0x${'d2'.repeat(32)}`;
const BEACON = '0x3333333333333333333333333333333333333333';
const IMPL = '0x4444444444444444444444444444444444444444';
const entry = (name = 'private-selected', extra = {}) => ({ name, address: CHECKSUM, chainId: '0x1', rpcEnv: 'PRIVATE_SELECTED_RPC', ...extra });
const config = () => ({ schemaVersion: 1, targets: [entry('private-unused', { address: ADDRESS, chainId: '2', rpcEnv: 'PRIVATE_UNUSED_RPC' }), entry()] });
const args = (input, output) => ['snapshot', '--config', input, '--target', 'private-selected', '--out', output];
function failure(result, code) {
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
  assert.doesNotMatch(result.stderr, /PRIVATE_|private-|https?:|\.json|\u001b|at .*\.js/);
}
async function setup(t, value = config()) {
  const dir = await temporaryDirectory(t);
  const input = join(dir, 'PRIVATE_CONFIG.json'), output = join(dir, 'PRIVATE_OUTPUT.json');
  await writeFile(input, ` \n${JSON.stringify(value, null, 3)}\n`, { mode: 0o640 });
  return { dir, input, output };
}
async function unchanged(path, bytes, before) {
  assert.deepEqual(await readFile(path), bytes);
  const after = await stat(path);
  for (const key of ['size', 'ino', 'mode', 'mtimeMs']) assert.equal(after[key], before[key], key);
}

// A child-only guard records exactly the requested env getters and network use.
// It also fixes only Date construction, at this test's real start time, for paired captures.
async function guard(dir, { reads = [], network = false, clock = new Date().toISOString(), fileGuard = false } = {}) {
  const path = join(dir, 'guard.mjs');
  await writeFile(path, `import assert from 'node:assert/strict';
import http from 'node:http';import https from 'node:https';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const seen=[];const raw=process.env;
process.env=new Proxy(raw,{get(t,k){if(k==='CONTRACT_WATCH_RPC_URL'||(typeof k==='string'&&k.startsWith('PRIVATE_'))){seen.push(k);if(!${JSON.stringify(reads)}.includes(k))throw Error('PRIVATE_ENV');}return Reflect.get(t,k);}});
let calls=0,opens=0;const forbidden=()=>{calls++;throw Error('PRIVATE_NETWORK');};
if(!${network}) {globalThis.fetch=forbidden;http.get=forbidden;http.request=forbidden;https.get=forbidden;https.request=forbidden;}
if(${fileGuard}) {fs.open=async()=>{opens++;throw Error('PRIVATE_FILE_READ');};syncBuiltinESMExports();}
const OriginalDate=Date;globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[${JSON.stringify(clock)}]));}};
process.on('exit',()=>{assert.deepEqual(seen,${JSON.stringify(reads)});assert.equal(calls,0);assert.equal(opens,0);});`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(path).href}` };
}

test('strict config validates every definition, bounds names/counts and retains original exact strings', () => {
  const valid = config();
  assert.equal(validateConfig(valid), valid);
  assert.equal(valid.targets[1].address, CHECKSUM);
  const max = (1n << 256n) - 1n;
  for (const chainId of [max.toString(), `0x${max.toString(16)}`, '0x0001', '1']) {
    validateConfig({ schemaVersion: 1, targets: [entry('a', { chainId })] });
  }
  for (const name of ['a', 'a'.repeat(64), 'a-1', 'a--']) validateConfig({ schemaVersion: 1, targets: [entry(name)] });
  validateConfig({ schemaVersion: 1, targets: [entry('a', { rpcEnv: '_' }), entry('b', { rpcEnv: 'A'.repeat(64) })] });
  const maximum = { schemaVersion: 1, targets: Array.from({ length: MAX_CONFIG_TARGETS }, (_, i) => entry(`target-${i}`)) };
  validateConfig(maximum); maximum.targets.push(entry('one-more'));
  assert.throws(() => validateConfig(maximum), { code: 'CONFIG' });
  const malformed = [null, [], {}, { ...config(), extra: 'PRIVATE_KEY' }, { ...config(), schemaVersion: '1' },
    { ...config(), schemaVersion: 2 }, { schemaVersion: 1, targets: [] }, { schemaVersion: 1, targets: {} }];
  for (const field of ['name', 'address', 'chainId', 'rpcEnv']) {
    const missing = entry(); delete missing[field]; malformed.push({ schemaVersion: 1, targets: [missing] });
  }
  for (const [field, values] of Object.entries({
    name: ['', 'A', '1a', '-a', 'a_b', 'a.b', 'a b', 'é', 'a\n', 'a\r', 'a\u2028', 'a'.repeat(65), true, {}, null],
    address: ['', '0x0', null, 1, 'PRIVATE_ADDRESS', `${ADDRESS}\n`, `${ADDRESS}\r`],
    chainId: [1, 1.5, {}, null, '', '0', '01', '1e3', '-1', '1\n', '0x1\u2029', (max + 1n).toString()],
    rpcEnv: ['', 'a', '1RPC', '${PRIVATE_SELECTED_RPC}', 'PRIVATE.RPC', 'PRIVATE-RPC', 'RPC\n', 'RPC\r', 'RPC\u2029', 'A'.repeat(65), 'https://PRIVATE_KEY', 1, null]
  })) for (const value of values) malformed.push({ schemaVersion: 1, targets: [entry('a', { [field]: value })] });
  for (const value of malformed) assert.throws(() => validateConfig(value), { code: 'CONFIG' });
  for (const bad of [null, [], { ...entry(), url: 'https://PRIVATE_KEY' }, { ...entry(), block: 'latest' }, entry()]) {
    const value = config(); value.targets[0] = bad; // Duplicate name or bad unused entry.
    assert.throws(() => validateConfig(value), { code: 'CONFIG' });
  }
});

test('bounded config reader rejects malformed UTF-8/JSON, duplicate decoded keys and deep inputs', async t => {
  const { input } = await setup(t);
  const valid = JSON.stringify(config());
  const duplicate = valid.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  const escaped = valid.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1');
  const duplicateEntry = valid.replace('"rpcEnv":"PRIVATE_SELECTED_RPC"', '"rpcEnv":"PRIVATE_UNUSED_RPC","rpcEnv":"PRIVATE_SELECTED_RPC"');
  for (const value of ['{PRIVATE_JSON', '', 'null', '[]', '\ufeff' + valid, valid + '\0', valid + valid,
    duplicate, escaped, duplicateEntry, '['.repeat(4000) + '0' + ']'.repeat(4000),
    '{"schemaVersion":1,"targets":[{"nested":{"bad":1}}]}',
    Buffer.concat([Buffer.from(valid), Buffer.from([0xc0, 0xaf])]),
    Buffer.from([0xff, 0xfe, 0x7b, 0, 0x7d, 0])]) {
    await writeFile(input, value); await assert.rejects(readConfig(input), { code: 'CONFIG' });
  }
  // Escaped aliases are decoded before validation; strings containing brackets do not fool depth checks.
  await writeFile(input, valid.replace('schemaVersion', 'schema\\u0056ersion'));
  assert.deepEqual(await readConfig(input), config());
  await writeFile(input, valid.padEnd(MAX_CONFIG_BYTES, ' '));
  assert.deepEqual(await readConfig(input), config());
  await writeFile(input, valid.padEnd(MAX_CONFIG_BYTES + 1, ' '));
  await assert.rejects(readConfig(input), { code: 'CONFIG_READ' });
  const many = { schemaVersion: 1, targets: Array.from({ length: 32 }, (_, i) => entry(`t-${i}`)) };
  await writeFile(input, JSON.stringify(many)); assert.deepEqual(await readConfig(input), many);
});

test('config reads preserve original metadata, accept regular symlinks and reject special files without hanging', async t => {
  const { dir, input } = await setup(t);
  const bytes = await readFile(input), before = await stat(input);
  const linked = join(dir, 'link.json'); await symlink(input, linked);
  assert.deepEqual(await readConfig(linked), config()); await unchanged(input, bytes, before);
  const missing = join(dir, 'missing'); const broken = join(dir, 'broken'); await symlink(missing, broken);
  for (const path of [missing, broken, dir]) await assert.rejects(readConfig(path), { code: 'CONFIG_READ' });
  if (process.platform !== 'win32') {
    const fifo = join(dir, 'fifo'); await execute('mkfifo', [fifo]);
    failure(await cli(args(fifo, join(dir, 'out.json'))), 'CONFIG_READ');
    await chmod(input, 0o000);
    try { await assert.rejects(readConfig(input), { code: 'CONFIG_READ' }); }
    finally { await chmod(input, 0o640); }
  }
});

test('only selected own env value is read once, after all local validation; invalid values never fall back', async t => {
  const { input } = await setup(t);
  const reads = [];
  const env = new Proxy({ PRIVATE_SELECTED_RPC: 'http://127.0.0.1:8545' }, {
    get(target, key) { reads.push(key); return Reflect.get(target, key); }
  });
  const resolved = await configuredCapture(input, 'private-selected', { strictChecksum: true }, env);
  assert.deepEqual(reads, ['PRIVATE_SELECTED_RPC']);
  assert.equal(resolved.address, CHECKSUM); assert.equal(resolved.chainId, '0x1');
  assert.ok(!('name' in resolved) && !('rpcEnv' in resolved) && !('targets' in resolved));
  for (const value of [undefined, '', ' ', 123, null, {}, 'https://PRIVATE_KEY.invalid/#fragment',
    'file:///PRIVATE_KEY', 'https://user:PRIVATE_KEY@invalid', 'http://', 'https://PRIVATE_KEY.invalid/\n', 'x'.repeat(8193)]) {
    await assert.rejects(configuredCapture(input, 'private-selected', {}, { PRIVATE_SELECTED_RPC: value,
      PRIVATE_UNUSED_RPC: 'http://127.0.0.1:8545', CONTRACT_WATCH_RPC_URL: 'http://127.0.0.1:8545' }), { code: 'CONFIG_ENV' });
  }
  await assert.rejects(configuredCapture(input, 'private-selected', {}, {}), { code: 'CONFIG_ENV' });
  await assert.rejects(configuredCapture(input, 'private-selected', {}, Object.create({ PRIVATE_SELECTED_RPC: 'http://127.0.0.1:8545' })), { code: 'CONFIG_ENV' });
  await assert.rejects(configuredCapture(input, 'private-selected', {}, { get PRIVATE_SELECTED_RPC() { throw Error('PRIVATE_GETTER'); } }), { code: 'CONFIG_ENV' });
  const noEnv = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('Unexpected env lookup'); }, get() { throw Error('Unexpected env read'); } });
  for (const [opts, code] of [[{ block: 'pending' }, 'BLOCK'], [{ blockHash: 'PRIVATE_HASH' }, 'BLOCK_HASH'],
    [{ depth: '01' }, 'DEPTH'], [{ timeoutMs: 1 }, 'TIMEOUT_OPTION'], [{ block: 'latest', depth: '0' }, 'USAGE'], [{ genesis: 'true' }, 'USAGE']]) {
    await assert.rejects(configuredCapture(input, 'private-selected', opts, noEnv), { code });
  }
  for (const name of ['private-absent', 'PRIVATE_NAME', '', 'x'.repeat(65), undefined]) await assert.rejects(configuredCapture(input, name, {}, noEnv), { code: 'CONFIG_TARGET' });
  const malformed = config(); malformed.targets[0].chainId = 1;
  await writeFile(input, JSON.stringify(malformed));
  await assert.rejects(configuredCapture(input, 'private-selected', {}, noEnv), { code: 'CONFIG' });
  const wrongCase = config(); wrongCase.targets[1].address = CHECKSUM.toLowerCase();
  await writeFile(input, JSON.stringify(wrongCase));
  await assert.rejects(configuredCapture(input, 'private-selected', { strictChecksum: true }, noEnv), { code: 'ADDRESS_CHECKSUM' });
});

test('CLI rejects missing/conflicting config options and invalid capture inputs without env/network/files', async t => {
  const { dir, input, output } = await setup(t);
  const environment = await guard(dir);
  const base = args(input, output);
  const cases = [
    [['snapshot', '--config', input, '--out', output], 'USAGE'],
    [['snapshot', '--target', 'private-selected', '--out', output], 'USAGE'],
    [['snapshot', '--config', input, '--target', 'private-selected'], 'USAGE'],
    ...[['--config', input], ['--target', 'private-selected'], ['--address', ADDRESS], ['--chain-id', '1'],
      ['--rpc', 'https://PRIVATE_KEY'], ['--config'], ['--target'], ['--target', ''], ['--config=PRIVATE_FILE'],
      ['--resolve-beacon', '--implementation-code'], ['--block', 'latest', '--depth', '0'], ['--block-hash', HASH, '--block', '100']]
      .map(flags => [[...base, ...flags], 'USAGE']),
    [[...base, '--block', 'pending'], 'BLOCK'], [[...base, '--block-hash', 'PRIVATE_HASH'], 'BLOCK_HASH'],
    [[...base, '--depth', '01'], 'DEPTH'], [[...base, '--timeout-ms', '1'], 'TIMEOUT_OPTION'],
    [['snapshot', '--config', input, '--target', 'private-absent', '--out', output], 'CONFIG_TARGET']
  ];
  const original = await readFile(input), before = await stat(input);
  for (const [command, code] of cases) failure(await cli(command, environment), code);
  await unchanged(input, original, before);
  for (const value of ['', 'https://PRIVATE_KEY.invalid/#fragment']) {
    const env = await guard(dir, { reads: ['PRIVATE_SELECTED_RPC'] });
    failure(await cli(base, { ...env, PRIVATE_SELECTED_RPC: value, CONTRACT_WATCH_RPC_URL: 'http://127.0.0.1:8545' }), 'CONFIG_ENV');
  }
  failure(await cli(base, await guard(dir)), 'CONFIG_ENV'); // absent own property, no getter
  assert.ok(!(await readdir(dir)).includes('PRIVATE_OUTPUT.json'));
});

test('CLI validates unused entries too, and cannot overwrite the selected config or a symlink alias', async t => {
  const { dir, input, output } = await setup(t);
  const noAccess = await guard(dir);
  for (const mutate of [c => { c.targets[0].chainId = 1; }, c => { c.targets[0].address = 'PRIVATE_ADDRESS'; },
    c => { c.targets[0].rpcEnv = '${PRIVATE_UNUSED_RPC}'; }, c => { c.targets[0].extra = 'PRIVATE_VALUE'; },
    c => { c.targets[0].name = c.targets[1].name; }]) {
    const value = config(); mutate(value); await writeFile(input, JSON.stringify(value));
    const bytes = await readFile(input), before = await stat(input);
    failure(await cli(args(input, output), noAccess), 'CONFIG');
    await unchanged(input, bytes, before);
  }
  assert.ok(!(await readdir(dir)).includes('PRIVATE_OUTPUT.json'));
  await writeFile(input, JSON.stringify(config()));
  const bytes = await readFile(input), before = await stat(input);
  const fake = await fakeRpc(t);
  const alias = join(dir, 'alias.json'); await symlink(input, alias);
  for (const destination of [input, alias]) {
    failure(await cli(args(input, destination), { PRIVATE_SELECTED_RPC: fake.url }), 'FILE_EXISTS');
    await unchanged(input, bytes, before);
  }
  assert.equal(fake.calls.length, 16);
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('selected config matches direct capture bytes, stdout and exact RPC trace across all features', async t => {
  const selections = [[], ['--block', 'finalized'], ['--block', '100'], ['--block-hash', HASH], ['--depth', '0'], ['--depth', '1']];
  const modes = [['plain', []], ['direct', ['--implementation-code']], ['beacon', ['--implementation-code']],
    ['live', ['--resolve-beacon']], ['skip', ['--implementation-code']]];
  for (const genesis of [false, true]) for (const [mode, flags] of modes) for (const selection of selections) {
    await t.test(`${genesis}/${mode}/${selection.join(' ') || 'default'}`, async t => {
      const { dir, input, output } = await setup(t);
      const before = await stat(input), bytes = await readFile(input);
      const clock = new Date().toISOString();
      const fake = await fakeRpc(t, request => {
        if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x0') return { result: { number: '0x0', hash: GENESIS } };
        if (selection[0] === '--depth' && selection[1] === '1' && request.method === 'eth_getBlockByNumber' && request.params[0] === 'latest') return { result: { number: '0x65', hash: OTHER_HASH } };
        if (mode === 'skip' && request.method === 'eth_getCode') return { result: '0x' };
        if (['beacon', 'live'].includes(mode)) {
          if (request.method === 'eth_getStorageAt') return { result: request.params[1] === SLOTS.beacon ? word(BEACON) : EMPTY };
          if (request.method === 'eth_call') return { result: word(IMPL) };
        }
        return { result: protocolResult(request) };
      });
      const common = [...selection, ...flags, '--strict-checksum', '--timeout-ms', '1000', ...(genesis ? ['--genesis'] : [])];
      const endpoint = `${fake.url}/PRIVATE_TOKEN`;
      const direct = join(dir, 'direct.json');
      const first = await cli(['snapshot', '--address', CHECKSUM, '--chain-id', '0x1', '--rpc', endpoint, '--out', direct, ...common],
        await guard(dir, { network: true, clock }));
      assert.equal(first.code, 0, first.stderr);
      const trace = structuredClone(fake.calls); fake.calls.length = 0;
      const second = await cli([...args(input, output), ...common], {
        ...await guard(dir, { reads: ['PRIVATE_SELECTED_RPC'], network: true, clock }),
        PRIVATE_SELECTED_RPC: endpoint, PRIVATE_UNUSED_RPC: 'https://PRIVATE_UNUSED.invalid', CONTRACT_WATCH_RPC_URL: 'https://PRIVATE_FALLBACK.invalid'
      });
      assert.equal(second.code, 0, second.stderr);
      assert.equal(second.stdout, first.stdout); assert.equal(second.stderr, '');
      assert.deepEqual(fake.calls, trace); assert.deepEqual(await readFile(output), await readFile(direct));
      const expected = (selection[0] === '--block-hash' || selection[1] === '1' ? 9 : 8) + (genesis ? 2 : 0)
        + ({ plain: 0, direct: 1, beacon: 2, live: 1, skip: 0 })[mode];
      assert.equal(fake.calls.length, expected);
      const saved = await readSnapshot(output);
      assert.equal(saved.schemaVersion, genesis ? 4 : flags[0] === '--implementation-code' ? 2 : 1);
      assert.doesNotMatch(second.stdout + await readFile(output, 'utf8'), /PRIVATE_|private-|https?:|rpcEnv|config|targets/);
      await unchanged(input, bytes, before);
    });
  }
});

test('huge exact chain IDs, original checksum casing and noncanonical slots survive selected capture', async t => {
  const max = (1n << 256n) - 1n;
  const value = config(); value.targets[1].chainId = max.toString();
  const { dir, input, output } = await setup(t, value);
  const anomalous = `0x01${'00'.repeat(31)}`;
  const fake = await fakeRpc(t, r => ({ result: r.method === 'eth_chainId' ? `0x${max.toString(16)}`
    : r.method === 'eth_getStorageAt' ? anomalous : protocolResult(r) }));
  const env = { ...await guard(dir, { reads: ['PRIVATE_SELECTED_RPC'], network: true }), PRIVATE_SELECTED_RPC: fake.url };
  const result = await cli([...args(input, output), '--strict-checksum', '--implementation-code'], env);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Noncanonical/);
  const saved = await readSnapshot(output); assert.equal(saved.chainId, max.toString());
  assert.equal(saved.address, CHECKSUM.toLowerCase()); assert.equal(saved.slots.admin, anomalous);
  assert.equal(saved.implementation.reason, 'NONCANONICAL_SLOT'); assert.equal(fake.calls.length, 8);
  value.targets[1].address = CHECKSUM.toLowerCase(); await writeFile(input, JSON.stringify(value));
  failure(await cli([...args(input, join(dir, 'no.json')), '--strict-checksum'], await guard(dir)), 'ADDRESS_CHECKSUM');
  assert.ok(!(await readdir(dir)).includes('no.json'));
});

test('selected capture preserves noncanonical-block, reorg, chain and RPC failure/no-output guarantees', async t => {
  const cases = [
    ['initial chain', 1, 'CHAIN_MISMATCH', { result: '0x2' }],
    ['noncanonical hash', 3, 'BLOCK_NOT_CANONICAL', { result: { number: '0x64', hash: OTHER_HASH } }],
    ['remote state', 4, 'RPC_REMOTE', { error: { code: -32000, message: 'PRIVATE_PROVIDER', data: 'https://PRIVATE_TOKEN' } }],
    ['reorg', 8, 'BLOCK_CHANGED', { result: { number: '0x64', hash: OTHER_HASH } }],
    ['final chain', 9, 'CHAIN_MISMATCH', { result: '0x2' }]
  ];
  for (const [name, step, code, envelope] of cases) await t.test(name, async t => {
    const { dir, input, output } = await setup(t); let count = 0;
    const fake = await fakeRpc(t, r => ++count === step ? envelope : { result: protocolResult(r) });
    const bytes = await readFile(input), before = await stat(input);
    failure(await cli([...args(input, output), '--block-hash', HASH], { PRIVATE_SELECTED_RPC: fake.url }), code);
    assert.equal(fake.calls.length, step); await unchanged(input, bytes, before);
    assert.deepEqual(await readdir(dir), ['PRIVATE_CONFIG.json']);
  });
});

test('offline commands reject config flags and ignore config/env/network; help and version need no files', async t => {
  const { dir, input, output } = await setup(t);
  const environment = await guard(dir, { fileGuard: true });
  for (const command of [['--help'], ['--version']]) assert.equal((await cli(command, environment)).code, 0);
  for (const command of [
    ['inspect', '--config', input], ['inspect', '--target', 'private-selected'],
    ['diff', '--config', input, 'a', 'b'], ['diff', 'a', 'b', '--target', 'private-selected'],
    ['migrate', 'a', '--to-version', '4', '--out', output, '--config', input],
    ['migrate', 'a', '--to-version', '4', '--out', output, '--target', 'private-selected']
  ]) failure(await cli(command, environment), 'USAGE');
  const offline = await guard(dir);
  assert.equal((await cli(['inspect', 'examples/before.json'], offline)).code, 0);
  assert.equal((await cli(['diff', '--json', 'examples/before.json', 'examples/after.json'], offline)).code, 0);
  assert.equal((await cli(['migrate', 'examples/before.json', '--to-version', '3', '--out', output], offline)).code, 0);
  assert.deepEqual(await readConfig(input), config());
});

test('config reader closes descriptors after growth/truncation/read/parse failures and detects changed files', async t => {
  for (const mode of ['growth', 'truncate', 'read-error', 'stat-error', 'parse-error']) await t.test(mode, async t => {
    const { dir, input, output } = await setup(t);
    if (mode === 'parse-error') await writeFile(input, '{PRIVATE_INVALID_JSON');
    const path = join(dir, 'file-fault.mjs');
    await writeFile(path, `import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const originalOpen=fs.open;let opened=0,closed=0;
fs.open=async(...args)=>{const handle=await originalOpen(...args);if(args[0]===${JSON.stringify(input)}){
opened++;const read=handle.read.bind(handle),close=handle.close.bind(handle),stat=handle.stat.bind(handle);let first=true,stats=0;
handle.close=async()=>{closed++;return close();};
handle.stat=async(...a)=>{if(++stats===2&&${JSON.stringify(mode)}==='stat-error')throw Error('PRIVATE_STAT');return stat(...a);};
handle.read=async(...a)=>{if(first){first=false;
if(${JSON.stringify(mode)}==='growth')await fs.writeFile(${JSON.stringify(input)},' '.repeat(${MAX_CONFIG_BYTES + 1}));
if(${JSON.stringify(mode)}==='read-error')throw Error('PRIVATE_READ');
const result=await read(...a);if(${JSON.stringify(mode)}==='truncate')await fs.truncate(${JSON.stringify(input)},1);return result;}
return read(...a);};}return handle;};syncBuiltinESMExports();
process.on('exit',()=>{assert.equal(opened,1);assert.equal(closed,1);});`);
    failure(await cli(args(input, output), { NODE_OPTIONS: `--import=${pathToFileURL(path).href}` }), mode === 'parse-error' ? 'CONFIG' : 'CONFIG_READ');
    assert.ok(!(await readdir(dir)).includes('PRIVATE_OUTPUT.json'));
  });
});
