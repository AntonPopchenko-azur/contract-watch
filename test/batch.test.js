import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { captureMany } from '../src/batch.js';
import { SLOTS, readSnapshot } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, protocolResult, ADDRESS, HASH, EMPTY, word, CLI, ROOT } from './helpers/fake-rpc.js';

const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const GENESIS = `0x${'c1'.repeat(32)}`;
const OTHER = `0x${'d2'.repeat(32)}`;
const BEACON = '0x3333333333333333333333333333333333333333';
const IMPL = '0x4444444444444444444444444444444444444444';
const entry = (i, extra = {}) => ({ name: `private-${i}`, address: ADDRESS, chainId: '1', rpcEnv: `PRIVATE_RPC_${i}`, ...extra });
async function setup(t, entries = [entry(1), entry(2), entry(3)]) {
  const dir = await temporaryDirectory(t), configPath = join(dir, 'PRIVATE_CONFIG.json'), outputDir = join(dir, 'PRIVATE_BATCH');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targets: entries }, null, 2), { mode: 0o640 });
  return { dir, configPath, outputDir };
}
const args = ({ configPath, outputDir }, names = ['private-1', 'private-2']) => ['snapshot-many', '--config', configPath,
  ...names.flatMap(name => ['--target', name]), '--out-dir', outputDir];
function safe(text) { assert.doesNotMatch(text, /PRIVATE_|private-|https?:|rpcEnv|\.tmp|at .*\.js|\u001b/); }
function globalFailure(result, code) {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr); safe(result.stderr);
}
function report(result, saved, failed) {
  assert.equal(result.code, failed ? 1 : 0, result.stderr); assert.equal(result.stderr, ''); safe(result.stdout);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value), ['kind', 'schemaVersion', 'selected', 'saved', 'failed', 'outcomes']);
  assert.equal(value.kind, 'contract-watch-batch'); assert.equal(value.schemaVersion, 1);
  assert.equal(value.selected, saved + failed); assert.equal(value.saved, saved); assert.equal(value.failed, failed);
  assert.deepEqual(value.outcomes.map(o => o.ordinal), Array.from({ length: saved + failed }, (_, i) => i + 1));
  return value;
}
async function unchanged(path, bytes, before) {
  assert.deepEqual(await readFile(path), bytes); const after = await stat(path);
  for (const key of ['mtimeMs', 'mode', 'ino', 'size']) assert.equal(after[key], before[key]);
}
async function guard(dir, expectedReads = [], { network = false, directory = true } = {}) {
  const path = join(dir, 'guard.mjs');
  await writeFile(path, `import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';
import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
let calls=0,dirs=0;const reads=[];process.env=new Proxy(process.env,{get(t,k){if(k==='CONTRACT_WATCH_RPC_URL'||(typeof k==='string'&&k.startsWith('PRIVATE_RPC_'))){reads.push(k);if(!${JSON.stringify(expectedReads)}.includes(k))throw Error('PRIVATE_ENV');}return Reflect.get(t,k);}});
const forbidden=()=>{calls++;throw Error('PRIVATE_NETWORK');};if(!${network}){globalThis.fetch=forbidden;http.request=forbidden;https.request=forbidden;http.get=forbidden;https.get=forbidden;}
if(!${directory}){fs.mkdir=async()=>{dirs++;throw Error('PRIVATE_DIR');};syncBuiltinESMExports();}
process.on('exit',()=>{assert.deepEqual(reads,${JSON.stringify(expectedReads)});assert.equal(calls,0);assert.equal(dirs,0);});`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(path).href}` };
}

test('batch globally rejects counts, duplicate/unknown names, flags and all config/options before env, mkdir or RPC', async t => {
  const paths = await setup(t);
  const env = await guard(paths.dir, [], { directory: false });
  const base = args(paths);
  const invalid = [
    [['snapshot-many'], 'USAGE'],
    [['snapshot-many', '--config', paths.configPath, '--out-dir', paths.outputDir], 'USAGE'],
    [['snapshot-many', '--target', 'private-1', '--out-dir', paths.outputDir], 'USAGE'],
    [['snapshot-many', '--config', paths.configPath, '--target', 'private-1'], 'USAGE'],
    [args(paths, ['private-1', 'private-1']), 'BATCH_TARGETS'],
    [args(paths, Array.from({ length: 33 }, (_, i) => `private-${i}`)), 'BATCH_TARGETS'],
    [args(paths, ['private-1', 'private-absent']), 'CONFIG_TARGET'],
    [args(paths, ['private-1', '../private-2']), 'CONFIG_TARGET'],
    ...[['--config', paths.configPath], ['--out-dir', paths.outputDir], ['--target'], ['--target', ''],
      ['--out', 'PRIVATE_FILE'], ['--address', ADDRESS], ['--chain-id', '1'], ['--rpc', 'https://PRIVATE_KEY'],
      ['--json'], ['--exit-code'], ['--all'], ['--target=private-1'], ['--genesis', '--genesis'],
      ['--genesis', 'true'], ['--resolve-beacon', '--implementation-code'], ['--block', 'latest', '--depth', '0'],
      ['--block-hash', HASH, '--block', '100']].map(flags => [[...base, ...flags], 'USAGE']),
    [[...base, '--depth', '01'], 'DEPTH'], [[...base, '--block-hash', 'PRIVATE_HASH'], 'BLOCK_HASH'],
    [[...base, '--block', 'pending'], 'BLOCK'], [[...base, '--timeout-ms', '1'], 'TIMEOUT_OPTION']
  ];
  for (const [command, code] of invalid) globalFailure(await cli(command, env), code);
  for (const entries of [[entry(1), entry(2, { address: CHECKSUM.toLowerCase() })],
    [entry(1), entry(2), entry(3, { chainId: 1 })]]) {
    await writeFile(paths.configPath, JSON.stringify({ schemaVersion: 1, targets: entries }));
    globalFailure(await cli([...base, '--strict-checksum'], env), entries.length === 2 ? 'ADDRESS_CHECKSUM' : 'CONFIG');
  }
  await writeFile(paths.configPath, '{PRIVATE_BAD_JSON'); globalFailure(await cli(base, env), 'CONFIG');
  assert.ok(!(await readdir(paths.dir)).includes('PRIVATE_BATCH'));
  for (const names of [[], Array(33).fill('private-1'), ['private-1', 'private-1']]) {
    await assert.rejects(captureMany({ ...paths, names }), { code: 'BATCH_TARGETS' });
  }
});

test('exclusive output directory refuses existing files/directories/links and invalid parents before env/RPC', async t => {
  const paths = await setup(t), env = await guard(paths.dir);
  const file = join(paths.dir, 'file'); await writeFile(file, 'PRIVATE_KEEP');
  const existing = join(paths.dir, 'existing'); await mkdir(existing);
  const linked = join(paths.dir, 'linked'); await symlink(existing, linked);
  const dangling = join(paths.dir, 'dangling'); await symlink(join(paths.dir, 'absent'), dangling);
  for (const outputDir of [file, existing, linked, dangling, paths.configPath, join(existing, '.')]) {
    globalFailure(await cli(args({ ...paths, outputDir }), env), 'BATCH_EXISTS');
  }
  for (const outputDir of [join(paths.dir, 'missing', 'child'), join(file, 'child')]) {
    globalFailure(await cli(args({ ...paths, outputDir }), env), 'BATCH_DIRECTORY');
  }
  assert.equal(await readFile(file, 'utf8'), 'PRIVATE_KEEP'); assert.deepEqual(await readdir(existing), []);
});

test('one to 32 explicit definitions run sequentially with deterministic ordinals and no identity deduplication', async t => {
  for (const count of [1, 32]) await t.test(String(count), async t => {
    const entries = Array.from({ length: count }, (_, i) => entry(i + 1));
    const paths = await setup(t, entries), names = entries.map(e => e.name).reverse();
    const bytes = await readFile(paths.configPath), before = await stat(paths.configPath);
    const traffic = []; let active = 0, maximum = 0;
    const fake = await fakeRpc(t, async (request, response, incoming) => {
      active++; maximum = Math.max(maximum, active); traffic.push(incoming.url);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { result: protocolResult(request) };
    });
    const env = Object.fromEntries(entries.map((e, i) => [e.rpcEnv, `${fake.url}/PRIVATE_${i + 1}`]));
    const value = report(await cli(args(paths, names), env), count, 0);
    assert.equal(maximum, 1); assert.equal(fake.calls.length, count * 8);
    assert.deepEqual(traffic, names.flatMap(n => Array(8).fill(`/PRIVATE_${n.split('-')[1]}`)));
    assert.deepEqual(fake.calls.map(r => r.id), Array.from({ length: count }, () => [1,2,3,4,5,6,7,8]).flat());
    assert.deepEqual(await readdir(paths.outputDir), value.outcomes.map(o => o.file));
    for (const outcome of value.outcomes) {
      const file = join(paths.outputDir, `target-${String(outcome.ordinal).padStart(2, '0')}.json`);
      assert.equal(outcome.file, file.split('/').at(-1)); assert.equal(outcome.address, ADDRESS); assert.equal(outcome.chainId, '1');
      assert.equal(outcome.snapshotVersion, 1); assert.deepEqual(outcome.block, { number: '0x64', hash: HASH });
      assert.equal((await readSnapshot(file)).address, ADDRESS); safe(await readFile(file, 'utf8'));
      if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    if (process.platform !== 'win32') assert.equal((await stat(paths.outputDir)).mode & 0o777, 0o700);
    await unchanged(paths.configPath, bytes, before);
    assert.ok(!(await readdir(paths.outputDir)).some(n => n.endsWith('.tmp')));
  });
});

test('env failures are per-target; read only each selected reference at its turn, including shared references', async t => {
  const paths = await setup(t, [entry(1), entry(2), entry(3), entry(4, { rpcEnv: 'PRIVATE_RPC_1' }), entry(5)]);
  const fake = await fakeRpc(t), reads = [];
  const env = new Proxy({ PRIVATE_RPC_1: fake.url, PRIVATE_RPC_2: 7, PRIVATE_RPC_3: '' }, {
    get(object, key) { reads.push(key); return Reflect.get(object, key); }
  });
  const value = await captureMany({ ...paths, names: ['private-2', 'private-1', 'private-3', 'private-4'] }, env);
  assert.deepEqual(reads, ['PRIVATE_RPC_2', 'PRIVATE_RPC_1', 'PRIVATE_RPC_3', 'PRIVATE_RPC_1']);
  assert.equal(value.saved, 2); assert.equal(value.failed, 2);
  assert.deepEqual(value.outcomes.map(o => o.status), ['failed', 'saved', 'failed', 'saved']);
  assert.deepEqual(value.outcomes.filter(o => o.error).map(o => o.error.code), ['CONFIG_ENV', 'CONFIG_ENV']);
  assert.deepEqual(await readdir(paths.outputDir), ['target-02.json', 'target-04.json']); assert.equal(fake.calls.length, 16);
  const allPaths = { ...paths, outputDir: join(paths.dir, 'all-failed') };
  const all = report(await cli(args(allPaths, ['private-1', 'private-2']), {
    ...await guard(paths.dir, ['PRIVATE_RPC_2']), PRIVATE_RPC_2: 'https://PRIVATE_KEY.invalid/#fragment', CONTRACT_WATCH_RPC_URL: fake.url
  }), 0, 2);
  assert.ok(all.outcomes.every(o => o.error.code === 'CONFIG_ENV'));
  assert.deepEqual(await readdir(allPaths.outputDir), []); assert.equal(fake.calls.length, 16);
  safe(JSON.stringify(value));
});

test('each target independently resolves advancing heads, exact chain IDs and final checks, in requested order', async t => {
  const huge = ((1n << 256n) - 1n).toString();
  const paths = await setup(t, [entry(1, { chainId: huge }), entry(2), entry(3)]);
  let captureIndex = -1; const traffic = [];
  const first = await fakeRpc(t, request => {
    traffic.push(1); if (request.id === 1) captureIndex++;
    return { result: request.method === 'eth_chainId' ? `0x${BigInt(huge).toString(16)}`
      : request.method.startsWith('eth_getBlockBy') ? { number: '0x20000000000001', hash: OTHER } : protocolResult(request) };
  });
  let sameChainIndex = -1;
  const second = await fakeRpc(t, request => {
    traffic.push(2); if (request.id === 1) sameChainIndex++;
    return { result: request.method.startsWith('eth_getBlockBy') ? { number: `0x${(100 + sameChainIndex).toString(16)}`, hash: sameChainIndex ? OTHER : HASH } : protocolResult(request) };
  });
  const result = report(await cli(args(paths, ['private-2', 'private-1', 'private-3']), {
    PRIVATE_RPC_1: first.url, PRIVATE_RPC_2: second.url, PRIVATE_RPC_3: second.url
  }), 3, 0);
  assert.deepEqual(traffic, [...Array(8).fill(2), ...Array(8).fill(1), ...Array(8).fill(2)]);
  assert.equal(captureIndex, 0); assert.equal(sameChainIndex, 1);
  assert.deepEqual(result.outcomes.map(o => o.chainId), ['1', huge, '1']);
  assert.deepEqual(result.outcomes.map(o => o.block.number), ['0x64', '0x20000000000001', '0x65']);
  for (const fake of [first, second]) for (const request of fake.calls.filter(r => ['eth_getCode', 'eth_getStorageAt'].includes(r.method))) {
    assert.equal(request.params.at(-1).requireCanonical, true);
  }
});

test('batch common selectors and genesis/implementation/live beacon modes keep per-target budgets and formats', async t => {
  const selections = [[], ['--block', '100'], ['--block-hash', HASH], ['--depth', '0'], ['--depth', '1']];
  const modes = [['plain', []], ['direct', ['--implementation-code']], ['beacon', ['--implementation-code']],
    ['live', ['--resolve-beacon']], ['skip', ['--implementation-code']]];
  for (const genesis of [false, true]) for (const [mode, flags] of modes) for (const selection of selections) await t.test(`${genesis}/${mode}/${selection.join(' ')}`, async t => {
    const paths = await setup(t, [entry(1, { address: CHECKSUM }), entry(2, { address: CHECKSUM }), entry(3)]);
    const fake = await fakeRpc(t, r => {
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0') return { result: { number: '0x0', hash: GENESIS } };
      if (selection[0] === '--depth' && selection[1] === '1' && r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') return { result: { number: '0x65', hash: OTHER } };
      if (mode === 'skip' && r.method === 'eth_getCode') return { result: '0x' };
      if (['beacon', 'live'].includes(mode)) {
        if (r.method === 'eth_getStorageAt') return { result: r.params[1] === SLOTS.beacon ? word(BEACON) : EMPTY };
        if (r.method === 'eth_call') return { result: word(IMPL) };
      }
      return { result: protocolResult(r) };
    });
    const value = report(await cli([...args(paths), ...selection, ...flags, '--strict-checksum', ...(genesis ? ['--genesis'] : [])], {
      ...await guard(paths.dir, ['PRIVATE_RPC_1', 'PRIVATE_RPC_2'], { network: true }),
      PRIVATE_RPC_1: fake.url, PRIVATE_RPC_2: fake.url, PRIVATE_RPC_3: 'https://PRIVATE_UNUSED.invalid'
    }), 2, 0);
    const perTarget = (selection[0] === '--block-hash' || selection[1] === '1' ? 9 : 8) + (genesis ? 2 : 0)
      + ({ plain: 0, direct: 1, beacon: 2, live: 1, skip: 0 })[mode];
    assert.equal(fake.calls.length, 2 * perTarget);
    assert.deepEqual(fake.calls.slice(0, perTarget), fake.calls.slice(perTarget));
    for (const request of fake.calls.filter(r => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(r.method))) {
      assert.deepEqual(request.params.at(-1), { blockHash: HASH, requireCanonical: true });
    }
    for (const outcome of value.outcomes) {
      const path = join(paths.outputDir, outcome.file), saved = await readSnapshot(path);
      assert.equal(saved.schemaVersion, genesis ? 4 : flags[0] === '--implementation-code' ? 2 : 1);
      assert.equal(saved.address, CHECKSUM.toLowerCase()); assert.ok(!('beaconResolution' in saved));
      assert.equal(Boolean(outcome.beaconResolution), mode === 'live');
      if (mode === 'live') { assert.equal(outcome.beaconResolution.status, 'resolved'); assert.equal(outcome.beaconResolution.implementation, IMPL); }
      if (mode === 'skip') assert.equal(saved.implementation.reason, 'NO_TARGET_CODE');
    }
    const one = join(paths.outputDir, 'target-01.json'), two = join(paths.outputDir, 'target-02.json');
    assert.equal((await cli(['inspect', one])).code, 0);
    assert.equal((await cli(['diff', '--json', '--exit-code', one, two])).code, 0);
    assert.equal(fake.calls.length, 2 * perTarget);
  });
});

test('per-target initial/state/final/timeout failures never save that target or prevent the next capture', async t => {
  const cases = [
    ['initial chain', 1, 'CHAIN_MISMATCH', { result: '0x2' }],
    ['unavailable', 2, 'BLOCK_UNAVAILABLE', { result: null }],
    ['state', 3, 'RPC_REMOTE', { error: { code: -32000, message: 'PRIVATE_PROVIDER', data: 'https://PRIVATE_TOKEN' } }],
    ['reorg', 7, 'BLOCK_CHANGED', { result: { number: '0x64', hash: OTHER } }],
    ['final chain', 8, 'CHAIN_MISMATCH', { result: '0x2' }],
    ['timeout', 3, 'RPC_TIMEOUT', null]
  ];
  for (const [name, step, code, envelope] of cases) await t.test(name, async t => {
    const paths = await setup(t); let target = -1;
    const fake = await fakeRpc(t, r => { if (r.id === 1) target++;
      if (target === 1 && r.id === step) return envelope ?? undefined;
      return { result: protocolResult(r) };
    });
    const value = report(await cli([...args(paths, ['private-1', 'private-2', 'private-3']), '--timeout-ms', '100'], {
      PRIVATE_RPC_1: fake.url, PRIVATE_RPC_2: fake.url, PRIVATE_RPC_3: fake.url
    }), 2, 1);
    assert.deepEqual(value.outcomes.map(o => o.status), ['saved', 'failed', 'saved']);
    assert.equal(value.outcomes[1].error.code, code); assert.ok(!('file' in value.outcomes[1]));
    assert.deepEqual(await readdir(paths.outputDir), ['target-01.json', 'target-03.json']);
    assert.equal(fake.calls.length, 16 + step);
  });
});

test('batch directory race has one owner; collisions and write failures preserve earlier snapshots and cleanup', async t => {
  const paths = await setup(t); const fake = await fakeRpc(t);
  const env = { PRIVATE_RPC_1: fake.url, PRIVATE_RPC_2: fake.url };
  const results = await Promise.all([cli(args(paths), env), cli(args(paths), env)]);
  report(results.find(r => r.code === 0), 2, 0); globalFailure(results.find(r => r.code === 1), 'BATCH_EXISTS');
  assert.equal(fake.calls.length, 16); assert.deepEqual(await readdir(paths.outputDir), ['target-01.json', 'target-02.json']);
  const protectedFile = join(paths.dir, 'protected'); await writeFile(protectedFile, 'PRIVATE_KEEP');
  for (const fault of ['symlink', 'write-error']) {
    const outputDir = join(paths.dir, fault); const preload = join(paths.dir, `${fault}.mjs`);
    await writeFile(preload, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const original=fs.link;fs.link=async(from,to)=>{if(to.endsWith('/target-02.json')){
${fault === 'symlink' ? `await fs.symlink(${JSON.stringify(protectedFile)},to);` : "const e=Error('PRIVATE_WRITE');e.code='EIO';throw e;"}
}return original(from,to);};syncBuiltinESMExports();`);
    const value = report(await cli(args({ ...paths, outputDir }, ['private-1', 'private-2', 'private-3']), {
      ...env, PRIVATE_RPC_3: fake.url, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`
    }), 2, 1);
    assert.equal(value.outcomes[1].error.code, fault === 'symlink' ? 'FILE_EXISTS' : 'FILE_WRITE');
    for (const name of ['target-01.json', 'target-03.json']) await readSnapshot(join(outputDir, name));
    assert.equal(await readFile(protectedFile, 'utf8'), 'PRIVATE_KEEP');
    assert.ok(!(await readdir(outputDir)).some(name => name.endsWith('.tmp')));
    if (fault === 'write-error') assert.deepEqual(await readdir(outputDir), ['target-01.json', 'target-03.json']);
  }
});

test('all RPC failures retain an empty directory and no report is printed before every target attempt finishes', async t => {
  const paths = await setup(t);
  const bad = await fakeRpc(t, () => ({ error: { code: -32000, message: 'PRIVATE_REMOTE' } }));
  const failed = report(await cli(args(paths), { PRIVATE_RPC_1: bad.url, PRIVATE_RPC_2: bad.url }), 0, 2);
  assert.ok(failed.outcomes.every(o => o.error.code === 'RPC_REMOTE'));
  assert.equal(bad.calls.length, 2); assert.deepEqual(await readdir(paths.outputDir), []);

  const outputDir = join(paths.dir, 'delayed');
  let announce;
  const reached = new Promise(resolve => { announce = resolve; });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let target = -1;
  const fake = await fakeRpc(t, async r => {
    if (r.id === 1) target++;
    if (target === 1 && r.id === 1) { announce(); await waiting; }
    return { result: protocolResult(r) };
  });
  const child = spawn(process.execPath, [CLI, ...args({ ...paths, outputDir })], {
    cwd: ROOT, env: { ...process.env, PRIVATE_RPC_1: fake.url, PRIVATE_RPC_2: fake.url }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { release(); child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  await Promise.race([reached, done.then(() => { throw Error('Child ended before the second target'); })]);
  assert.equal(stdout, ''); assert.equal(stderr, '');
  assert.deepEqual(await readdir(outputDir), ['target-01.json']);
  await readSnapshot(join(outputDir, 'target-01.json')); // First publication completed before second RPC.
  release();
  report({ code: await done, stdout, stderr }, 2, 0);
});

test('batch JSON outcomes have independent golden expectations and legacy commands reject batch-only flags', async t => {
  const paths = await setup(t); const fake = await fakeRpc(t);
  const value = report(await cli(args(paths), { PRIVATE_RPC_1: fake.url }), 1, 1);
  const golden = JSON.parse(await readFile(new URL('./fixtures/batch/mixed.json', import.meta.url), 'utf8'));
  assert.deepEqual(value, golden);
  const file = join(paths.outputDir, 'target-01.json'), migrated = join(paths.dir, 'migrated.json');
  assert.equal((await cli(['inspect', file])).code, 0);
  assert.equal((await cli(['diff', '--json', '--exit-code', file, file])).code, 0);
  assert.equal((await cli(['migrate', file, '--to-version', '3', '--out', migrated])).code, 0);
  const guardEnv = await guard(paths.dir, [], { directory: false });
  for (const command of [
    ['snapshot', '--address', ADDRESS, '--chain-id', '1', '--out', 'x', '--out-dir', 'y'],
    ['snapshot', '--config', paths.configPath, '--target', 'private-1', '--target', 'private-2', '--out', 'x'],
    ['inspect', file, '--out-dir', 'x'], ['diff', file, file, '--out-dir', 'x'],
    ['migrate', file, '--to-version', '3', '--out', 'x', '--out-dir', 'y']
  ]) globalFailure(await cli(command, guardEnv), 'USAGE');
  assert.equal(fake.calls.length, 8);
});
