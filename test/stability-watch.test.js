import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { watchSession } from '../src/watch.js';
import { SLOTS, readSnapshot } from '../src/snapshot.js';
import { ADDRESS, IMPLEMENTATION, EMPTY, word, temporaryDirectory, fakeRpc, cli } from './helpers/fake-rpc.js';
import { watchPreload, watchChild, cancelled } from './helpers/watch-child.js';

const hash=n=>`0x${BigInt(n).toString(16).padStart(64,'0')}`;
const code={A:'0x6000',B:'0x6001',C:'0x6002'};
const state=(value,height,extra={})=>({value,height:BigInt(height),...extra});
const series=names=>names.map((name,i)=>state(name,100+i));
const args=(output,count,extra=[])=>['watch','--address',ADDRESS,'--chain-id','1','--out-dir',output,
  '--interval-ms','100','--count',String(count),...extra];
const settings=(output,rpcUrl,count,extra={})=>({outputDir:output,intervalMs:'100',count:String(count),
  options:{address:ADDRESS,chainId:'1',rpcUrl},stableCount:'2',...extra});
function fastClock(){let now=0;return {now:()=>now,sleep:async ms=>{now+=ms;}};}
function durationClock(){
  let now=0,alarm=true;
  return {now:()=>now,sleep(ms,signal){
    if(!alarm){now+=ms;return Promise.resolve();}
    alarm=false;
    return new Promise((resolve,reject)=>{
      const stop=()=>{signal.removeEventListener('abort',stop);reject(Error('timer stopped'));};
      signal.addEventListener('abort',stop,{once:true});
    });
  }};
}

// Independent scripted provider: one state per observation, only the existing
// allowlisted capture trace; no policy logic is shared with these responses.
async function sequenceRpc(t, sequence, chainId='1') {
  let index=-1, active=false, current;const retried=new Set();
  return fakeRpc(t,(r,res)=>{
    if(r.method==='eth_chainId'){
      if(!active){
        current=sequence[++index];assert.ok(current,'unexpected extra observation');
        if(current.value==='failed')return {error:{code:-32000,message:'PRIVATE_PROVIDER'}};
        active=true;
      }else active=false;
      return {result:`0x${BigInt(chainId).toString(16)}`};
    }
    if(r.method.startsWith('eth_getBlock')){
      if(current.genesis&&r.params[0]==='0x0')return {result:{number:'0x0',hash:current.genesis}};
      return {result:{number:`0x${current.height.toString(16)}`,hash:current.hash??hash(current.height)}};
    }
    if(r.method==='eth_getCode'){
      if(current.transient&&!retried.has(index)){retried.add(index);res.writeHead(current.transient,{'Retry-After':'0'});res.end('PRIVATE');return;}
      return {result:r.params[0]===ADDRESS?code[current.value]:current.implementationCode??'0x1234'};
    }
    if(r.method==='eth_getStorageAt')return {result:current.unavailable?EMPTY:
      r.params[1]===SLOTS.implementation&&!current.beacon?word(IMPLEMENTATION):
      r.params[1]===SLOTS.beacon&&current.beacon?word(current.beacon):EMPTY};
    if(r.method==='eth_call')return {result:word(current.implementationAddress??IMPLEMENTATION)};
    assert.fail('unexpected RPC method');
  });
}

test('opt-in report v2 matches hand-written flapping decisions without adding requests or altering snapshots/v1 report',async t=>{
  const dir=await temporaryDirectory(t),expected=JSON.parse(await fs.readFile(new URL('./fixtures/stability/flapping.json',import.meta.url)));
  const plain=await sequenceRpc(t,series(expected.states)),opt=await sequenceRpc(t,series(expected.states));
  const one=await cli(args(join(dir,'v1'),9),{CONTRACT_WATCH_RPC_URL:plain.url});
  const two=await cli(args(join(dir,'v2'),9,['--stable-count','2']),{CONTRACT_WATCH_RPC_URL:opt.url});
  assert.equal(one.code,0,one.stderr);assert.equal(two.code,0,two.stderr);
  const v1=JSON.parse(one.stdout),v2=JSON.parse(two.stdout),{stability,...base}=v2;
  assert.equal(v1.schemaVersion,1);assert.equal(v2.schemaVersion,2);base.schemaVersion=1;
  assert.deepEqual(base,v1);assert.deepEqual(stability.observations,expected.observations);assert.deepEqual(stability.transitions,expected.transitions);
  assert.deepEqual(opt.calls,plain.calls);assert.equal(opt.calls.length,72);
  for(let i=1;i<=9;i++){
    const file=`observation-${String(i).padStart(3,'0')}.json`;
    const a=await readSnapshot(join(dir,'v1',file)),b=await readSnapshot(join(dir,'v2',file));
    a.capturedAt=b.capturedAt;assert.deepEqual(a,b);
  }
});

for(const value of ['0','17','01','+1','1\n','1.0','1e0','0x1','１','PRIVATE_INVALID']) {
  test(`invalid --stable-count before env/RPC/output: ${JSON.stringify(value)}`,async t=>{
    const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await sequenceRpc(t,[]);
    const result=await cli(args(output,1,['--stable-count',value]),{CONTRACT_WATCH_RPC_URL:fake.url});
    assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/STABILITY_OPTION/);
    assert.ok(!result.stderr.includes('PRIVATE'));assert.equal(fake.calls.length,0);assert.deepEqual(await fs.readdir(dir),[]);
    await assert.rejects(watchSession(settings(output,undefined,1,{stableCount:value}),
      new Proxy({},{get(){assert.fail('env read before threshold validation');}}),new AbortController().signal),{code:'STABILITY_OPTION'});
  });
}
for(const flags of [['--stable-count'],['--stable-count=2'],['--stable-count','1','--stable-count','2']]) {
  test(`threshold CLI syntax remains strict ${flags.join(' ')}`,async t=>{
    const dir=await temporaryDirectory(t),result=await cli(args(join(dir,'session'),1,flags));
    assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/USAGE/);assert.deepEqual(await fs.readdir(dir),[]);
  });
}
for(const command of ['snapshot','snapshot-many','inspect','diff','history','migrate']) test(`${command} rejects watch policy flag`,async()=>{
  const result=await cli([command,'--stable-count','2']);
  assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/USAGE/);
});

for(const threshold of [1,16]) test(`loopback threshold ${threshold} reaches exactly at its last committed observation`,async t=>{
  const dir=await temporaryDirectory(t),fake=await sequenceRpc(t,series(['A',...Array(threshold).fill('B')]));
  const report=await watchSession(settings(join(dir,'session'),fake.url,threshold+1,{stableCount:String(threshold)}),
    {},new AbortController().signal,fastClock());
  assert.deepEqual(report.stability.transitions,[{status:'stable',fromOrdinal:1,firstOrdinal:2,confirmedOrdinal:threshold+1,matches:threshold}]);
  assert.equal(report.saved,threshold+1);assert.equal(fake.calls.length,8*(threshold+1));
});

test('failed capture clears the candidate and does not count as saved; later matching run starts afresh',async t=>{
  const dir=await temporaryDirectory(t),sequence=[state('A',100),state('B',101),state('failed',0),state('B',102),state('B',103)];
  const fake=await sequenceRpc(t,sequence),result=await cli(args(join(dir,'session'),5,['--stable-count','2']),{CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,1);assert.equal(result.stderr,'');const report=JSON.parse(result.stdout);
  assert.equal(report.saved,4);assert.equal(report.failed,1);assert.equal(fake.calls.length,33);
  assert.equal(report.stability.observations[2].reason,'ATTEMPT_FAILED');
  assert.deepEqual(report.stability.transitions,[{status:'stable',fromOrdinal:1,firstOrdinal:4,confirmedOrdinal:5,matches:2}]);
  assert.ok(!result.stdout.includes('PRIVATE'));
});

test('128-attempt cap does not wait for an unmet policy; repeated block candidates stay at one',async t=>{
  const dir=await temporaryDirectory(t),sequence=[state('A',100),...Array.from({length:127},()=>state('B',101))];
  const fake=await sequenceRpc(t,sequence);
  const report=await watchSession(settings(join(dir,'session'),fake.url,128),{},new AbortController().signal,fastClock());
  assert.equal(report.stopReason,'count');assert.equal(report.attempted,128);
  assert.deepEqual(report.stability.candidate,{firstOrdinal:2,lastOrdinal:2,matches:1});
  assert.deepEqual(report.stability.transitions,[]);assert.equal(fake.calls.length,1024);
});

test('duration-only hard cap is still 128 and never waits to fulfill stability',async t=>{
  const dir=await temporaryDirectory(t),fake=await sequenceRpc(t,[state('A',100),...Array.from({length:127},()=>state('B',101))]);
  const report=await watchSession(settings(join(dir,'session'),fake.url,128,{count:undefined,durationMs:'600000'}),
    {},new AbortController().signal,durationClock());
  assert.equal(report.stopReason,'attempt-limit');assert.equal(report.attempted,128);
  assert.equal(report.stability.candidate.matches,1);assert.deepEqual(report.stability.transitions,[]);
  assert.equal(fake.calls.length,1024);
});

test('duration between observations preserves an unmet candidate without inventing another attempt',async t=>{
  const dir=await temporaryDirectory(t),fake=await sequenceRpc(t,series(['A','B']));
  const report=await watchSession(settings(join(dir,'session'),fake.url,10,{durationMs:'150'}),
    {},new AbortController().signal,durationClock());
  assert.equal(report.stopReason,'duration');assert.equal(report.attempted,2);assert.equal(report.stopped,0);
  assert.deepEqual(report.stability.candidate,{firstOrdinal:2,lastOrdinal:2,matches:1});
  assert.deepEqual(report.stability.transitions,[]);assert.equal(fake.calls.length,16);
});

for(const [name,sequence,reason] of [
  ['gap',[state('A',100),state('B',101),state('B',103)],'BLOCK_GAP'],
  ['backwards',[state('A',100),state('B',101),state('B',99)],'NONMONOTONIC_BLOCK'],
  ['conflicting-state',[state('A',100),state('B',101),state('C',101)],'INCONSISTENT_BLOCK_DATA'],
  ['conflicting-height',[state('A',100),state('B',101),state('B',101,{hash:hash(999)})],'HEIGHT_CONFLICT'],
  ['genesis',[state('A',100,{genesis:hash(1)}),state('B',101,{genesis:hash(1)}),state('B',102,{genesis:hash(2)})],'IDENTITY_CHANGED']
]) test(`committed ${name} blocks policy qualification without losing snapshots or changing exit semantics`,async t=>{
  const dir=await temporaryDirectory(t),fake=await sequenceRpc(t,sequence);
  const result=await cli(args(join(dir,'session'),3,['--stable-count','2',...(name==='genesis'?['--genesis']:[])]),
    {CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);
  assert.equal(report.saved,3);assert.equal(report.stability.observations[2].reason,reason);
  assert.deepEqual(report.stability.transitions,[]);assert.equal((await fs.readdir(join(dir,'session'))).length,3);
});

for(const mode of ['implementation','genesis-implementation','beacon-implementation','live-beacon','genesis-only']) {
  test(`policy scope and exact capture trace for ${mode}`,async t=>{
    const dir=await temporaryDirectory(t),sequence=series(['A','B','B']);
    for(const value of sequence){if(mode.includes('genesis'))value.genesis=hash(1);if(mode.includes('beacon'))value.beacon=IMPLEMENTATION;}
    const fake=await sequenceRpc(t,sequence),extra=['--stable-count','2'];
    if(mode.includes('implementation'))extra.push('--implementation-code');
    if(mode==='live-beacon')extra.push('--resolve-beacon');
    if(mode.includes('genesis'))extra.push('--genesis');
    const result=await cli(args(join(dir,'session'),3,extra),{CONTRACT_WATCH_RPC_URL:fake.url});
    assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);
    assert.equal(report.stability.scope,mode.includes('implementation')?'target-and-implementation':'target');
    assert.equal(report.stability.transitions.length,1);
    const reads=8+(mode.includes('genesis')?2:0)+(mode.includes('implementation')?1:0)+(mode.includes('beacon')?1:0);
    assert.equal(fake.calls.length,reads*3);
    for(const request of fake.calls.filter(r=>['eth_getCode','eth_getStorageAt','eth_call'].includes(r.method)))
      assert.equal(request.params.at(-1).requireCanonical,true);
  });
}

test('unavailable implementation and provenance changes never count as unchanged full state',async t=>{
  const dir=await temporaryDirectory(t),sequence=series(['A','B','B','B','B']);
  sequence[2].unavailable=true;sequence[4].beacon=IMPLEMENTATION;
  const fake=await sequenceRpc(t,sequence),result=await cli(args(join(dir,'session'),5,['--stable-count','2','--implementation-code']),
    {CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);
  assert.deepEqual(report.stability.observations.map(o=>o.reason),['BASELINE',null,'IMPLEMENTATION_UNAVAILABLE','BASELINE','PROVENANCE_CHANGED']);
  assert.deepEqual(report.stability.transitions,[]);
});

test('configured opt-in preserves uint256 chain/block identity and reads only the selected endpoint',async t=>{
  const dir=await temporaryDirectory(t),chainId=(2n**256n-1n).toString(),start=2n**256n-4n;
  const sequence=['A','B','B'].map((s,i)=>state(s,start+BigInt(i))),fake=await sequenceRpc(t,sequence,chainId);
  const path=join(dir,'PRIVATE_CONFIG.json');
  await fs.writeFile(path,JSON.stringify({schemaVersion:1,targets:[{name:'chosen',address:ADDRESS,chainId,rpcEnv:'PRIVATE_RPC'}]}));
  const reads=[],environment=new Proxy({PRIVATE_RPC:fake.url},{get(object,key){reads.push(key);return object[key];}});
  const report=await watchSession(settings(join(dir,'session'),undefined,3,{configPath:path,name:'chosen',options:{}}),
    environment,new AbortController().signal,fastClock());
  assert.equal(report.chainId,chainId);assert.deepEqual(reads,['PRIVATE_RPC']);assert.equal(report.stability.transitions.length,1);
  assert.equal(report.outcomes[2].block.number,`0x${(start+2n).toString(16)}`);assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('publication failure before commit does not advance policy, preserves prior snapshot and original outcomes',async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await sequenceRpc(t,series(['A','B','B']));
  const script=await watchPreload(dir,'before-link',2);
  const c=watchChild(t,args(output,3,['--stable-count','2']),{CONTRACT_WATCH_RPC_URL:fake.url,NODE_OPTIONS:`--import=${pathToFileURL(script).href}`});
  await c.message(m=>m.point==='before-link');
  await fs.writeFile(join(output,'observation-002.json'),'USER_KEEP');c.p.send('release');
  const result=await c.result,report=JSON.parse(result.stdout);
  assert.equal(result.code,1);assert.equal(report.saved,2);assert.equal(report.failed,1);
  assert.equal(report.stability.observations[1].reason,'ATTEMPT_FAILED');
  // Committed heights jump from 100 to 102: rebase, never bridge the failed write.
  assert.equal(report.stability.observations[2].reason,'BLOCK_GAP');assert.deepEqual(report.stability.transitions,[]);
  assert.equal(await fs.readFile(join(output,'observation-002.json'),'utf8'),'USER_KEEP');
  await readSnapshot(join(output,'observation-001.json'));assert.equal(fake.calls.length,24);
});

test('duration during publication clears pending candidate and drains before emitting v2 stopped outcome',async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await sequenceRpc(t,series(['A','B','B']));
  const script=await watchPreload(dir,'after-link',3);
  const c=watchChild(t,args(output,3,['--stable-count','2','--duration-ms','600000']),
    {CONTRACT_WATCH_RPC_URL:fake.url,NODE_OPTIONS:`--import=${pathToFileURL(script).href}`});
  await c.message(m=>m.point==='after-link');c.p.send('expire');
  const result=await c.result,report=JSON.parse(result.stdout);
  assert.equal(result.code,1);assert.equal(report.schemaVersion,2);assert.equal(report.stopReason,'duration');
  assert.equal(report.saved,2);assert.equal(report.stopped,1);
  assert.equal(report.stability.observations[2].reason,'ATTEMPT_STOPPED');assert.equal(report.stability.candidate,null);
  assert.deepEqual(report.stability.transitions,[]);
  assert.deepEqual(await fs.readdir(output),['observation-001.json','observation-002.json']);
});

for(const signal of ['SIGINT','SIGTERM']) for(const point of ['after-link','temp-cleanup','report']) {
  test(`policy never exposes partial JSON or loses committed files on ${signal} at ${point}`,{timeout:10000},async t=>{
    const dir=await temporaryDirectory(t),output=join(dir,'session');
    const count=point==='report'?1:2,fake=await sequenceRpc(t,series(['A','B']));
    const script=await watchPreload(dir,point,count);
    const c=watchChild(t,args(output,count,['--stable-count','1']),
      {CONTRACT_WATCH_RPC_URL:fake.url,NODE_OPTIONS:`--import=${pathToFileURL(script).href}`});
    await c.message(m=>m.point===point);c.p.kill(signal);await c.message(m=>m.signal===signal);c.p.send('release');
    assert.deepEqual(await c.result,{code:signal==='SIGINT'?130:143,signal:null,stdout:'',stderr:cancelled});
    assert.deepEqual(await fs.readdir(output),['observation-001.json']);await readSnapshot(join(output,'observation-001.json'));
  });
}

test('opt-in saved snapshots retain offline inspect/diff/history behavior and no policy fields',async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await sequenceRpc(t,series(['A','B','B']));
  const result=await cli(args(output,3,['--stable-count','2']),{CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,0);const first=join(output,'observation-001.json'),last=join(output,'observation-003.json');
  assert.ok(!('stability' in await readSnapshot(first)));
  for(const argv of [['inspect',first],['diff','--json',first,last],['history','init',first,'--dir',join(dir,'history')],
    ['history','add',last,'--dir',join(dir,'history')],['history','timeline','--dir',join(dir,'history'),'--json']]){
    const offline=await cli(argv,{CONTRACT_WATCH_RPC_URL:fake.url});assert.equal(offline.code,0,offline.stderr);
  }
  assert.equal(fake.calls.length,24);
});

for(const selection of [['--block','100'],['--block-hash',hash(100)],['--depth','0']]) {
  test(`fixed selection ${selection.join(' ')} cannot become new chain confirmations`,async t=>{
    const dir=await temporaryDirectory(t),fake=await sequenceRpc(t,[state('A',100),state('A',100),state('A',100)]);
    const result=await cli(args(join(dir,'session'),3,['--stable-count','1',...selection]),{CONTRACT_WATCH_RPC_URL:fake.url});
    assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);
    assert.deepEqual(report.stability.observations.map(o=>o.status),['baseline','repeated','repeated']);
    assert.deepEqual(report.stability.transitions,[]);assert.equal(fake.calls.length,selection[0]==='--block-hash'?27:24);
  });
}

for(const status of [503,429]) test(`successful capture retry HTTP ${status} counts once and retains pins/budgets`,async t=>{
  const dir=await temporaryDirectory(t),sequence=series(['A','B','B']);sequence[1].transient=status;
  const fake=await sequenceRpc(t,sequence);
  const result=await cli(args(join(dir,'session'),3,['--stable-count','2','--retries','1','--deadline-ms','5000']),
    {CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,0,result.stderr);const report=JSON.parse(result.stdout);
  assert.equal(report.attempted,3);assert.equal(report.stability.transitions.length,1);assert.equal(fake.calls.length,25);
  assert.deepEqual(fake.calls[10].params,fake.calls[11].params);assert.notEqual(fake.calls[10].id,fake.calls[11].id);
});
