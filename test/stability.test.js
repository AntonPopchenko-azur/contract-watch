import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createStabilityPolicy, stableCount } from '../src/stability.js';
import { fixture, IMPLEMENTATION, EMPTY, word } from './helpers/fake-rpc.js';

const hash = n => `0x${BigInt(n).toString(16).padStart(64,'0')}`;
const codes = { A:'0x6000', B:'0x6001', C:'0x6002' };
function snapshot(state = 'A', height = 100, edits = {}) {
  return {...fixture(),code:codes[state],block:{number:`0x${BigInt(height).toString(16)}`,hash:hash(height)},...edits};
}
function feed(policy, values) {
  values.forEach((value,index)=>policy.observe({ordinal:index+1,status:typeof value==='string'?value:'saved'},typeof value==='string'?undefined:value));
  return policy.report();
}
function states(names, start=100) { return names.map((name,i)=>snapshot(name,BigInt(start)+BigInt(i))); }
function implementation(state='A',height=100,via='implementation-slot',address=IMPLEMENTATION,beacon=IMPLEMENTATION) {
  const value=snapshot('A',height,{schemaVersion:2});
  value.slots={...value.slots,implementation:via==='beacon'?EMPTY:word(address),beacon:via==='beacon'?word(beacon):EMPTY};
  value.implementation={status:state==='empty'?'no-code':'observed',via,address,code:state==='empty'?'0x':codes[state],
    ...(via==='beacon'?{beacon,raw:word(address)}:{})};
  return value;
}
function genesis(value, identity=hash(1)) {
  return {...value,schemaVersion:4,implementation:value.implementation??{status:'not-recorded'},genesis:{status:'observed',hash:identity}};
}

for(const value of ['1','16']) test(`threshold ${value} accepted`,()=>assert.equal(stableCount(value),Number(value)));
for(const value of [undefined,null,1,'','0','17','128','01','+1','-1','1 ',' 1','1\n','1.0','1e0','0x1','１','9'.repeat(1000)]) {
  test(`invalid threshold ${String(value).slice(0,20)}`,()=>assert.throws(()=>stableCount(value),{code:'STABILITY_OPTION'}));
}

test('independent flapping fixture pins baseline/candidate/stable transitions and return to earlier state',async()=>{
  const expected=JSON.parse(await fs.readFile(new URL('./fixtures/stability/flapping.json',import.meta.url)));
  const report=feed(createStabilityPolicy(expected.threshold),states(expected.states));
  for(const key of ['observations','transitions','baselineOrdinal','candidate'])assert.deepEqual(report[key],expected[key]);
  assert.equal(report.scope,'target');assert.equal(report.status,'active');
});

for(const threshold of [1,16]) test(`threshold ${threshold} counts candidate observations, never counts the baseline`,()=>{
  const values=states(['A',...Array(threshold).fill('B')]);
  const policy=createStabilityPolicy(String(threshold));
  values.slice(0,-1).forEach((value,i)=>policy.observe({ordinal:i+1,status:'saved'},value));
  assert.deepEqual(policy.report().transitions,[]);
  policy.observe({ordinal:values.length,status:'saved'},values.at(-1));
  assert.deepEqual(policy.report().transitions,[{status:'stable',fromOrdinal:1,firstOrdinal:2,confirmedOrdinal:threshold+1,matches:threshold}]);
});

test('a different candidate restarts at one; continued baseline matches produce no transition',()=>{
  const report=feed(createStabilityPolicy('2'),states(['A','A','B','C','C','C']));
  assert.deepEqual(report.observations.map(o=>[o.status,o.matches]),[
    ['baseline',0],['baseline-match',0],['candidate',1],['candidate',1],['stable',2],['baseline-match',0]]);
  assert.deepEqual(report.transitions,[{status:'stable',fromOrdinal:1,firstOrdinal:4,confirmedOrdinal:5,matches:2}]);
});

for(const interruption of ['failed','stopped']) test(`${interruption} breaks candidate matches but retains reference`,()=>{
  const report=feed(createStabilityPolicy('2'),[snapshot('A',100),snapshot('B',101),interruption,snapshot('B',102),snapshot('B',103)]);
  assert.equal(report.observations[2].status,'interrupted');assert.equal(report.observations[2].matches,0);
  assert.deepEqual(report.transitions,[{status:'stable',fromOrdinal:1,firstOrdinal:4,confirmedOrdinal:5,matches:2}]);
});

test('insufficient run remains pending; stopped attempt clears it without creating a transition',()=>{
  const policy=createStabilityPolicy('16');
  states(['A',...Array(15).fill('B')]).forEach((value,i)=>policy.observe({ordinal:i+1,status:'saved'},value));
  assert.deepEqual(policy.report().candidate,{firstOrdinal:2,lastOrdinal:16,matches:15});
  assert.deepEqual(policy.report().transitions,[]);
  policy.observe({ordinal:17,status:'stopped'});
  assert.equal(policy.report().candidate,null);assert.deepEqual(policy.report().transitions,[]);
});

test('identical fixed-block reads never meet threshold; repeat does not add a match or reset an existing candidate',()=>{
  const report=feed(createStabilityPolicy('2'),[snapshot('A',100),snapshot('B',101),snapshot('B',101),snapshot('B',102)]);
  assert.deepEqual(report.observations.map(o=>o.matches),[0,1,1,2]);
  assert.equal(report.observations[2].status,'repeated');assert.equal(report.transitions.length,1);
  const fixed=feed(createStabilityPolicy('1'),Array.from({length:128},()=>snapshot('A',100)));
  assert.deepEqual(fixed.transitions,[]);assert.equal(fixed.observations.filter(o=>o.status==='repeated').length,127);
});

for(const [label,values,reasons,expected] of [
  ['gap',[snapshot('A',100),snapshot('B',101),snapshot('B',103),snapshot('B',104)],['BASELINE',null,'BLOCK_GAP',null],[]],
  ['decrease',[snapshot('A',100),snapshot('B',101),snapshot('B',99),snapshot('B',102),snapshot('C',103),snapshot('C',104)],
    ['BASELINE',null,'NONMONOTONIC_BLOCK','BASELINE',null,null],[{status:'stable',fromOrdinal:4,firstOrdinal:5,confirmedOrdinal:6,matches:2}]]
]) test(`${label} breaks continuity and requires a fresh reference`,()=>{
  const report=feed(createStabilityPolicy('2'),values);
  assert.deepEqual(report.observations.map(o=>o.reason),reasons);assert.deepEqual(report.transitions,expected);
});

for(const mode of ['code','implementation-slot','admin-slot','beacon-slot','number','height-hash','implementation-code']) {
  test(`nonadjacent block contradiction invalidates prior decisions and latches inactive: ${mode}`,()=>{
    const withImpl=mode==='implementation-code',values=withImpl
      ? [implementation('A',100),implementation('B',101),implementation('B',102)]
      : states(['A','B','B']);
    const disputed=structuredClone(values[0]);
    if(mode==='code')disputed.code='0x1234';
    if(mode.endsWith('-slot'))disputed.slots[mode.replace('-slot','')]=word(`0x${'77'.repeat(20)}`);
    if(mode==='number')disputed.block.number='0x67';
    if(mode==='height-hash')disputed.block.hash=hash(999);
    if(mode==='implementation-code')disputed.implementation.code='0x1234';
    const policy=createStabilityPolicy('2',{includeImplementation:withImpl});
    const report=feed(policy,[...values,disputed,withImpl?implementation('B',103):snapshot('B',103)]);
    assert.equal(report.status,'invalidated');assert.equal(report.invalidatedAt,4);
    assert.equal(report.reason,mode==='height-hash'?'HEIGHT_CONFLICT':'INCONSISTENT_BLOCK_DATA');
    assert.equal(report.observations.at(-1).status,'inactive');assert.equal(report.transitions[0].status,'invalidated');
    assert.equal(report.baselineOrdinal,null);assert.equal(report.candidate,null);
  });
}

for(const field of ['chainId','address','source','schemaVersion','genesis']) test(`incompatible ${field} invalidates all comparisons without mixing identities`,()=>{
  const first=field==='genesis'?genesis(snapshot()):snapshot();
  const next=field==='genesis'?genesis(snapshot('B',101),hash(2)):snapshot('B',101);
  if(field==='chainId')next.chainId=(2n**256n-1n).toString();
  if(field==='address')next.address=`0x${'33'.repeat(20)}`;
  if(field==='source')next.source='rpc';
  if(field==='schemaVersion'){next.schemaVersion=3;next.implementation={status:'not-recorded'};next.migration={fromVersion:1};}
  const report=feed(createStabilityPolicy('1'),[first,next,snapshot('B',102)]);
  assert.equal(report.reason,'IDENTITY_CHANGED');assert.equal(report.status,'invalidated');
  assert.deepEqual(report.transitions,[]);
});

test('genesis object order and capturedAt are not identity or state changes; exact uint256 heights advance by BigInt',()=>{
  const start=2n**256n-4n,chainId=(2n**256n-1n).toString();
  const values=states(['A','B','B'],start).map(value=>genesis({...value,chainId}));
  values[1].genesis={hash:hash(1),status:'observed'};
  values[2].capturedAt='2000-01-01T00:00:00.000Z';
  const report=feed(createStabilityPolicy('2'),values);
  assert.equal(report.status,'active');assert.equal(report.transitions.length,1);
});

for(const status of ['not-recorded','skipped']) test(`unavailable implementation ${status} cannot be a matching state or bridge a series`,()=>{
  const missing=status==='not-recorded'
    ? genesis(snapshot('A',102))
    : genesis({...snapshot('A',102),implementation:{status:'skipped',reason:'EMPTY_SLOTS'},slots:{implementation:EMPTY,admin:EMPTY,beacon:EMPTY}});
  const values=[genesis(implementation('A',100)),genesis(implementation('B',101)),missing,
    genesis(implementation('B',103)),genesis(implementation('C',104)),genesis(implementation('C',105))];
  const report=feed(createStabilityPolicy('2',{includeImplementation:true}),values);
  assert.equal(report.observations[2].status,'unavailable');
  assert.equal(report.observations[2].reason,'IMPLEMENTATION_UNAVAILABLE');
  assert.equal(report.observations[3].status,'baseline');
  assert.deepEqual(report.transitions,[{status:'stable',fromOrdinal:4,firstOrdinal:5,confirmedOrdinal:6,matches:2}]);
});

test('unknown v4 genesis cannot establish a baseline even in target-only scope',()=>{
  const values=states(['A','B','B']).map(value=>({...value,schemaVersion:4,implementation:{status:'not-recorded'},
    genesis:{status:'not-recorded'},migration:{fromVersion:1}}));
  const report=feed(createStabilityPolicy('1'),values);
  assert.equal(report.baselineOrdinal,null);assert.deepEqual(report.transitions,[]);
  assert.deepEqual(report.observations.map(o=>o.reason),Array(3).fill('GENESIS_UNAVAILABLE'));
});

for(const change of ['via','beacon']) test(`implementation provenance ${change} rebases instead of inventing a transition`,()=>{
  const values=change==='via'
    ? [implementation('A',100),implementation('B',101),implementation('B',102,'beacon'),implementation('B',103,'beacon')]
    : [implementation('A',100,'beacon'),implementation('B',101,'beacon'),
      implementation('B',102,'beacon',IMPLEMENTATION,`0x${'44'.repeat(20)}`),implementation('B',103,'beacon',IMPLEMENTATION,`0x${'44'.repeat(20)}`)];
  const report=feed(createStabilityPolicy('2',{includeImplementation:true}),values);
  assert.equal(report.observations[2].reason,'PROVENANCE_CHANGED');assert.deepEqual(report.transitions,[]);
});

for(const difference of ['target-code','raw-implementation','raw-admin','raw-beacon','implementation-code','implementation-address','no-code']) {
  test(`matching state includes ${difference}`,()=>{
    const first=implementation('A',100,'beacon'),next=implementation('A',101,'beacon'),last=implementation('A',102,'beacon');
    const edit=value=>{
      if(difference==='target-code')value.code='0x1234';
      if(difference==='raw-admin')value.slots.admin=word(`0x${'33'.repeat(20)}`);
      if(difference==='raw-implementation'){value.slots.implementation=word(IMPLEMENTATION);value.slots.beacon=EMPTY;
        value.implementation={status:'observed',via:'implementation-slot',address:IMPLEMENTATION,code:codes.A};}
      if(difference==='raw-beacon'){value.slots.beacon=word(`0x${'44'.repeat(20)}`);value.implementation.beacon=`0x${'44'.repeat(20)}`;}
      if(difference==='implementation-code')value.implementation.code='0x1234';
      if(difference==='implementation-address'){value.implementation.address=`0x${'55'.repeat(20)}`;value.implementation.raw=word(value.implementation.address);}
      if(difference==='no-code'){value.implementation.status='no-code';value.implementation.code='0x';}
    };
    edit(next);edit(last);
    const report=feed(createStabilityPolicy('2',{includeImplementation:true}),[first,next,last]);
    if(['raw-implementation','raw-beacon'].includes(difference)){
      assert.equal(report.observations[1].reason,'PROVENANCE_CHANGED');assert.deepEqual(report.transitions,[]);
    }else assert.equal(report.transitions.length,1);
  });
}

test('target-only scope covers every raw word, including noncanonical high bytes, without claiming implementation equality',()=>{
  for(const name of ['implementation','admin','beacon']){
    const values=states(['A','A','A']);
    values[1].slots={...values[1].slots,[name]:`0x${'ff'.repeat(32)}`};
    values[2].slots={...values[1].slots};
    const report=feed(createStabilityPolicy('2'),values);
    assert.equal(report.scope,'target');assert.equal(report.transitions.length,1);
  }
});

test('report bounds: 128 observations, 127 decisions; large code stays out of JSON; no mutable report aliases',()=>{
  const policy=createStabilityPolicy('1');
  const values=states(Array.from({length:128},(_,i)=>i%2?'B':'A'));
  for(const value of values)value.code=`0x${(value.code===codes.A?'aa':'bb').repeat(128*1024)}`;
  const report=feed(policy,values);
  assert.equal(report.observations.length,128);assert.equal(report.transitions.length,127);
  assert.ok(Buffer.byteLength(JSON.stringify(report,null,2))<64*1024);
  assert.ok(!JSON.stringify(report).includes('aaaa'));report.transitions[0].status='bad';
  assert.equal(policy.report().transitions[0].status,'stable');
  assert.throws(()=>policy.observe({ordinal:129,status:'saved'},snapshot('A',300)),{code:'STABILITY_INPUT'});
});

for(const version of [1,2,3,4]) test(`strict snapshot v${version} values retain their original format and comparison scope`,()=>{
  const values=[100,101,102].map((height,i)=>{
    if(version===1)return snapshot(i?'B':'A',height);
    const value=implementation(i?'B':'A',height);
    if(version===3){value.schemaVersion=3;value.migration={fromVersion:2};}
    return version===4?genesis(value):value;
  });
  const original=JSON.stringify(values);
  const report=feed(createStabilityPolicy('2',{includeImplementation:version!==1}),values);
  assert.equal(report.transitions.length,1);assert.equal(JSON.stringify(values),original);
});

test('unknown implementation alone is not conflicting block data, but cannot bridge full-scope observations',()=>{
  const missing=genesis(snapshot('A',100)),known=genesis(implementation('A',100));
  const report=feed(createStabilityPolicy('2',{includeImplementation:true}),[missing,known,genesis(implementation('A',101))]);
  assert.equal(report.status,'active');assert.deepEqual(report.transitions,[]);
  assert.deepEqual(report.observations.map(o=>o.status),['unavailable','repeated','baseline']);
});
