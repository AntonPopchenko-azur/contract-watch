import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capture, captureWithBeacon, captureWithImplementation, validateSnapshot, readSnapshot,
  saveSnapshot, SLOTS, MAX_SNAPSHOT_V4_BYTES } from '../src/snapshot.js';
import { migrateSnapshot, migrateFile } from '../src/migration.js';
import { diffDocument, diffReport, snapshotReport } from '../src/report.js';
import { MAX_CODE_BYTES } from '../src/validate.js';
import { cli, fakeRpc, temporaryDirectory, protocolResult, ADDRESS, HASH, EMPTY, word } from './helpers/fake-rpc.js';

const GENESIS = `0x${'c1'.repeat(32)}`;
const OTHER = `0x${'d2'.repeat(32)}`;
const BEACON = '0x3333333333333333333333333333333333333333';
const IMPLEMENTATION = '0x4444444444444444444444444444444444444444';
const stored = name => readSnapshot(new URL(`./fixtures/genesis/${name}.json`, import.meta.url));
const response = request => request.method === 'eth_getBlockByNumber' && request.params[0] === '0x0'
  ? { number: '0x0', hash: GENESIS } : protocolResult(request);
const options = rpcUrl => ({ rpcUrl, address: ADDRESS, chainId: '1', genesis: true });
const command = (url, out) => ['snapshot', '--genesis', '--rpc', `${url}/PRIVATE_RPC_KEY`, '--address', ADDRESS,
  '--chain-id', '1', '--out', out];
const diffFlags = [[], ['--json'], ['--exit-code'], ['--json', '--exit-code']];
function failure(result, code) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
  assert.doesNotMatch(result.stderr, /PRIVATE_|https?:|\.json|at .*\.js|\u001b/);
}
function pinned(calls, hash = HASH) {
  for (const request of calls.filter(r => ['eth_getCode','eth_getStorageAt','eth_call'].includes(r.method))) {
    assert.deepEqual(request.params.at(-1), { blockHash: hash, requireCanonical: true });
  }
}

test('genesis is opt-in: defaults keep exact v1/v2 budgets, with no genesis reads', async t => {
  for (const [captureFn, version, count] of [[capture,1,8],[captureWithBeacon,1,8],[captureWithImplementation,2,9]]) {
    const fake = await fakeRpc(t);
    const value = await captureFn({ ...options(fake.url), genesis: false });
    const snapshot = value.snapshot ?? value;
    assert.equal(snapshot.schemaVersion, version);
    assert.ok(!Object.hasOwn(snapshot,'genesis'));
    assert.equal(fake.calls.length,count);
    assert.ok(!fake.calls.some(r => r.params[0] === '0x0'));
  }
});

test('genesis capture sends exact sequential selectors and final rechecks', async t => {
  const fake = await fakeRpc(t,r=>({result:r.method==='eth_getBlockByNumber'&&r.params[0]==='0x0'
    ? {number:'0x0',hash:`0x${'C1'.repeat(32)}`} : response(r)}));
  const snapshot = await capture(options(fake.url));
  assert.equal(snapshot.schemaVersion,4);
  assert.deepEqual(snapshot.genesis,{status:'observed',hash:GENESIS});
  assert.deepEqual(snapshot.implementation,{status:'not-recorded'});
  assert.ok(!Object.hasOwn(snapshot,'migration'));
  const selector={blockHash:HASH,requireCanonical:true};
  assert.deepEqual(fake.calls.map(r=>[r.method,r.params]),[
    ['eth_chainId',[]],['eth_getBlockByNumber',['0x0',false]],['eth_getBlockByNumber',['latest',false]],
    ['eth_getCode',[ADDRESS,selector]],...Object.values(SLOTS).map(slot=>['eth_getStorageAt',[ADDRESS,slot,selector]]),
    ['eth_getBlockByNumber',['0x64',false]],['eth_getBlockByNumber',['0x0',false]],['eth_chainId',[]]
  ]);
  assert.equal(new Set(fake.calls.map(r=>r.id)).size,10);
  validateSnapshot(snapshot);
});

test('all selectors compose with genesis, checksum and implementation/live beacon modes', async t => {
  const modes=[['plain',[],0],['direct',['--implementation-code'],1],['beacon',['--implementation-code'],2],
    ['live',['--resolve-beacon'],1],['skip',['--implementation-code'],0]];
  const selections=[['default',[],10],['number',['--block','100'],10],['hash',['--block-hash',HASH],11],
    ['depth0',['--depth','0'],10],['depth1',['--depth','1'],11]];
  for(const [mode,flags,extra] of modes) for(const [selection,select,count] of selections) await t.test(`${mode}/${selection}`,async t=>{
    const dir=await temporaryDirectory(t); const out=join(dir,'snapshot.json');
    const fake=await fakeRpc(t,r=>{
      if(r.method==='eth_getBlockByNumber' && r.params[0]==='latest' && selection==='depth1') return {result:{number:'0x65',hash:OTHER}};
      if(mode==='skip' && r.method==='eth_getCode') return {result:'0x'};
      if(['beacon','live'].includes(mode)) {
        if(r.method==='eth_getStorageAt') return {result:r.params[1]===SLOTS.beacon?word(BEACON):EMPTY};
        if(r.method==='eth_call') return {result:word(IMPLEMENTATION)};
      }
      return {result:response(r)};
    });
    const args=[...command(fake.url,out),...flags,...select,'--strict-checksum'];
    const target='0x52908400098527886E0F7030069857D2E4169EE7';
    args[args.indexOf('--address')+1]=target;
    const result=await cli(args);
    assert.equal(result.code,0,result.stderr); assert.equal(result.stderr,'');
    assert.equal(fake.calls.length,count+extra); pinned(fake.calls);
    const saved=await readSnapshot(out);
    assert.equal(saved.address,target.toLowerCase()); assert.equal(saved.schemaVersion,4);
    assert.deepEqual(saved.genesis,{status:'observed',hash:GENESIS});
    assert.equal(saved.implementation.status,mode==='skip'?'skipped':['plain','live'].includes(mode)?'not-recorded':'observed');
    if(mode==='live') { assert.match(result.stdout,/implementation\(\) returned an address/); assert.ok(!('beaconResolution' in saved)); }
    if(['beacon','live'].includes(mode)) {
      const call=fake.calls.find(r=>r.method==='eth_call');
      assert.deepEqual(call.params[0],{from:target.toLowerCase(),to:BEACON,gas:'0x186a0',value:'0x0',input:'0x5c60da1b'});
    }
    assert.doesNotMatch(result.stdout+await readFile(out,'utf8'),/PRIVATE_|http:/);
    assert.equal((await cli(['inspect',out])).code,0);
    const diff=await cli(['diff','--json','--exit-code',out,out]);
    assert.equal(diff.code,0,diff.stderr); assert.equal(JSON.parse(diff.stdout).schemaVersion,4);
  });
});

test('genesis may be selected by number/hash/depth; huge chain and block integers stay exact',async t=>{
  for(const selected of [{block:'0'},{blockHash:GENESIS},{depth:'100'}]) {
    const fake=await fakeRpc(t,r=>({result:r.method==='eth_getBlockByHash'?{number:'0x0',hash:GENESIS}:response(r)}));
    const snapshot=await capture({...options(fake.url),...selected});
    assert.deepEqual(snapshot.block,{number:'0x0',hash:GENESIS}); pinned(fake.calls,GENESIS);
    assert.equal(fake.calls.filter(r=>r.method==='eth_getBlockByNumber'&&r.params[0]==='0x0').length,4);
  }
  const max=(1n<<256n)-1n; const hex=`0x${max.toString(16)}`;
  const fake=await fakeRpc(t,r=>({result:r.method==='eth_chainId'?hex:
    r.method.startsWith('eth_getBlockBy')&&r.params[0]!=='0x0'?{number:hex,hash:HASH}:response(r)}));
  const snapshot=await capture({...options(fake.url),chainId:max.toString(),block:max.toString()});
  assert.equal(snapshot.chainId,max.toString());assert.equal(snapshot.block.number,hex);
  assert.match(snapshotReport(snapshot),new RegExp(max.toString()));
});

test('invalid genesis flags and existing option conflicts fail before RPC',async t=>{
  const dir=await temporaryDirectory(t);const fake=await fakeRpc(t);
  const base=command(fake.url,join(dir,'PRIVATE_OUTPUT.json'));
  for(const flags of [['--genesis'],['true'],['--genesis=true'],['--resolve-beacon','--implementation-code'],
    ['--block','latest','--depth','0'],['--block-hash',HASH,'--block','0'],['--expected-genesis',GENESIS]]) {
    failure(await cli([...base,...flags]),'USAGE');
  }
  const bad=[...base,'--strict-checksum'];bad[bad.indexOf('--address')+1]='0x52908400098527886e0f7030069857d2e4169ee7';
  failure(await cli(bad),'ADDRESS_CHECKSUM');
  for(const args of [['inspect','--genesis'],['diff','a','b','--genesis'],['migrate','a','--to-version','4','--out','b','--genesis']]) failure(await cli(args),'USAGE');
  await assert.rejects(capture({...options(fake.url),genesis:'true'}),{code:'USAGE'});
  assert.equal(fake.calls.length,0);assert.deepEqual(await readdir(dir),[]);
});

test('initial/final genesis, block and chain failures are bounded, redacted and never save',async t=>{
  const invalid=[null,[],{},'PRIVATE_HEADER',{number:null,hash:null},{number:'0x00',hash:GENESIS},
    {number:'0x1',hash:GENESIS},{number:'0x0',hash:EMPTY},{number:'0x0',hash:'0xab'},
    {number:'0x0',hash:'PRIVATE_HASH'},{number:0,hash:GENESIS},{number:`0x1${'0'.repeat(64)}`,hash:GENESIS}];
  const cases=[...invalid.flatMap((value,i)=>[2,9].map(step=>[`header ${i} at ${step}`,step,value===null?'BLOCK_UNAVAILABLE':'RPC_DATA',{result:value}])),
    ['changed genesis same chain',9,'GENESIS_CHANGED',{result:{number:'0x0',hash:OTHER}}],
    ['late block',8,'BLOCK_CHANGED',{result:{number:'0x64',hash:OTHER}}],
    ['late chain',10,'CHAIN_MISMATCH',{result:'0x2'}],['initial chain',1,'CHAIN_MISMATCH',{result:'0x2'}],
    ...[2,9].map(step=>['remote',step,'RPC_REMOTE',{error:{code:-32000,message:'PRIVATE_ERROR',data:'https://PRIVATE_KEY'}}])];
  for(const [name,step,code,envelope] of cases) await t.test(name,async t=>{
    const dir=await temporaryDirectory(t);let count=0;
    const fake=await fakeRpc(t,r=>++count===step?envelope:{result:response(r)});
    failure(await cli(command(fake.url,join(dir,'PRIVATE_OUT.json'))),code);
    assert.equal(fake.calls.length,step);assert.deepEqual(await readdir(dir),[]);
  });
  for(const step of [2,9]) for(const kind of ['timeout','oversize']) await t.test(`${kind} at ${step}`,async t=>{
    const dir=await temporaryDirectory(t);let count=0;
    const fake=await fakeRpc(t,(r,res)=>{
      if(++count===step) {if(kind==='oversize') {res.writeHead(200,{'content-length':1048577});res.end('PRIVATE_BODY');}return;}
      return {result:response(r)};
    });
    failure(await cli([...command(fake.url,join(dir,'PRIVATE_OUT.json')),'--timeout-ms','100']),kind==='timeout'?'RPC_TIMEOUT':'RPC_SIZE');
    assert.equal(fake.calls.length,step);assert.deepEqual(await readdir(dir),[]);
  });
  // Selected block 0 must agree before any state read, independently of final checks.
  const fake=await fakeRpc(t,r=>({result:r.method==='eth_getBlockByHash'?{number:'0x0',hash:OTHER}:response(r)}));
  await assert.rejects(capture({...options(fake.url),blockHash:OTHER}),{code:'BLOCK_NOT_CANONICAL'});
  let zeroReads=0;
  const switched=await fakeRpc(t,r=>({result:r.method==='eth_getBlockByNumber'&&r.params[0]==='0x0'
    ?{number:'0x0',hash:++zeroReads===1?GENESIS:OTHER}:response(r)}));
  await assert.rejects(capture({...options(switched.url),block:'0'}),{code:'GENESIS_CHANGED'});
  assert.equal(switched.calls.length,3);
});

test('strict v4 validates observations, origins, missing markers and genesis-selected consistency',async()=>{
  const observed=await stored('before-v4');const missing=await stored('migrated-v1-v4');
  for(const base of [observed,missing]) for(const mutate of [s=>{s.extra=true;},s=>{delete s.genesis;},
    s=>{s.genesis.extra=true;},s=>{s.genesis=null;},s=>{s.genesis.status='unknown';},s=>{s.schemaVersion=5;},
    s=>{s.implementation.extra=true;}]) {
    const s=structuredClone(base);mutate(s);assert.throws(()=>validateSnapshot(s),{code:'SNAPSHOT'});
  }
  for(const mutate of [s=>{s.genesis.hash=EMPTY;},s=>{s.genesis.hash=GENESIS.toUpperCase();},s=>{delete s.genesis.hash;},
    s=>{s.genesis.hash='0x01';},s=>{s.migration={fromVersion:2};},s=>{s.block.number='0x0';},
    s=>{s.implementation.address=ADDRESS;},s=>{s.implementation.raw=EMPTY;}]) {
    const s=structuredClone(observed);mutate(s);assert.throws(()=>validateSnapshot(s),{code:'SNAPSHOT'});
  }
  for(const mutate of [s=>{s.genesis.hash=GENESIS;},s=>{delete s.migration;},s=>{s.migration.fromVersion=3;},
    s=>{s.migration.extra=true;},s=>{s.migration.fromVersion=2;},s=>{s.implementation=observed.implementation;}]) {
    const s=structuredClone(missing);mutate(s);assert.throws(()=>validateSnapshot(s),{code:'SNAPSHOT'});
  }
  const atGenesis=structuredClone(observed);atGenesis.block={number:'0x0',hash:GENESIS};validateSnapshot(atGenesis);
  for(const version of [1,2,3]) {const s=structuredClone(observed);s.schemaVersion=version;assert.throws(()=>validateSnapshot(s),{code:'SNAPSHOT'});}
});

test('v4 inspect/diff preserve implementation rules and exit policy; collisions/unknown never compare',async t=>{
  const before=await stored('before-v4'),after=await stored('after-v4'),missing=await stored('migrated-v1-v4');
  const golden=JSON.parse(await readFile(new URL('./fixtures/genesis/beacon-change.json',import.meta.url),'utf8'));
  assert.deepEqual(diffDocument(before,after),golden);
  assert.equal(`${diffReport(before,after)}\n`,await readFile(new URL('./fixtures/genesis/beacon-change.txt',import.meta.url),'utf8'));
  const dir=await temporaryDirectory(t),a=join(dir,'a.json'),b=join(dir,'b.json');
  const cases=[['same',before,before,0],['change',before,after,2],
    ['collision',before,{...after,genesis:{status:'observed',hash:OTHER}},'GENESIS_MISMATCH'],
    ['unknown both',missing,missing,'GENESIS_UNAVAILABLE'],['unknown before',missing,before,'GENESIS_UNAVAILABLE'],
    ['unknown after',before,missing,'GENESIS_UNAVAILABLE']];
  for(const [name,left,right,status] of cases) {
    await writeFile(a,JSON.stringify(left));await writeFile(b,JSON.stringify(right));
    for(const flags of diffFlags) {
      const result=await cli(['diff',...flags,a,b]);
      if(typeof status==='string') failure(result,status);
      else {
        assert.equal(result.code,flags.includes('--exit-code')?status:0,`${name}: ${result.stderr}`);
        if(flags.includes('--json')) {const doc=JSON.parse(result.stdout);assert.equal(doc.schemaVersion,4);assert.deepEqual(doc.genesis,{status:'observed',hash:GENESIS});}
        else assert.match(result.stdout,/Genesis: .*matching observations; forks can share genesis/);
      }
    }
  }
  for(const value of [before,missing]) {
    await writeFile(a,JSON.stringify(value));const result=await cli(['inspect',a]);assert.equal(result.code,0,result.stderr);
    assert.equal(result.stdout,`${snapshotReport(value)}\n`);
    assert.match(result.stdout,value===missing?/network equivalence cannot be established/:/not proof of ancestry/);
  }
  const unavailable={...before,implementation:{status:'not-recorded'}};
  assert.equal(diffDocument(before,unavailable).implementation.comparison,'unavailable');
  assert.deepEqual(diffDocument(before,unavailable).notices,[]);
  const skip={...before,code:'0x',implementation:{status:'skipped',reason:'NO_TARGET_CODE'}};
  assert.equal(diffDocument(skip,skip).implementation.comparison,'unavailable');
  const noCode=structuredClone(before);noCode.implementation.code='0x';noCode.implementation.status='no-code';
  assert.equal(diffDocument(before,noCode).implementation.changes[0].field,'code');
  const differentSource=structuredClone(before);differentSource.implementation.beacon=ADDRESS;differentSource.slots.beacon=word(ADDRESS);
  assert.equal(diffDocument(before,differentSource).implementation.comparison,'provenance-changed');
  assert.match(diffReport(unavailable,unavailable),/not-recorded; saved address provenance/);
  for(const version of [1,2,3]) {
    let old=await readSnapshot(new URL('../examples/before.json',import.meta.url));
    if(version===2) old=await readSnapshot(new URL('../examples/beacon-before-v2.json',import.meta.url));
    if(version===3) old=migrateSnapshot(old,'3');
    await writeFile(a,JSON.stringify(old));await writeFile(b,JSON.stringify(before));
    for(const pair of [[a,b],[b,a]]) for(const flags of diffFlags) failure(await cli(['diff',...flags,...pair]),'DIFF_VERSION');
  }
});

test('offline v1/v2/v3 to v4 migration retains data, origin and source backup without inferring genesis',async t=>{
  const corpus=JSON.parse(await readFile(new URL('./fixtures/migration/sources.json',import.meta.url),'utf8'));
  for(const {source:original} of corpus.cases) for(const source of [original,migrateSnapshot(original,'3')]) {
    const migrated=migrateSnapshot(source,'4');
    assert.deepEqual(migrated.genesis,{status:'not-recorded'});
    for(const key of ['source','capturedAt','chainId','address','block','code','slots']) assert.deepEqual(migrated[key],source[key]);
    assert.deepEqual(migrated.implementation,original.schemaVersion===1?{status:'not-recorded'}:original.implementation);
    assert.deepEqual(migrated.migration,{fromVersion:original.schemaVersion});
    assert.deepEqual(migrated,migrateSnapshot(original,'4'));
  }
  const original=await readSnapshot(new URL('../examples/before.json',import.meta.url));
  assert.deepEqual(migrateSnapshot(original,'4'),await stored('migrated-v1-v4'));
  const dir=await temporaryDirectory(t),input=join(dir,'input.json'),out=join(dir,'out.json');
  await writeFile(input,` \n${JSON.stringify(original,null,3)}\n`,{mode:0o640});const bytes=await readFile(input),before=await stat(input);
  const guard=join(dir,'guard.mjs');
  await writeFile(guard,`import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';
let reads=0,calls=0;process.env=new Proxy(process.env,{get(t,k){if(k==='CONTRACT_WATCH_RPC_URL'){reads++;throw Error('PRIVATE_ENV');}return Reflect.get(t,k);}});
const forbidden=()=>{calls++;throw Error('PRIVATE_NETWORK');};globalThis.fetch=forbidden;http.get=forbidden;http.request=forbidden;https.get=forbidden;https.request=forbidden;
process.on('exit',()=>{assert.equal(reads,0);assert.equal(calls,0);});`);
  const env={NODE_OPTIONS:`--import=${pathToFileURL(guard).href}`,CONTRACT_WATCH_RPC_URL:'https://PRIVATE_KEY.invalid'};
  const args=['migrate',input,'--to-version','4','--out',out];const result=await cli(args,env);
  assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'Snapshot migrated to version 4. Original preserved as backup.\n');
  assert.deepEqual(await readFile(input),bytes);const after=await stat(input);
  for(const key of ['mtimeMs','mode','size','ino']) assert.equal(after[key],before[key]);
  if(process.platform!=='win32') assert.equal((await stat(out)).mode&0o777,0o600);
  assert.equal((await cli(['inspect',out],env)).code,0);
  failure(await cli(['diff','--json','--exit-code',out,out],env),'GENESIS_UNAVAILABLE');
  failure(await cli(args,env),'FILE_EXISTS');
  failure(await cli(['migrate',out,'--to-version','4','--out',join(dir,'again')],env),'MIGRATION_CURRENT');
  failure(await cli(['migrate',out,'--to-version','3','--out',join(dir,'down')],env),'MIGRATION_VERSION');
  failure(await cli(['migrate',input,'--to-version','4','--out',input],env),'MIGRATION_PATH');
  for(const [name,create] of [['hard',link],['symbolic',symlink]]) {
    const dest=join(dir,name);await create(input,dest);
    failure(await cli(['migrate',input,'--to-version','4','--out',dest],env),'FILE_EXISTS');
  }
  const race=join(dir,'race.json');const outcomes=await Promise.allSettled([1,2].map(()=>migrateFile({input,output:race,toVersion:'4'})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'FILE_EXISTS');
  assert.deepEqual(await readFile(out),await readFile(race));
  assert.ok(!(await readdir(dir)).some(n=>n.endsWith('.tmp')||['again','down'].includes(n)));
});

test('v4 migration/read/write bounds hold for both maximum code blobs and malformed files',async t=>{
  const dir=await temporaryDirectory(t);const input=join(dir,'large.json'),out=join(dir,'v4.json');
  const old=await readSnapshot(new URL('../examples/beacon-before-v2.json',import.meta.url));
  old.code=`0x${'60'.repeat(MAX_CODE_BYTES)}`;old.implementation.code=`0x${'61'.repeat(MAX_CODE_BYTES)}`;
  await writeFile(input,JSON.stringify(old).padEnd(MAX_SNAPSHOT_V4_BYTES,' '));
  await migrateFile({input,output:out,toVersion:'4'});
  const migrated=await readSnapshot(out);assert.equal(migrated.code,old.code);assert.equal(migrated.implementation.code,old.implementation.code);
  await writeFile(out,JSON.stringify(migrated).padEnd(MAX_SNAPSHOT_V4_BYTES,' '));assert.deepEqual(await readSnapshot(out),migrated);
  await writeFile(out,JSON.stringify(migrated).padEnd(MAX_SNAPSHOT_V4_BYTES+1,' '));await assert.rejects(readSnapshot(out),{code:'FILE_READ'});
  const observed=await stored('before-v4');observed.code=old.code;observed.implementation.code=old.implementation.code;
  await saveSnapshot(join(dir,'observed.json'),observed);
  for(const invalid of [{...observed,genesis:{status:'observed',hash:EMPTY}},{...observed,extra:'PRIVATE_KEY'}]) {
    await writeFile(input,JSON.stringify(invalid));failure(await cli(['inspect',input]),'SNAPSHOT');
    failure(await cli(['diff','--json','--exit-code',input,input]),'SNAPSHOT');
    failure(await cli(['migrate',input,'--to-version','4','--out',join(dir,'invalid')]),'SNAPSHOT');
  }
  assert.ok(!(await readdir(dir)).includes('invalid'));
});
