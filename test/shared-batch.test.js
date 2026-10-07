import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureMany } from '../src/batch.js';
import { readSnapshot, SLOTS } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, ADDRESS, HASH, EMPTY, word } from './helpers/fake-rpc.js';

const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const GENESIS = `0x${'c1'.repeat(32)}`, OTHER = `0x${'d2'.repeat(32)}`;
const BEACON = '0x3333333333333333333333333333333333333333';
const IMPL = '0x4444444444444444444444444444444444444444';
const entry = (i, extra = {}) => ({ name: `private-${i}`, address: ADDRESS, chainId: '1', rpcEnv: `PRIVATE_RPC_${i}`, ...extra });
async function setup(t, entries = [entry(1), entry(2), entry(3)]) {
  const dir = await temporaryDirectory(t), configPath = join(dir, 'PRIVATE_CONFIG.json'), outputDir = join(dir, 'PRIVATE_BATCH');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, targets: entries }), { mode: 0o640 });
  return { dir, configPath, outputDir, names: entries.map(e => e.name) };
}
const args = p => ['snapshot-many', '--shared-block', '--config', p.configPath,
  ...p.names.flatMap(name => ['--target', name]), '--out-dir', p.outputDir];
function safe(text) { assert.doesNotMatch(text, /PRIVATE_|private-|https?:|rpcEnv|\.tmp|\n\s+at\s|\u001b/); }
function report(result, saved, failed) {
  assert.equal(result.code, failed ? 1 : 0, result.stderr); assert.equal(result.stderr, ''); safe(result.stdout);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value), ['kind', 'schemaVersion', 'mode', 'groups', 'selected', 'saved', 'failed', 'outcomes']);
  assert.equal(value.kind, 'contract-watch-batch'); assert.equal(value.schemaVersion, 2); assert.equal(value.mode, 'shared-block');
  assert.equal(value.selected, saved + failed); assert.equal(value.saved, saved); assert.equal(value.failed, failed);
  assert.deepEqual(value.outcomes.map(o => o.ordinal), Array.from({ length: saved + failed }, (_, i) => i + 1));
  for (const o of value.outcomes) if (o.status === 'failed') assert.deepEqual(Object.keys(o), ['ordinal', 'address', 'chainId', 'status', 'error']);
  return value;
}
function baseResult(r, { chain = '0x1', number = '0x64', hash = HASH, genesis = GENESIS, mode = 'plain' } = {}) {
  if (r.method === 'eth_chainId') return chain;
  if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0') return { number: '0x0', hash: genesis };
  if (r.method.startsWith('eth_getBlockBy')) return { number, hash };
  if (r.method === 'eth_getCode') return mode === 'skip' || (mode === 'no-code' && r.params[0] === IMPL) ? '0x' : '0x60006000';
  if (r.method === 'eth_getStorageAt') {
    if (['beacon', 'live'].includes(mode)) return r.params[1] === SLOTS.beacon ? word(BEACON) : EMPTY;
    if (['direct', 'no-code'].includes(mode)) return r.params[1] === SLOTS.implementation ? word(IMPL) : EMPTY;
    if (mode === 'noncanonical' && r.params[1] === SLOTS.admin) return `0x${'ff'.repeat(32)}`;
    return EMPTY;
  }
  if (r.method === 'eth_call') return word(IMPL);
  throw Error('Unexpected test method');
}
const call = (method, params = []) => ({ method, params });
const numbered = calls => calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, ...c }));
function captureTrace({ genesis, mode, target = CHECKSUM.toLowerCase(), number = '0x64', hash = HASH }) {
  const selector = { blockHash: hash, requireCanonical: true };
  return numbered([
    call('eth_chainId'), ...(genesis ? [call('eth_getBlockByNumber', ['0x0', false])] : []),
    call('eth_getBlockByHash', [hash, false]), call('eth_getBlockByNumber', [number, false]),
    call('eth_getCode', [target, selector]),
    ...Object.values(SLOTS).map(slot => call('eth_getStorageAt', [target, slot, selector])),
    ...(['beacon', 'live'].includes(mode) ? [call('eth_call', [{ from: target, to: BEACON, gas: '0x186a0', value: '0x0', input: '0x5c60da1b' }, selector])] : []),
    ...(['direct', 'beacon', 'no-code'].includes(mode) ? [call('eth_getCode', [IMPL, selector])] : []),
    call('eth_getBlockByNumber', [number, false]), ...(genesis ? [call('eth_getBlockByNumber', ['0x0', false])] : []), call('eth_chainId')
  ]);
}

test('shared anchor: three moving-head targets keep exact traces and metadata for every selector/feature combination', async t => {
  const selections = [[], ['--block', 'latest'], ['--block', 'safe'], ['--block', 'finalized'], ['--block', '100'], ['--block-hash', HASH], ['--depth', '0'], ['--depth', '1']];
  const modes = ['plain', 'direct', 'beacon', 'skip', 'no-code', 'noncanonical', 'live', 'live-skip'];
  for (const genesis of [false, true]) for (const mode of modes) for (const selection of selections) await t.test(`${genesis}/${mode}/${selection.join(' ')}`, async t => {
    const paths = await setup(t, [1, 2, 3].map(i => entry(i, { address: CHECKSUM })));
    const before = await readFile(paths.configPath), initial = await stat(paths.configPath);
    let movingReads = 0; const traffic = [];
    const fake = await fakeRpc(t, (r, response, incoming) => {
      traffic.push(incoming.url);
      if (r.method === 'eth_getBlockByNumber' && ['latest', 'safe', 'finalized'].includes(r.params[0])) {
        const head = 100 + (selection[0] === '--depth' && selection[1] === '1' ? 1 : 0) + movingReads++;
        return { result: { number: `0x${head.toString(16)}`, hash: head === 100 ? HASH : OTHER } };
      }
      return { result: baseResult(r, { mode: mode === 'live-skip' ? 'plain' : mode }) };
    });
    const flags = mode.startsWith('live') ? ['--resolve-beacon'] : mode === 'plain' ? [] : ['--implementation-code'];
    const value = report(await cli([...args(paths), ...selection, ...flags, '--strict-checksum', ...(genesis ? ['--genesis'] : [])],
      Object.fromEntries([1, 2, 3].map(i => [`PRIVATE_RPC_${i}`, `${fake.url}/PRIVATE_${i}`]))), 3, 0);
    const byHash = selection[0] === '--block-hash', positiveDepth = selection[0] === '--depth' && selection[1] === '1';
    const selector = byHash ? HASH : selection[0] === '--block' ? (selection[1] === '100' ? '0x64' : selection[1]) : 'latest';
    const resolver = numbered([call('eth_chainId'), ...(genesis ? [call('eth_getBlockByNumber', ['0x0', false])] : []),
      call(byHash ? 'eth_getBlockByHash' : 'eth_getBlockByNumber', [selector, false]),
      ...(byHash || positiveDepth ? [call('eth_getBlockByNumber', ['0x64', false])] : [])]);
    const trace = captureTrace({ genesis, mode });
    assert.deepEqual(fake.calls, [...resolver, ...trace, ...trace, ...trace]);
    assert.deepEqual(traffic, [...Array(resolver.length + trace.length).fill('/PRIVATE_1'), ...Array(trace.length).fill('/PRIVATE_2'), ...Array(trace.length).fill('/PRIVATE_3')]);
    assert.equal(movingReads, byHash || selector === '0x64' ? 0 : 1);
    assert.deepEqual(value.groups, [{ chainId: '1', leaderOrdinal: 1, status: 'resolved', block: { number: '0x64', hash: HASH }, ...(genesis ? { genesis: { status: 'observed', hash: GENESIS } } : {}) }]);
    for (const outcome of value.outcomes) {
      const file = join(paths.outputDir, outcome.file), snapshot = await readSnapshot(file);
      assert.deepEqual(snapshot.block, value.groups[0].block); assert.deepEqual(outcome.block, snapshot.block);
      assert.equal(snapshot.schemaVersion, genesis ? 4 : flags[0] === '--implementation-code' ? 2 : 1);
      assert.equal(outcome.snapshotVersion, snapshot.schemaVersion); assert.ok(!('beaconResolution' in snapshot));
      assert.equal(Boolean(outcome.beaconResolution), mode.startsWith('live'));
      if (genesis) assert.deepEqual(snapshot.genesis, value.groups[0].genesis);
      safe(await readFile(file, 'utf8')); assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(paths.outputDir)).mode & 0o777, 0o700);
    assert.deepEqual(await readFile(paths.configPath), before); assert.equal((await stat(paths.configPath)).mtimeMs, initial.mtimeMs);
    assert.equal((await cli(['inspect', join(paths.outputDir, 'target-01.json')])).code, 0);
    assert.equal((await cli(['diff', '--json', '--exit-code', join(paths.outputDir, 'target-01.json'), join(paths.outputDir, 'target-03.json')])).code, 0);
    assert.equal(fake.calls.length, resolver.length + 3 * trace.length);
  });
});

test('interleaved chain aliases select first explicit members, including uint256 IDs/heights and one/32 targets', async t => {
  const huge = (1n << 256n) - 1n, number = `0x${huge.toString(16)}`;
  for (const count of [1, 4, 32]) await t.test(String(count), async t => {
    const entries = Array.from({ length: count }, (_, i) => entry(i + 1, { chainId: i % 2 ? (i % 4 === 1 ? huge.toString() : number) : (i % 4 ? '0x01' : '1') }));
    const paths = await setup(t, entries); paths.names.reverse();
    const traffic = [], reads = [];
    const fake = await fakeRpc(t, (r, response, incoming) => {
      const index = Number(incoming.url.slice(1)); traffic.push(index);
      return { result: baseResult(r, { chain: index % 2 ? '0x1' : number, number, hash: index % 2 ? HASH : OTHER }) };
    });
    const env = new Proxy(Object.fromEntries(entries.map((e, i) => [e.rpcEnv, `${fake.url}/${i + 1}`])), { get(o, k) { reads.push(k); return Reflect.get(o, k); } });
    const result = await captureMany({ ...paths, sharedBlock: true }, env);
    assert.equal(result.saved, count); assert.equal(result.failed, 0);
    assert.deepEqual(reads, entries.map(e => e.rpcEnv).reverse());
    assert.equal(result.groups.length, Math.min(count, 2));
    assert.deepEqual(result.groups.map(g => g.leaderOrdinal), count === 1 ? [1] : [1, 2]);
    assert.deepEqual(result.groups.map(g => g.chainId), count === 1 ? ['1'] : [huge.toString(), '1']);
    assert.deepEqual(traffic, paths.names.flatMap((name, i) => Array(9 + (i < Math.min(count, 2) ? 2 : 0)).fill(Number(name.split('-')[1]))));
    for (const o of result.outcomes) {
      assert.equal(o.block.number, number); assert.equal(o.block.hash, o.chainId === '1' ? HASH : OTHER);
      assert.deepEqual((await readSnapshot(join(paths.outputDir, o.file))).block, o.block);
    }
    assert.equal(fake.calls.length, 9 * count + 2 * Math.min(count, 2)); safe(JSON.stringify(result));
  });
});

async function guard(dir) {
  const path = join(dir, 'guard.mjs');
  await writeFile(path, `import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';let calls=0;const forbidden=()=>{calls++;throw Error('PRIVATE_FORBIDDEN');};process.env=new Proxy(process.env,{get(t,k){if(k==='CONTRACT_WATCH_RPC_URL'||String(k).startsWith('PRIVATE_RPC_'))return forbidden();return Reflect.get(t,k);}});http.request=forbidden;https.request=forbidden;globalThis.fetch=forbidden;fs.mkdir=forbidden;syncBuiltinESMExports();process.on('exit',()=>assert.equal(calls,0));`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(path).href}` };
}
test('shared flag is valueless/unique/batch-only and all inputs precede env, directory and RPC', async t => {
  const paths = await setup(t), env = await guard(paths.dir), base = args(paths);
  const invalid = [
    [[...base, '--shared-block'], 'USAGE'], [[...base, 'true'], 'USAGE'], [[...base, '--shared-block=true'], 'USAGE'],
    [[...base, '--block', 'latest', '--depth', '1'], 'USAGE'], [[...base, '--depth', '01'], 'DEPTH'],
    [[...base, '--resolve-beacon', '--implementation-code'], 'USAGE'], [[...base, '--timeout-ms', '1'], 'TIMEOUT_OPTION'],
    [args({ ...paths, names: [...paths.names, paths.names[0]] }), 'BATCH_TARGETS'],
    [args({ ...paths, names: Array.from({ length: 33 }, (_, i) => `private-${i}`) }), 'BATCH_TARGETS'],
    [args({ ...paths, names: [] }), 'USAGE'], [args({ ...paths, names: ['private-1', 'absent'] }), 'CONFIG_TARGET'],
    [['snapshot', '--address', ADDRESS, '--chain-id', '1', '--out', 'x', '--shared-block'], 'USAGE'],
    [['inspect', 'x', '--shared-block'], 'USAGE'], [['diff', 'x', 'y', '--shared-block'], 'USAGE'],
    [['migrate', 'x', '--out', 'y', '--to-version', '3', '--shared-block'], 'USAGE']
  ];
  for (const [command, code] of invalid) {
    const result = await cli(command, env); assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]:`)); safe(result.stderr);
  }
  for (const [entries, code] of [[ [entry(1), entry(2, { address: CHECKSUM.toLowerCase() })], 'ADDRESS_CHECKSUM'], [[entry(1), entry(2, { chainId: 7 })], 'CONFIG']]) {
    await writeFile(paths.configPath, JSON.stringify({ schemaVersion: 1, targets: entries }));
    const result = await cli([...args({ ...paths, names: entries.map(e => e.name) }), '--strict-checksum'], env);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, new RegExp(`^Error \\[${code}\\]:`));
  }
  assert.deepEqual(await readdir(paths.dir), ['PRIVATE_CONFIG.json', 'guard.mjs']);
});

test('leader resolution failures block only their group, never read blocked env or reselect a source', async t => {
  const cases = [
    { name: 'missing env', env: 'missing', code: 'CONFIG_ENV', count: 0 },
    { name: 'invalid env', env: 'invalid', code: 'CONFIG_ENV', count: 0 },
    { name: 'throwing env', env: 'throw', code: 'CONFIG_ENV', count: 0 },
    { name: 'wrong chain', at: 1, result: '0x2', code: 'CHAIN_MISMATCH', count: 1 },
    { name: 'malformed chain', at: 1, result: 'PRIVATE_BAD', code: 'RPC_DATA', count: 1 },
    { name: 'unavailable', at: 2, result: null, code: 'BLOCK_UNAVAILABLE', count: 2 },
    { name: 'malformed header', at: 2, result: { number: '0x64', hash: 'PRIVATE_HASH' }, code: 'RPC_DATA', count: 2 },
    { name: 'wrong number', options: { block: '100' }, at: 2, result: { number: '0x65', hash: HASH }, code: 'RPC_DATA', count: 2 },
    { name: 'wrong hash', options: { blockHash: HASH }, at: 2, result: { number: '0x64', hash: OTHER }, code: 'RPC_DATA', count: 2 },
    { name: 'noncanonical hash', options: { blockHash: HASH }, at: 3, result: { number: '0x64', hash: OTHER }, code: 'BLOCK_NOT_CANONICAL', count: 3 },
    { name: 'depth underflow', options: { depth: '1' }, at: 2, result: { number: '0x0', hash: GENESIS }, code: 'DEPTH_UNDERFLOW', count: 2 },
    { name: 'wrong depth height', options: { depth: '1' }, at: 3, result: { number: '0x65', hash: HASH }, code: 'RPC_DATA', count: 3 },
    { name: 'timeout', at: 2, wait: true, code: 'RPC_TIMEOUT', count: 2 },
    { name: 'remote', at: 2, error: true, code: 'RPC_REMOTE', count: 2 },
    { name: 'malformed envelope', at: 2, malformed: true, code: 'RPC_ENVELOPE', count: 2 },
    { name: 'zero genesis', options: { genesis: true }, at: 2, result: { number: '0x0', hash: EMPTY }, code: 'RPC_DATA', count: 2 },
    { name: 'selected genesis differs', options: { genesis: true, block: '0' }, at: 3, result: { number: '0x0', hash: OTHER }, code: 'GENESIS_CHANGED', count: 3 }
  ];
  for (const fault of cases) await t.test(fault.name, async t => {
    const paths = await setup(t, [entry(1), entry(2, { chainId: '2' }), entry(3)]), reads = [], traffic = [];
    const options = { timeoutMs: 100, ...fault.options };
    const fake = await fakeRpc(t, (r, res, req) => {
      traffic.push(req.url);
      if (req.url === '/1' && r.id === fault.at) {
        if (fault.wait) return;
        if (fault.error) return { error: { code: -32000, message: 'PRIVATE_PROVIDER', data: 'https://PRIVATE_TOKEN' } };
        if (fault.malformed) { res.end('PRIVATE_INVALID_JSON'); return; }
        return { result: fault.result };
      }
      if (options.depth && r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') return { result: { number: '0x65', hash: OTHER } };
      return { result: baseResult(r, { chain: req.url === '/2' ? '0x2' : '0x1', ...(options.block === '0' ? { number: '0x0', hash: GENESIS } : {}) }) };
    });
    const object = { PRIVATE_RPC_2: `${fake.url}/2` };
    if (fault.env !== 'missing') Object.defineProperty(object, 'PRIVATE_RPC_1', { get() { if (fault.env === 'throw') throw Error('PRIVATE_ENV'); return fault.env === 'invalid' ? 'https://PRIVATE_BAD/#secret' : `${fake.url}/1`; } });
    Object.defineProperty(object, 'PRIVATE_RPC_3', { get() { throw Error('Blocked group must not read env'); } });
    const env = new Proxy(object, { get(o, k) { reads.push(k); return Reflect.get(o, k); } });
    const value = await captureMany({ ...paths, options, sharedBlock: true }, env);
    assert.equal(value.saved, 1); assert.equal(value.failed, 2);
    assert.deepEqual(value.outcomes.map(o => o.error?.code ?? o.status), [fault.code, 'saved', 'SHARED_BLOCK_UNAVAILABLE']);
    assert.deepEqual(value.groups[0], { chainId: '1', leaderOrdinal: 1, status: 'unavailable', error: value.outcomes[0].error });
    assert.equal(value.groups[1].status, 'resolved'); assert.equal(value.groups[1].leaderOrdinal, 2);
    assert.deepEqual(reads, fault.env === 'missing' ? ['PRIVATE_RPC_2'] : ['PRIVATE_RPC_1', 'PRIVATE_RPC_2']);
    const group2 = 11 + (options.genesis ? 3 : 0) + (options.depth || options.blockHash ? 1 : 0);
    assert.deepEqual(traffic, [...Array(fault.count).fill('/1'), ...Array(group2).fill('/2')]);
    assert.deepEqual(await readdir(paths.outputDir), ['target-02.json']); safe(JSON.stringify(value));
  });
});

test('each provider validates the fixed anchor and genesis; later failures retain the anchor and other successes', async t => {
  const cases = [
    { name: 'follower wrong chain', at: 1, result: '0x2', code: 'CHAIN_MISMATCH' },
    { name: 'anchor missing', at: 2, result: null, code: 'BLOCK_UNAVAILABLE' },
    { name: 'anchor wrong number', at: 2, result: { number: '0x65', hash: HASH }, code: 'RPC_DATA' },
    { name: 'anchor wrong hash', at: 2, result: { number: '0x64', hash: OTHER }, code: 'RPC_DATA' },
    { name: 'canonical wrong number', at: 3, result: { number: '0x65', hash: HASH }, code: 'RPC_DATA' },
    { name: 'noncanonical anchor', at: 3, result: { number: '0x64', hash: OTHER }, code: 'BLOCK_NOT_CANONICAL' },
    { name: 'EIP-1898 unsupported', at: 4, error: true, code: 'RPC_REMOTE' },
    { name: 'malformed state', at: 5, result: 'PRIVATE_STATE', code: 'RPC_DATA' },
    { name: 'state timeout', at: 4, wait: true, code: 'RPC_TIMEOUT' },
    { name: 'final reorg', at: 8, result: { number: '0x64', hash: OTHER }, code: 'BLOCK_CHANGED' },
    { name: 'final chain', at: 9, result: '0x2', code: 'CHAIN_MISMATCH' },
    { name: 'other genesis', genesis: true, at: 2, result: { number: '0x0', hash: OTHER }, code: 'SHARED_GENESIS_MISMATCH' },
    { name: 'final genesis', genesis: true, at: 10, result: { number: '0x0', hash: OTHER }, code: 'GENESIS_CHANGED' },
    { name: 'leader capture fails after resolution', leader: true, at: 4, error: true, code: 'RPC_REMOTE' }
  ];
  for (const fault of cases) await t.test(fault.name, async t => {
    const paths = await setup(t, [entry(1), entry(4, { chainId: '2' }), entry(2), entry(3)]);
    const traffic = []; let leaderPhase = -1;
    const fake = await fakeRpc(t, (r, res, req) => {
      traffic.push(req.url); if (req.url === '/1' && r.id === 1) leaderPhase++;
      const inject = fault.leader ? req.url === '/1' && leaderPhase === 1 : req.url === '/2';
      if (inject && r.id === fault.at) {
        if (fault.wait) return;
        return fault.error ? { error: { code: -32602, message: 'PRIVATE_UNSUPPORTED' } } : { result: fault.result };
      }
      return { result: baseResult(r, { chain: req.url === '/4' ? '0x2' : '0x1' }) };
    });
    const result = report(await cli([...args(paths), '--timeout-ms', '100', ...(fault.genesis ? ['--genesis'] : [])],
      Object.fromEntries([1, 2, 3, 4].map(i => [`PRIVATE_RPC_${i}`, `${fake.url}/${i}`]))), 3, 1);
    const failedOrdinal = fault.leader ? 1 : 3;
    assert.equal(result.outcomes[failedOrdinal - 1].error.code, fault.code);
    assert.ok(result.groups.every(g => g.status === 'resolved')); assert.deepEqual(result.groups.map(g => g.leaderOrdinal), [1, 2]);
    const resolver = fault.genesis ? 3 : 2, full = fault.genesis ? 11 : 9;
    assert.deepEqual(traffic, [...Array(resolver + (fault.leader ? fault.at : full)).fill('/1'), ...Array(resolver + full).fill('/4'), ...Array(fault.leader ? full : fault.at).fill('/2'), ...Array(full).fill('/3')]);
    assert.equal(fake.calls.filter(r => r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest').length, 2);
    for (const r of fake.calls.filter(r => ['eth_getCode', 'eth_getStorageAt'].includes(r.method))) assert.deepEqual(r.params.at(-1), { blockHash: HASH, requireCanonical: true });
    assert.deepEqual(await readdir(paths.outputDir), [1, 2, 3, 4].filter(i => i !== failedOrdinal).map(i => `target-0${i}.json`));
    for (const o of result.outcomes.filter(o => o.status === 'saved')) assert.deepEqual((await readSnapshot(join(paths.outputDir, o.file))).block, { number: '0x64', hash: HASH });
  });
});

test('shared env reads occur once per attempted target, after the preceding publication; later env errors do not poison groups', async t => {
  const paths = await setup(t), reads = []; const fake = await fakeRpc(t, r => ({ result: baseResult(r) }));
  const env = Object.fromEntries([1, 2, 3].map(i => [`PRIVATE_RPC_${i}`, `${fake.url}/${i}`]));
  const value = await captureMany({ ...paths, sharedBlock: true }, new Proxy(env, { get(o, k) {
    reads.push([k, fake.calls.length]); if (k === 'PRIVATE_RPC_2') throw Error('PRIVATE_THROW'); return Reflect.get(o, k);
  } }));
  assert.deepEqual(reads, [['PRIVATE_RPC_1', 0], ['PRIVATE_RPC_2', 11], ['PRIVATE_RPC_3', 11]]);
  assert.deepEqual(value.outcomes.map(o => o.error?.code ?? o.status), ['saved', 'CONFIG_ENV', 'saved']);
  assert.equal(fake.calls.length, 20); assert.equal(value.groups[0].status, 'resolved');
  assert.deepEqual(await readdir(paths.outputDir), ['target-01.json', 'target-03.json']);
});

test('shared directory races have one owner; failed leader/other writes preserve anchor, private successes and cleanup', async t => {
  const paths = await setup(t), fake = await fakeRpc(t, r => ({ result: baseResult(r) }));
  const env = Object.fromEntries([1, 2, 3].map(i => [`PRIVATE_RPC_${i}`, fake.url]));
  const race = await Promise.all([cli(args(paths), env), cli(args(paths), env)]);
  report(race.find(r => r.code === 0), 3, 0);
  const loser = race.find(r => r.code === 1); assert.equal(loser.stdout, ''); assert.match(loser.stderr, /^Error \[BATCH_EXISTS\]:/);
  assert.equal(fake.calls.length, 29);
  const keep = join(paths.dir, 'keep'); await writeFile(keep, 'PRIVATE_KEEP');
  for (const [ordinal, fault] of [[1, 'io'], [2, 'symlink']]) {
    const out = { ...paths, outputDir: join(paths.dir, `out-${ordinal}`) }, preload = join(paths.dir, `preload-${ordinal}.mjs`);
    await writeFile(preload, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const link=fs.link;fs.link=async(from,to)=>{if(to.endsWith('/target-0${ordinal}.json')){${fault === 'io' ? "const e=Error('PRIVATE_WRITE');e.code='EIO';throw e;" : `await fs.symlink(${JSON.stringify(keep)},to);`}}return link(from,to);};syncBuiltinESMExports();`);
    const value = report(await cli(args(out), { ...env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }), 2, 1);
    assert.equal(value.outcomes[ordinal - 1].error.code, fault === 'io' ? 'FILE_WRITE' : 'FILE_EXISTS');
    assert.equal(value.groups[0].status, 'resolved');
    for (const o of value.outcomes.filter(o => o.status === 'saved')) await readSnapshot(join(out.outputDir, o.file));
    assert.ok(!(await readdir(out.outputDir)).some(n => n.endsWith('.tmp'))); assert.equal(await readFile(keep, 'utf8'), 'PRIVATE_KEEP');
  }
  assert.equal(fake.calls.length, 3 * 29);
});

test('independent golden v2 report contains unavailable/resolved groups and strict ordinary offline files', async t => {
  const paths = await setup(t, [entry(1), entry(2, { chainId: '2' }), entry(3), entry(4, { chainId: '0x02' })]);
  const fake = await fakeRpc(t, r => ({ result: baseResult(r, { chain: '0x2' }) }));
  const value = report(await cli(args(paths), { PRIVATE_RPC_2: fake.url, PRIVATE_RPC_3: fake.url, PRIVATE_RPC_4: fake.url }), 2, 2);
  assert.deepEqual(value, JSON.parse(await readFile(new URL('./fixtures/batch/shared-mixed.json', import.meta.url), 'utf8')));
  const a = join(paths.outputDir, 'target-02.json'), b = join(paths.outputDir, 'target-04.json'), migrated = join(paths.dir, 'migrated.json');
  assert.equal((await cli(['inspect', a])).code, 0); assert.equal((await cli(['diff', '--json', '--exit-code', a, b])).code, 0);
  assert.equal((await cli(['migrate', a, '--to-version', '3', '--out', migrated])).code, 0);
  assert.equal((await readSnapshot(migrated)).schemaVersion, 3); assert.equal(fake.calls.length, 20);
  const all = { ...paths, outputDir: join(paths.dir, 'all-failed'), names: ['private-1', 'private-3'] };
  const failed = report(await cli(args(all)), 0, 2); assert.equal(failed.groups[0].status, 'unavailable');
  assert.deepEqual(await readdir(all.outputDir), []); assert.equal(fake.calls.length, 20);
});

test('separate providers retain one anchor despite advancing heads, with independently observed genesis', async t => {
  const paths = await setup(t); const reads = []; let selected = 0;
  const leader = await fakeRpc(t, r => {
    if (r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') selected++;
    return { result: baseResult(r) };
  });
  const follower = await fakeRpc(t, r => {
    assert.ok(!(r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest'));
    return { result: baseResult(r) };
  });
  const divergent = await fakeRpc(t, r => ({ result: baseResult(r, { genesis: OTHER }) }));
  const object = { PRIVATE_RPC_1: leader.url, PRIVATE_RPC_2: follower.url, PRIVATE_RPC_3: divergent.url };
  const value = await captureMany({ ...paths, sharedBlock: true, options: { genesis: true } }, new Proxy(object, { get(o,k) { reads.push(k); return Reflect.get(o,k); } }));
  assert.deepEqual(reads, ['PRIVATE_RPC_1', 'PRIVATE_RPC_2', 'PRIVATE_RPC_3']); assert.equal(selected, 1);
  assert.equal(leader.calls.length, 14); assert.equal(follower.calls.length, 11); assert.equal(divergent.calls.length, 2);
  assert.deepEqual(value.outcomes.map(o => o.error?.code ?? o.status), ['saved', 'saved', 'SHARED_GENESIS_MISMATCH']);
  assert.equal(value.groups[0].genesis.hash, GENESIS);
});

test('32 distinct groups stay bounded and use independent first-member anchors', async t => {
  const paths = await setup(t, Array.from({ length: 32 }, (_, i) => entry(i + 1, { chainId: String(i + 1) })));
  const fake = await fakeRpc(t, (r, response, req) => ({ result: baseResult(r, { chain: `0x${BigInt(req.url.slice(1)).toString(16)}` }) }));
  const value = await captureMany({ ...paths, sharedBlock: true }, Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`PRIVATE_RPC_${i + 1}`, `${fake.url}/${i + 1}`])));
  assert.equal(value.saved, 32); assert.equal(value.groups.length, 32); assert.equal(fake.calls.length, 32 * 11);
  assert.deepEqual(value.groups.map(g => g.leaderOrdinal), Array.from({ length: 32 }, (_, i) => i + 1));
});

test('shared genesis anchor at block zero stays exact for hash/number/depth and every saved v4 file', async t => {
  for (const options of [{ block: '0' }, { blockHash: GENESIS }, { depth: '100' }]) await t.test(JSON.stringify(options), async t => {
    const paths = await setup(t); let heads = 0;
    const fake = await fakeRpc(t, r => {
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') { heads++; return { result: { number: '0x64', hash: HASH } }; }
      return { result: baseResult(r, { number: '0x0', hash: GENESIS }) };
    });
    const value = await captureMany({ ...paths, sharedBlock: true, options: { ...options, genesis: true } }, Object.fromEntries([1, 2, 3].map(i => [`PRIVATE_RPC_${i}`, fake.url])));
    assert.equal(value.saved, 3); assert.equal(heads, options.depth ? 1 : 0);
    assert.equal(fake.calls.length, 36 + (options.blockHash || options.depth ? 1 : 0));
    for (const o of value.outcomes) { const snapshot = await readSnapshot(join(paths.outputDir, o.file)); assert.deepEqual(snapshot.block, { number: '0x0', hash: GENESIS }); assert.equal(snapshot.genesis.hash, GENESIS); }
  });
});
