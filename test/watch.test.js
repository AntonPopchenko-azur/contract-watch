import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { watchSession, runWatch } from '../src/watch.js';
import { readSnapshot, SLOTS } from '../src/snapshot.js';
import { ADDRESS, HASH, EMPTY, IMPLEMENTATION, word, protocolResult, fakeRpc, temporaryDirectory, cli } from './helpers/fake-rpc.js';

const args = (output, extra = []) => ['watch', '--address', ADDRESS, '--chain-id', '1', '--out-dir', output,
  '--interval-ms', '100', ...extra];
const settings = (outputDir, rpcUrl, extra = {}) => ({ outputDir, intervalMs: '100', count: '1',
  options: { address: ADDRESS, chainId: '1', rpcUrl }, ...extra });
const methods = ['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_getStorageAt',
  'eth_getStorageAt','eth_getBlockByNumber','eth_chainId'];
function host() {
  const h = new EventEmitter(); h.out = ''; h.err = '';
  h.stdout = { write: s => { h.out += s; } }; h.stderr = { write: s => { h.err += s; } }; return h;
}
async function config(dir, chainId = '1', address = ADDRESS) {
  const path = join(dir, 'PRIVATE_CONFIG.json');
  await fs.writeFile(path, JSON.stringify({ schemaVersion: 1, targets: [
    { name: 'private-selected', address, chainId, rpcEnv: 'PRIVATE_SELECTED' },
    { name: 'private-unused', address: ADDRESS, chainId: '1', rpcEnv: 'PRIVATE_UNUSED' }
  ] }));
  return path;
}

test('three observations independently resolve moving heads; exact traces, private files and offline reuse', async t => {
  const dir = await temporaryDirectory(t), output = join(dir, 'session');
  let height = 100n, active = 0, max = 0;
  const fake = await fakeRpc(t, (r, res) => {
    active++; max = Math.max(max, active); res.once('close', () => { active--; });
    if (r.method === 'eth_getBlockByNumber') {
      if (r.params[0] === 'latest') height++;
      return { result: { number: `0x${height.toString(16)}`, hash: `0x${height.toString(16).padStart(64,'0')}` } };
    }
    return { result: protocolResult(r) };
  });
  const result = await cli(args(output, ['--count','3']), { CONTRACT_WATCH_RPC_URL: fake.url });
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, {
    kind: 'contract-watch-session', schemaVersion: 1, address: ADDRESS, chainId: '1',
    limits: { intervalMs: 100, count: 3, durationMs: null, maxAttempts: 128 },
    stopReason: 'count', attempted: 3, saved: 3, failed: 0, stopped: 0,
    outcomes: [101,102,103].map((n,i) => ({ ordinal: i+1, status: 'saved', file: `observation-00${i+1}.json`,
      snapshotVersion: 1, block: { number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64,'0')}` } }))
  });
  assert.equal(fake.calls.length, 24); assert.equal(max, 1); assert.equal(active, 0);
  for (let i = 0; i < 3; i++) {
    const calls = fake.calls.slice(i*8, (i+1)*8);
    assert.deepEqual(calls.map(r => r.method), methods);
    assert.deepEqual(calls[1].params, ['latest',false]);
    for (const r of calls.slice(2,6)) assert.deepEqual(r.params.at(-1), { blockHash: report.outcomes[i].block.hash, requireCanonical: true });
    assert.deepEqual(calls[6].params, [report.outcomes[i].block.number,false]);
    const path = join(output, report.outcomes[i].file);
    const snapshot = await readSnapshot(path);
    assert.equal(snapshot.source, 'rpc'); assert.equal(snapshot.schemaVersion, 1);
    assert.ok(Math.abs(Date.parse(snapshot.capturedAt) - Date.now()) < 30000);
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(output), ['observation-001.json','observation-002.json','observation-003.json']);
  const first = join(output, 'observation-001.json'), last = join(output, 'observation-003.json');
  for (const argv of [['inspect', first], ['diff','--json',first,last],
    ['migrate',first,'--to-version','4','--out',join(dir,'migrated.json')],
    ['history','init',first,'--dir',join(dir,'history')], ['history','add',first,'--dir',join(dir,'history')]]) {
    const offline = await cli(argv, { CONTRACT_WATCH_RPC_URL: fake.url }); assert.equal(offline.code, 0, offline.stderr);
  }
  assert.equal(fake.calls.length, 24);
});

for (const outcomes of [[false,true,false],[true,true,true]]) test(`failed observations consume ordinals: ${outcomes}`, async t => {
  const dir = await temporaryDirectory(t), output = join(dir, 'session');
  let ordinal = 0, finalChain = false;
  const fake = await fakeRpc(t, r => {
    if (r.method === 'eth_chainId') {
      if (finalChain) finalChain = false;
      else { ordinal++; if (outcomes[ordinal-1]) return { error: { code: -32000, message: 'PRIVATE_PROVIDER_URL' } }; }
    }
    if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x64') finalChain = true;
    return { result: protocolResult(r) };
  });
  const result = await cli(args(output, ['--count','3']), { CONTRACT_WATCH_RPC_URL: fake.url });
  assert.equal(result.code, 1); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.attempted, 3); assert.equal(report.failed, outcomes.filter(Boolean).length);
  assert.deepEqual(report.outcomes.map(o => o.status), outcomes.map(f => f ? 'failed' : 'saved'));
  assert.equal(fake.calls.length, outcomes.reduce((n,f) => n+(f ? 1 : 8),0));
  assert.deepEqual(await fs.readdir(output), outcomes.flatMap((f,i) => f ? [] : [`observation-00${i+1}.json`]));
  assert.ok(!result.stdout.includes('PRIVATE'));
});

for (const extra of [
  [], ['--count','0'], ['--count','129'], ['--duration-ms','99'], ['--count','01'], ['--count','1','--count','2'],
  ['--count=1'], ['--count'], ['--count','1','--target','x'], ['--count','1','--concurrency','1'],
  ['--count','1','--shared-block'], ['--count','1','--json'], ['--count','1','--out','unused'],
  ['--count','1','--block','latest','--depth','0'], ['--count','1','--resolve-beacon','--implementation-code'],
  ['--count','1','--timeout-ms','0100'], ['--count','1','--retries','1'],
  ['--count','1','--retries','01'], ['--count','1','--deadline-ms','0100']
]) test(`invalid watch CLI before RPC/output: ${extra.join(' ') || 'missing limit'}`, async t => {
  const dir = await temporaryDirectory(t), output = join(dir, 'session'), fake = await fakeRpc(t);
  const result = await cli(args(output, extra), { CONTRACT_WATCH_RPC_URL: fake.url });
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /^Error \[[A-Z_]+\]:/);
  assert.deepEqual(await fs.readdir(dir), []); assert.equal(fake.calls.length, 0);
});

test('limit and capture validation precedes environment getters and output', async t => {
  const dir = await temporaryDirectory(t), output = join(dir, 'session');
  const environment = new Proxy({}, { get() { assert.fail('env read before validation'); } });
  for (const value of [
    settings(output, undefined, { count: undefined }),
    settings(output, undefined, { options: { address: 'bad', chainId: '1' } }),
    settings(output, undefined, { configPath: join(dir,'missing'), count: undefined })
  ]) await assert.rejects(watchSession(value, environment, new AbortController().signal));
  assert.deepEqual(await fs.readdir(dir), []);
});

test('config is validated fully, selected endpoint read exactly once, no override/fallback', async t => {
  const dir = await temporaryDirectory(t), configPath = await config(dir), fake = await fakeRpc(t);
  const reads = [], environment = new Proxy({ PRIVATE_SELECTED: fake.url }, { get(object,key) { reads.push(key); return object[key]; } });
  const before = await fs.stat(configPath);
  const report = await watchSession(settings(join(dir,'session'), undefined, { count: '2', configPath,
    name: 'private-selected', options: {} }), environment, new AbortController().signal);
  assert.equal(report.saved, 2); assert.deepEqual(reads, ['PRIVATE_SELECTED']); assert.equal(fake.calls.length, 16);
  assert.equal((await fs.stat(configPath)).mtimeMs, before.mtimeMs);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  for (const extra of [['--rpc',fake.url], ['--address',ADDRESS], ['--chain-id','1'], ['--target','private-unused']]) {
    const result = await cli(['watch','--config',configPath,'--target','private-selected','--out-dir',join(dir,'bad'),
      '--interval-ms','100','--count','1',...extra]);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /USAGE/);
  }
  const bad = await cli(['watch','--config',configPath,'--target','private-selected','--out-dir',join(dir,'bad'),
    '--interval-ms','100','--count','1'], { CONTRACT_WATCH_RPC_URL: fake.url });
  assert.match(bad.stderr, /CONFIG_ENV/); assert.equal(bad.stdout,''); assert.equal(fake.calls.length,16);
  const parsed = JSON.parse(await fs.readFile(configPath)); parsed.targets[1].chainId = 1;
  await fs.writeFile(configPath, JSON.stringify(parsed));
  await assert.rejects(watchSession(settings(join(dir,'bad'),undefined,{ configPath, name:'private-selected',options:{} }),
    environment,new AbortController().signal), { code:'CONFIG' });
  assert.deepEqual(reads, ['PRIVATE_SELECTED']);
});

const selectors = [[], ['--block','latest'], ['--block','safe'], ['--block','finalized'], ['--block','100'],
  ['--block','0x64'], ['--block-hash',HASH], ['--depth','0'], ['--depth','1']];
for (const selection of selectors) for (const mode of ['plain','genesis','implementation','beacon','genesis-implementation']) {
  test(`watch preserves capture mode ${selection.join(' ') || 'default'} ${mode}`, async t => {
    const dir = await temporaryDirectory(t), output = join(dir,'session');
    const genesis = `0x${'12'.repeat(32)}`, positiveDepth = selection.includes('1');
    const selectedNumber = positiveDepth ? '0x63' : '0x64';
    const fake = await fakeRpc(t, r => {
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0') return { result: { number: '0x0', hash: genesis } };
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x63') return { result: { number: '0x63', hash: HASH } };
      if (mode === 'beacon' && r.method === 'eth_getStorageAt') return { result: r.params[1] === SLOTS.beacon ? word(IMPLEMENTATION) : EMPTY };
      if (r.method === 'eth_call') return { result: word(IMPLEMENTATION) };
      return { result: protocolResult(r) };
    });
    const extra = [...selection,'--count','1'];
    if (mode.includes('genesis')) extra.push('--genesis');
    if (mode.includes('implementation')) extra.push('--implementation-code');
    if (mode === 'beacon') extra.push('--resolve-beacon');
    const result = await cli(args(output, extra), { CONTRACT_WATCH_RPC_URL: fake.url });
    assert.equal(result.code,0,result.stderr);
    const snapshot = await readSnapshot(join(output,'observation-001.json'));
    assert.equal(snapshot.schemaVersion, mode.includes('genesis') ? 4 : mode.includes('implementation') ? 2 : 1);
    assert.equal(snapshot.block.number, selectedNumber);
    if (mode.includes('genesis')) assert.deepEqual(snapshot.genesis,{status:'observed',hash:genesis});
    const expected = 8 + (positiveDepth || selection.includes('--block-hash') ? 1 : 0) +
      (mode.includes('genesis') ? 2 : 0) + (mode.includes('implementation') || mode === 'beacon' ? 1 : 0);
    assert.equal(fake.calls.length,expected);
    for (const call of fake.calls.filter(r => ['eth_getCode','eth_getStorageAt','eth_call'].includes(r.method)))
      assert.deepEqual(call.params.at(-1),{blockHash:HASH,requireCanonical:true});
    if (mode === 'beacon') {
      const call = fake.calls.find(r => r.method === 'eth_call');
      assert.equal(call.params[0].gas, '0x186a0');
      assert.equal(JSON.parse(result.stdout).outcomes[0].beaconResolution.status,'resolved');
    }
  });
}

test('watch retains exact uint256 identity and block numbers through configured selection', async t => {
  const dir = await temporaryDirectory(t), large = (2n**256n-1n).toString(), hex = `0x${'f'.repeat(64)}`;
  const configPath = await config(dir, large), output = join(dir,'session');
  const fake = await fakeRpc(t, r => ({ result: r.method === 'eth_chainId' ? hex
    : r.method.startsWith('eth_getBlock') ? {number:hex,hash:HASH} : protocolResult(r) }));
  const report = await watchSession(settings(output,undefined,{configPath,name:'private-selected',options:{block:large}}),
    {PRIVATE_SELECTED:fake.url},new AbortController().signal);
  assert.equal(report.chainId,large); assert.equal(report.outcomes[0].block.number,hex);
  assert.deepEqual(fake.calls[1].params,[hex,false]); assert.equal(fake.calls.length,8);
});

for (const [failure, expected, requests] of [
  ['initial-chain','CHAIN_MISMATCH',1],['final-chain','CHAIN_MISMATCH',8],
  ['canonical','BLOCK_CHANGED',7],['genesis','GENESIS_CHANGED',9],
  ['hash','BLOCK_NOT_CANONICAL',3], ['unsupported','RPC_REMOTE',3]
]) test(`identity/pin failure has no fallback or read retry: ${failure}`, async t => {
  const dir = await temporaryDirectory(t), output = join(dir,'session');
  let chains = 0, blocks = 0, genesisReads = 0;
  const fake = await fakeRpc(t, r => {
    if (r.method === 'eth_chainId') {
      chains++;
      if (failure === 'initial-chain' || failure === 'final-chain' && chains === 2) return { result:'0x2' };
    }
    if (r.method === 'eth_getBlockByNumber') {
      blocks++;
      if (r.params[0] === '0x0') return { result:{number:'0x0',hash:`0x${(++genesisReads === 1 ? '11':'22').repeat(32)}`} };
      if (failure === 'hash' || failure === 'canonical' && blocks === 2) return {result:{number:'0x64',hash:`0x${'cd'.repeat(32)}`}};
    }
    if (failure === 'unsupported' && r.method === 'eth_getCode') return {error:{code:-32000,message:'PRIVATE_PROVIDER'}};
    return {result:protocolResult(r)};
  });
  const result = await cli(args(output,['--count','1','--retries','3','--deadline-ms','5000',
    ...(failure === 'genesis' ? ['--genesis'] : failure === 'hash' ? ['--block-hash',HASH] : [])]),
  {CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,1); const report = JSON.parse(result.stdout);
  assert.equal(report.outcomes[0].error.code,expected);
  assert.equal(fake.calls.length,requests); assert.deepEqual(await fs.readdir(output),[]);
});

for (const status of [503,429]) test(`per-capture retries retain pin and fresh ids: HTTP ${status}`, async t => {
  const dir = await temporaryDirectory(t), output = join(dir,'session'); let retried = false;
  const fake = await fakeRpc(t,(r,res) => {
    if (r.method === 'eth_getCode' && !retried) { retried=true;res.writeHead(status,{'Retry-After':'0'});res.end('PRIVATE');return; }
    return {result:protocolResult(r)};
  });
  const result = await cli(args(output,['--count','1','--retries','1','--deadline-ms','5000']),{CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,0,result.stderr); assert.equal(fake.calls.length,9);
  assert.deepEqual(fake.calls[2].params,fake.calls[3].params); assert.notEqual(fake.calls[2].id,fake.calls[3].id);
});

test('session duration aborts real transport, drains resources, prevents reads/retries and reports stopped', async t => {
  const dir = await temporaryDirectory(t), output = join(dir,'session');
  let active = 0;
  const fake = await fakeRpc(t, (r,res) => { active++;res.once('close',()=>active--); });
  const result = await cli(args(output,['--duration-ms','100','--retries','3','--deadline-ms','5000']),{CONTRACT_WATCH_RPC_URL:fake.url});
  await turn();
  assert.equal(result.code,1); assert.equal(result.stderr,'');
  const report = JSON.parse(result.stdout);
  assert.equal(report.stopReason,'duration'); assert.equal(report.saved,0); assert.equal(report.stopped,1);
  assert.deepEqual(report.outcomes,[{ordinal:1,status:'stopped',reason:'duration'}]);
  assert.equal(fake.calls.length,1); assert.equal(active,0); assert.deepEqual(await fs.readdir(output),[]);
});

for (const status of [503,429]) test(`duration cancels HTTP ${status} wait before retry`, async t => {
  const dir = await temporaryDirectory(t), fake = await fakeRpc(t, (r,res) => {
    res.writeHead(status,{'Retry-After':'30'});res.end('PRIVATE');
  });
  const result = await cli(args(join(dir,'session'),['--duration-ms','100','--retries','3','--deadline-ms','60000']),
    {CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,1); assert.equal(JSON.parse(result.stdout).stopped,1); assert.equal(fake.calls.length,1);
});

test('capture deadline fails one attempt; later count attempts remain finite', async t => {
  const dir = await temporaryDirectory(t), fake = await fakeRpc(t, () => undefined);
  const result = await cli(args(join(dir,'session'),['--count','2','--deadline-ms','100']),{CONTRACT_WATCH_RPC_URL:fake.url});
  const report = JSON.parse(result.stdout);
  assert.equal(result.code,1); assert.equal(report.stopReason,'count'); assert.equal(report.failed,2);
  assert.deepEqual(report.outcomes.map(o=>o.error.code),['CAPTURE_DEADLINE','CAPTURE_DEADLINE']);
  assert.equal(fake.calls.length,2);
});

test('watch lifecycle removes signal handlers on success and global error', async t => {
  const dir = await temporaryDirectory(t), fake = await fakeRpc(t);
  for (const count of ['1',undefined]) {
    const h = host();
    await runWatch(settings(join(dir,`session-${count}`),fake.url,{count}),{},h);
    assert.equal(h.listenerCount('SIGINT') + h.listenerCount('SIGTERM'),0);
    assert.equal(h.exitCode,count ? 0 : 1); assert.equal(count ? h.err : h.out,'');
  }
});

for (const success of [true,false]) test(`128 loopback attempts bound requests/files including failures: success=${success}`, async t => {
  const dir = await temporaryDirectory(t), output = join(dir,'session');
  const fake = await fakeRpc(t, r => success ? {result:protocolResult(r)} : {error:{code:-32000,message:'PRIVATE'}});
  let monotonic = 0, waits = 0;
  const report = await watchSession(settings(output,fake.url,{count:'128'}),{},new AbortController().signal,{
    now:()=>monotonic, sleep:async ms=>{monotonic+=ms;waits++;}
  });
  assert.equal(report.attempted,128);assert.equal(report.stopReason,'count');assert.equal(waits,127);
  assert.equal(report.saved,success?128:0);assert.equal(report.failed,success?0:128);
  assert.equal(fake.calls.length,success?1024:128);
  const names = await fs.readdir(output);
  assert.equal(names.length,success?128:0);
  if(success)assert.deepEqual([names[0],names.at(-1)],['observation-001.json','observation-128.json']);
});

test('normal duration in the interval reports saved observations and exits zero', async t => {
  const dir = await temporaryDirectory(t), fake = await fakeRpc(t);
  const argv=args(join(dir,'session'),['--duration-ms','1000']);
  argv[argv.indexOf('--interval-ms')+1]='60000';
  const result=await cli(argv,{CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.stopReason,'duration');assert.equal(report.attempted,1);assert.equal(report.saved,1);
  assert.equal(report.failed+report.stopped,0);assert.equal(fake.calls.length,8);
});

test('configured checksum is checked before endpoint access; valid configured beacon/genesis retains all reads', async t=>{
  const dir=await temporaryDirectory(t),configPath=await config(dir,'1','0x52908400098527886e0f7030069857d2e4169ee7');
  const environment=new Proxy({},{get(){assert.fail('invalid checksum read env');}});
  await assert.rejects(watchSession(settings(join(dir,'bad'),undefined,{configPath,name:'private-selected',
    options:{strictChecksum:true}}),environment,new AbortController().signal),{code:'ADDRESS_CHECKSUM'});
  const data=JSON.parse(await fs.readFile(configPath));data.targets[0].address='0x52908400098527886E0F7030069857D2E4169EE7';
  await fs.writeFile(configPath,JSON.stringify(data));
  const genesis=`0x${'aa'.repeat(32)}`;
  const fake=await fakeRpc(t,r=>{
    if(r.method==='eth_getBlockByNumber'&&r.params[0]==='0x0')return {result:{number:'0x0',hash:genesis}};
    if(r.method==='eth_getStorageAt')return {result:r.params[1]===SLOTS.beacon?word(IMPLEMENTATION):EMPTY};
    if(r.method==='eth_call')return {result:word(IMPLEMENTATION)};
    return {result:protocolResult(r)};
  });
  const report=await watchSession(settings(join(dir,'good'),undefined,{configPath,name:'private-selected',
    options:{strictChecksum:true,genesis:true,blockHash:HASH},includeImplementation:true}),{PRIVATE_SELECTED:fake.url},new AbortController().signal);
  assert.equal(report.saved,1);assert.equal(report.outcomes[0].snapshotVersion,4);assert.equal(fake.calls.length,13);
  const snapshot=await readSnapshot(join(dir,'good','observation-001.json'));
  assert.equal(snapshot.implementation.via,'beacon');assert.equal(snapshot.genesis.hash,genesis);
});

test('signals after the session output commit do not roll back saved files',async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t),h=host();
  h.stdout.write=value=>{h.out+=value;h.emit('SIGTERM');h.emit('SIGINT');};
  await runWatch(settings(output,fake.url),{},h);
  assert.equal(h.exitCode,0);assert.equal(h.err,'');assert.equal(JSON.parse(h.out).saved,1);
  assert.deepEqual(await fs.readdir(output),['observation-001.json']);
  assert.equal(h.listenerCount('SIGINT')+h.listenerCount('SIGTERM'),0);
});
