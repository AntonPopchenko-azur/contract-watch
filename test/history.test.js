import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { historyOperation, canonicalHistoryJson, MAX_HISTORY_ENTRIES } from '../src/history.js';
import { readBounded, MAX_HISTORY_FILES } from '../src/history-files.js';
import { migrateSnapshot } from '../src/migration.js';
import { fixture, temporaryDirectory, cli, CLI, ROOT, ADDRESS, HASH, IMPLEMENTATION } from './helpers/fake-rpc.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value,null,2)}\n`;
const id = value => hash(canonicalHistoryJson(value));
const snap = value => `snapshot-${id(value)}.json`;
const variants = () => {
  const v1 = fixture(), v2 = { ...fixture(), schemaVersion: 2,
    implementation: { status: 'observed', via: 'implementation-slot', address: IMPLEMENTATION, code: '0x60' } };
  return [v1,v2,migrateSnapshot(v1,'3'),{ ...v2, schemaVersion:4,genesis:{status:'observed',hash:HASH}},migrateSnapshot(v1,'4'),migrateSnapshot(v2,'3'),migrateSnapshot(v2,'4')];
};
async function setup(t, value = fixture()) {
  const dir = await temporaryDirectory(t), source = join(dir,'PRIVATE_SOURCE.json'), history = join(dir,'PRIVATE_HISTORY');
  await fs.writeFile(source,json(value));
  return { dir, source, history, value, run: (operation,input=source) => historyOperation({operation,input:operation==='verify'?undefined:input,directory:history}) };
}
const argv = (p, operation, input=p.source) => ['history',operation,...(operation==='verify'?[]:[input]),'--dir',p.history];
async function state(p) { return p.run('verify'); }
async function entries(p) { return (await fs.readdir(p.history)).filter(n=>n.startsWith('entry-')).sort(); }
async function preserved(path, action) {
  const before=await fs.readFile(path), stat=await fs.stat(path,{bigint:true});
  const result=await action();
  assert.deepEqual(await fs.readFile(path),before);
  const after=await fs.stat(path,{bigint:true});
  for(const key of ['ino','size','mtimeNs','mode'])assert.equal(after[key],stat[key]);
  return result;
}
function safeFailure(result, code) {
  assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,new RegExp(`^Error \\[${code}\\]:`));
  assert.doesNotMatch(result.stderr,/PRIVATE|127\.0\.0\.1|https?:|Error:|\.json/);
}

for (const value of variants()) test(`history preserves v${value.schemaVersion}/${value.genesis?.status??'legacy'}, bytes, timestamps and offline reuse`, async t=>{
  const p=await setup(t,value);
  await preserved(p.source,async()=>{
    assert.equal((await p.run('init')).status,'initialized');
    assert.deepEqual(await fs.readdir(p.history),['index.json']);
    const first=await p.run('add');assert.equal(first.status,'added');assert.equal(first.ordinal,1);assert.equal(first.committed,1);
    assert.deepEqual(await fs.readFile(join(p.history,first.snapshot)),await fs.readFile(p.source));
    assert.equal((await fs.stat(p.history)).mode&0o777,0o700);
    for(const name of await fs.readdir(p.history))assert.equal((await fs.stat(join(p.history,name))).mode&0o777,0o600);
    const next={...value,capturedAt:'2026-10-15T16:30:00.000Z',block:{number:'0x65',hash:`0x${'cd'.repeat(32)}`}};
    const other=join(p.dir,'second.json');await fs.writeFile(other,json(next));
    assert.equal((await p.run('add',other)).ordinal,2);
    assert.equal((await state(p)).committed,2);
    assert.equal((await cli(['inspect',join(p.history,first.snapshot)])).code,0);
    const diff=await cli(['diff','--json',join(p.history,first.snapshot),join(p.history,first.snapshot)]);
    assert.equal(diff.code,value.genesis?.status==='not-recorded'?1:0);
    if(value.schemaVersion<4)assert.equal((await cli(['migrate',join(p.history,first.snapshot),'--to-version','4','--out',join(p.dir,'migrated.json')])).code,0);
  });
});

test('identical logical observations ignore JSON whitespace/key order; preserve first stored bytes',async t=>{
  const p=await setup(t);await p.run('init');const first=await p.run('add');
  await preserved(join(p.history,first.snapshot),async()=>{
    const reordered=Object.fromEntries(Object.entries(p.value).reverse()),other=join(p.dir,'same.json');
    await fs.writeFile(other,JSON.stringify(reordered));
    for(const operation of ['add','recover']){const r=await p.run(operation,other);assert.equal(r.status,'already-present');assert.equal(r.ordinal,1);}
  });
  assert.equal((await state(p)).committed,1);
  const later={...p.value,capturedAt:'2026-10-15T16:31:00.000Z'};await fs.writeFile(p.source,json(later));
  assert.equal((await p.run('add')).ordinal,2);
});

for(const dimension of ['address','chainId','source','version','genesis-hash','genesis-unknown'])test(`history refuses incompatible ${dimension}`,async t=>{
  const original=dimension.startsWith('genesis')?variants()[3]:fixture(),p=await setup(t,original);
  await p.run('init');await p.run('add');const changed=structuredClone(original);
  if(dimension==='address')changed.address=IMPLEMENTATION;
  if(dimension==='chainId')changed.chainId='2';
  if(dimension==='source')changed.source='rpc';
  if(dimension==='version')Object.assign(changed,migrateSnapshot(original,'3'));
  if(dimension==='genesis-hash')changed.genesis.hash=`0x${'cd'.repeat(32)}`;
  if(dimension==='genesis-unknown')Object.assign(changed,migrateSnapshot(variants()[1],'4'));
  const other=join(p.dir,'different.json');await fs.writeFile(other,json(changed));
  const before=await fs.readdir(p.history);
  await assert.rejects(p.run('add',other),{code:'HISTORY_IDENTITY'});
  assert.deepEqual(await fs.readdir(p.history),before);assert.equal((await state(p)).committed,1);
});

for(const mutation of [
  b=>Buffer.from('{'),b=>Buffer.from(`{"schemaVersion":1,${b.toString().trim().slice(1)}`),
  b=>Buffer.concat([Buffer.from([0xff]),b]),b=>Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),b]),
  b=>Buffer.from('['.repeat(10000)+'0'+']'.repeat(10000)),b=>Buffer.alloc(768*1024+1,32),
  b=>Buffer.concat([b,Buffer.alloc(512*1024,32)]),b=>Buffer.from(b.toString().replace('"schemaVersion": 1','"schemaVersion": 5')),
  b=>Buffer.from(b.toString().replace('"source": "synthetic"','"source": "https://PRIVATE"'))
])test('invalid or over-limit source is rejected before creating a directory',async t=>{
  const p=await setup(t);await fs.writeFile(p.source,mutation(await fs.readFile(p.source)));
  safeFailure(await cli(argv(p,'init')),'HISTORY_INPUT');await assert.rejects(fs.lstat(p.history),{code:'ENOENT'});
});

for(const kind of ['symlink','directory','fifo'])test(`source ${kind} is refused without hanging or output`,async t=>{
  const p=await setup(t),other=join(p.dir,'special');
  if(kind==='symlink')await fs.symlink(p.source,other);
  if(kind==='directory')await fs.mkdir(other);
  if(kind==='fifo')execFileSync('mkfifo',[other],{cwd:ROOT});
  safeFailure(await cli(argv(p,'init',other)),'HISTORY_INPUT');await assert.rejects(fs.lstat(p.history),{code:'ENOENT'});
});

for(const mutation of ['missing-snapshot','changed-snapshot','changed-header','unknown-header','duplicate-key','oversize-index','entry-gap','entry-hash','entry-path','entry-ordinal','foreign','symlink','fifo','stage-symlink'])test(`verify detects ${mutation} and preserves existing bytes`,async t=>{
  const p=await setup(t);await p.run('init');const r=await p.run('add'),file=join(p.history,r.snapshot),entry=join(p.history,'entry-0001.json');
  if(mutation==='missing-snapshot')await fs.unlink(file);
  if(mutation==='changed-snapshot')await fs.appendFile(file,' ');
  if(mutation==='changed-header'){const h=JSON.parse(await fs.readFile(join(p.history,'index.json')));h.identity.chainId='2';await fs.writeFile(join(p.history,'index.json'),json(h));}
  if(mutation==='unknown-header'){const h=JSON.parse(await fs.readFile(join(p.history,'index.json')));h.PRIVATE='https://PRIVATE';await fs.writeFile(join(p.history,'index.json'),json(h));}
  if(mutation==='duplicate-key')await fs.writeFile(entry,'{"ordinal":1,'+(await fs.readFile(entry,'utf8')).trim().slice(1));
  if(mutation==='oversize-index')await fs.writeFile(entry,Buffer.alloc(4097));
  if(mutation==='entry-gap')await fs.rename(entry,join(p.history,'entry-0002.json'));
  if(['entry-hash','entry-path','entry-ordinal'].includes(mutation)){const e=JSON.parse(await fs.readFile(entry));if(mutation==='entry-hash')e.sha256='0'.repeat(64);if(mutation==='entry-path')e.snapshot='../../PRIVATE';if(mutation==='entry-ordinal')e.ordinal=2;await fs.writeFile(entry,json(e));}
  if(mutation==='foreign')await fs.writeFile(join(p.history,'PRIVATE_foreign'),'keep');
  if(['symlink','fifo'].includes(mutation)){await fs.unlink(file);if(mutation==='symlink')await fs.symlink(p.source,file);else execFileSync('mkfifo',[file],{cwd:ROOT});}
  if(mutation==='stage-symlink')await fs.symlink(p.source,join(p.history,'.cw-stage-00000000-0000-4000-8000-000000000000.tmp'));
  const before=await fs.readdir(p.history);
  const checked=await cli(argv(p,'verify'));safeFailure(checked,mutation==='foreign'?'HISTORY_DIRECTORY':'HISTORY_CORRUPT');
  assert.deepEqual(await fs.readdir(p.history),before);
});

test('root symlinks and existing init destinations are refused; foreign data is preserved',async t=>{
  const p=await setup(t);await fs.mkdir(p.history);await fs.writeFile(join(p.history,'keep'),'PRIVATE');
  await assert.rejects(p.run('init'),{code:'HISTORY_EXISTS'});
  const link=join(p.dir,'link');await fs.symlink(p.history,link);
  await assert.rejects(historyOperation({operation:'verify',directory:link}),{code:'HISTORY_DIRECTORY'});
  await assert.rejects(p.run('recover'),{code:'HISTORY_DIRECTORY'});
  assert.equal(await fs.readFile(join(p.history,'keep'),'utf8'),'PRIVATE');
});

test('actual read is bounded even when metadata lies and a file grows',async t=>{
  const p=await setup(t);await fs.writeFile(p.source,Buffer.alloc(100));
  const original=fs.open;let total=0;
  fs.open=async(...args)=>{const f=await original(...args),read=f.read.bind(f);f.read=async(...a)=>{const r=await read(...a);total+=r.bytesRead;return r;};return f;};syncBuiltinESMExports();
  try{await assert.rejects(readBounded(p.source,10),{code:'HISTORY_CORRUPT'});assert.equal(total,0);}finally{fs.open=original;syncBuiltinESMExports();}
  await fs.writeFile(p.source,'0123456789');let grown=false;
  fs.open=async(...args)=>{const f=await original(...args),read=f.read.bind(f);f.read=async(...a)=>{if(!grown){grown=true;await fs.appendFile(p.source,'more-than-the-limit');}const r=await read(...a);total+=r.bytesRead;return r;};return f;};syncBuiltinESMExports();
  try{await assert.rejects(readBounded(p.source,10),{code:'HISTORY_CORRUPT'});assert.equal(total,11);}finally{fs.open=original;syncBuiltinESMExports();}
});

test('directory count is bounded without recursive scanning or removing foreign files',async t=>{
  const p=await setup(t);await p.run('init');
  for(let i=0;i<MAX_HISTORY_FILES;i++)await fs.writeFile(join(p.history,`foreign-${i}`),'keep');
  await assert.rejects(p.run('verify'),{code:'HISTORY_LIMIT'});
  assert.equal((await fs.readdir(p.history)).length,MAX_HISTORY_FILES+1);
});

test('append-only index reaches exactly 128 records, preserves the chain and refuses record 129',async t=>{
  const p=await setup(t);await p.run('init');let previous=hash(await fs.readFile(join(p.history,'index.json')));
  for(let n=1;n<=MAX_HISTORY_ENTRIES;n++){
    const value={...fixture(),block:{number:`0x${n.toString(16)}`,hash:HASH}},bytes=json(value),observationId=id(value),snapshot=snap(value);
    await fs.writeFile(join(p.history,snapshot),bytes);
    const record={kind:'contract-watch-history-entry',schemaVersion:1,ordinal:n,previous,observationId,snapshot,sha256:hash(bytes),bytes:Buffer.byteLength(bytes),capturedAt:value.capturedAt,block:value.block};
    const encoded=json(record);await fs.writeFile(join(p.history,`entry-${String(n).padStart(4,'0')}.json`),encoded);previous=hash(encoded);
  }
  assert.equal((await state(p)).committed,128);
  await fs.writeFile(p.source,json({...fixture(),block:{number:'0x100',hash:HASH}}));
  await assert.rejects(p.run('add'),{code:'HISTORY_LIMIT'});assert.equal((await entries(p)).length,128);
});

for(const args of [[],['wat'],['verify'],['verify','PRIVATE','--dir','PRIVATE'],['add','--dir','PRIVATE'],['add','PRIVATE','--dir','PRIVATE','--dir','PRIVATE'],['verify','--dir=PRIVATE'],['verify','--dir','PRIVATE','--rpc','PRIVATE'],['add','a','b','--dir','PRIVATE']])test('history CLI rejects ambiguous/unknown options safely',async()=>{
  safeFailure(await cli(['history',...args]),'USAGE');
});

test('all history operations ignore RPC env/config and network, and verify is read-only',async t=>{
  const p=await setup(t),preload=join(p.dir,'offline.mjs');
  await fs.writeFile(preload,`import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
const no=()=>{throw Error('PRIVATE_NETWORK_OR_ENV');};http.request=no;https.request=no;globalThis.fetch=no;
process.env=new Proxy(process.env,{get(t,k){if(String(k).includes('RPC')||String(k).startsWith('CONTRACT_WATCH'))return no();return Reflect.get(t,k);}});syncBuiltinESMExports();`);
  const env={NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`,CONTRACT_WATCH_RPC_URL:'http://127.0.0.1:1/PRIVATE'};
  for(const operation of ['init','add','recover','verify']){
    const result=await cli(argv(p,operation),env);assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');assert.doesNotMatch(result.stdout,/PRIVATE|127\.0|https?:/);
  }
  for(const name of await fs.readdir(p.history))await preserved(join(p.history,name),()=>cli(argv(p,'verify'),env));
});

// Child-process gates hold the exact publication boundary, not an estimated delay.
function child(t,args,script){
  const p=spawn(process.execPath,[CLI,...args],{cwd:ROOT,env:{...process.env,NODE_OPTIONS:`--import=${pathToFileURL(script).href}`},stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';p.stdout.on('data',b=>{stdout+=b;});p.stderr.on('data',b=>{stderr+=b;});
  const messages=[],waiters=[];p.on('message',m=>{messages.push(m);for(const wake of waiters.splice(0))wake();});
  const result=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  t.after(()=>{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');});
  const ready=async()=>{while(!messages.length)await new Promise(r=>waiters.push(r));return messages.shift();};
  return {p,result,ready};
}
async function faultScript(p,kind,phase,crash=false){
  const script=join(p.dir,`fault-${kind}-${phase}-${crash}.mjs`);
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const kind=${JSON.stringify(kind)},phase=${JSON.stringify(phase)},crash=${crash};let used=false;
const classify=text=>text.includes('contract-watch-history-entry')?'entry':text.includes('contract-watch-history')?'header':'snapshot';
async function point(k,p){if(used||k!==kind||p!==phase)return;used=true;if(crash)await new Promise(resolve=>{process.once('message',resolve);process.send('ready');});else throw Object.assign(Error('PRIVATE_FS'),{code:'EIO'});}
const open=fs.open;fs.open=async(...a)=>{const f=await open(...a);if(a[1]==='wx'){
let k;const write=f.writeFile.bind(f),sync=f.sync.bind(f),close=f.close.bind(f);
f.writeFile=async(bytes)=>{k=classify(bytes.toString());if(phase==='write'&&k===kind){await write(bytes.subarray(0,10));await point(k,'write');}const r=await write(bytes);await point(k,'after-write');return r;};
f.sync=async()=>{await point(k,'sync');const r=await sync();await point(k,'after-sync');return r;};
f.close=async()=>{const r=await close();await point(k,'close');return r;};
}return f;};
const link=fs.link;fs.link=async(from,to)=>{const k=to.endsWith('/index.json')?'header':to.includes('/entry-')?'entry':'snapshot';await point(k,'link');const r=await link(from,to);await point(k,'after-link');return r;};syncBuiltinESMExports();`);
  return script;
}

for(const kind of ['snapshot','entry'])for(const phase of ['write','sync','close','link','after-link'])test(`${kind} ${phase} failure preserves prior commit and supports explicit recovery`,async t=>{
  const p=await setup(t);await p.run('init');const first=await p.run('add');
  const next={...fixture(),capturedAt:'2026-10-15T16:31:00.000Z'};await fs.writeFile(p.source,json(next));
  const script=await faultScript(p,kind,phase);
  await preserved(join(p.history,first.snapshot),async()=>{
    safeFailure(await cli(argv(p,'add'),{NODE_OPTIONS:`--import=${pathToFileURL(script).href}`}), 'HISTORY_WRITE');
    const before=await state(p);assert.ok(before.committed===1||before.committed===2);
    const repair=await p.run(before.pending?'recover':'add');assert.ok(['added','recovered','already-present'].includes(repair.status));
    assert.equal((await state(p)).committed,2);assert.equal((await state(p)).pending,0);
  });
  assert.equal((await fs.readdir(p.history)).some(n=>n.endsWith('.tmp')),false);
});

for(const phase of ['write','sync','close','link','after-link'])test(`interrupted header ${phase} is never overwritten and can be initialized explicitly`,async t=>{
  const p=await setup(t),script=await faultScript(p,'header',phase);
  safeFailure(await cli(argv(p,'init'),{NODE_OPTIONS:`--import=${pathToFileURL(script).href}`}), 'HISTORY_WRITE');
  if(phase==='after-link')assert.equal((await state(p)).committed,0);
  else assert.equal((await p.run('recover')).status,'initialized');
  await p.run('add');assert.equal((await state(p)).committed,1);
});

for(const signal of ['SIGINT','SIGTERM','SIGKILL'])for(const [kind,phase] of [['snapshot','write'],['snapshot','after-sync'],['snapshot','after-link'],['entry','close'],['entry','link'],['entry','after-link']])test(`real ${signal} at ${kind}/${phase}: only indexed snapshots count`,{timeout:10000},async t=>{
  const p=await setup(t);await p.run('init');const first=await p.run('add');
  await fs.writeFile(p.source,json({...fixture(),capturedAt:'2026-10-15T16:31:00.000Z'}));
  const script=await faultScript(p,kind,phase,true),c=child(t,argv(p,'add'),script);await c.ready();c.p.kill(signal);
  const killed=await c.result;assert.equal(killed.signal,signal);assert.equal(killed.stdout,'');assert.equal(killed.stderr,'');
  const before=await state(p);assert.equal(before.committed,kind==='entry'&&phase==='after-link'?2:1);assert.ok(before.staged>0);
  await preserved(join(p.history,first.snapshot),()=>p.run(before.pending?'recover':'add'));
  const after=await state(p);assert.equal(after.committed,2);assert.equal(after.pending,0);assert.equal(after.staged,before.staged);
});

for(const identical of [false,true])test(`simultaneous writers ${identical?'deduplicate':'conflict without lost updates'}`,{timeout:10000},async t=>{
  const p=await setup(t);await p.run('init');
  const script=await faultScript(p,'entry','link',true),first=child(t,argv(p,'add'),script);await first.ready();
  const other=join(p.dir,'other.json');await fs.writeFile(other,json(identical?p.value:{...p.value,capturedAt:'2026-10-15T16:32:00.000Z'}));
  const second=child(t,argv(p,'add',other),script);await second.ready();
  first.p.send('release');assert.equal((await first.result).code,0);
  second.p.send('release');const result=await second.result;
  if(identical){assert.equal(result.code,0);assert.equal((await state(p)).committed,1);}
  else{safeFailure(result,'HISTORY_CHANGED');assert.equal((await state(p)).pending,1);await p.run('recover',other);assert.equal((await state(p)).committed,2);}
});

test('a hard-linked source is read-only and its stored copy is independent',async t=>{
  const p=await setup(t),alias=join(p.dir,'alias.json');await fs.link(p.source,alias);
  await preserved(p.source,async()=>{await p.run('init',alias);await p.run('add',alias);});
  assert.notEqual((await fs.stat(p.source)).ino,(await fs.stat(join(p.history,snap(p.value)))).ino);
  await fs.writeFile(alias,'PRIVATE_CORRUPT');assert.equal((await state(p)).committed,1);
});

test('recovery requires its exact explicit source and never imports another pending snapshot',async t=>{
  const p=await setup(t);await p.run('init');await p.run('add');
  const other={...p.value,capturedAt:'2026-10-15T16:33:00.000Z'};await fs.writeFile(join(p.history,snap(other)),json(other));
  assert.equal((await p.run('recover')).status,'already-present');assert.equal((await state(p)).pending,1);
  await fs.writeFile(p.source,json({...p.value,capturedAt:'2026-10-15T16:34:00.000Z'}));
  await assert.rejects(p.run('recover'),{code:'HISTORY_RECOVERY'});assert.equal((await state(p)).pending,1);
  // The user may explicitly select the pending file itself when the original is unavailable.
  assert.equal((await p.run('recover',join(p.history,snap(other)))).status,'recovered');
  assert.equal((await state(p)).committed,2);
});

test('a missing header with prior observations cannot be reinitialized by recovery',async t=>{
  const p=await setup(t);await p.run('init');await p.run('add');await fs.unlink(join(p.history,'index.json'));
  const before=await fs.readdir(p.history);
  await assert.rejects(p.run('recover'),{code:'HISTORY_CORRUPT'});assert.deepEqual(await fs.readdir(p.history),before);
});

test('SIGKILL after exclusive mkdir leaves recoverable empty initialization',{timeout:10000},async t=>{
  const p=await setup(t),script=join(p.dir,'mkdir.mjs');
  await fs.writeFile(script,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdir;fs.mkdir=async(...a)=>{const r=await mkdir(...a);await new Promise(resolve=>{process.once('message',resolve);process.send('ready');});return r;};syncBuiltinESMExports();`);
  const c=child(t,argv(p,'init'),script);await c.ready();c.p.kill('SIGKILL');assert.equal((await c.result).stdout,'');
  assert.deepEqual(await fs.readdir(p.history),[]);assert.equal((await p.run('recover')).status,'initialized');
  assert.equal((await state(p)).committed,0);await p.run('add');assert.equal((await state(p)).committed,1);
});

test('source path substitution during a bounded read is detected before output mutation',async t=>{
  const p=await setup(t),original=fs.open;let swapped=false;
  fs.open=async(...args)=>{const f=await original(...args),read=f.read.bind(f);f.read=async(...a)=>{const r=await read(...a);if(!swapped){swapped=true;await fs.rename(p.source,`${p.source}.kept`);await fs.writeFile(p.source,json(p.value));}return r;};return f;};syncBuiltinESMExports();
  try{await assert.rejects(p.run('init'),{code:'HISTORY_INPUT'});}finally{fs.open=original;syncBuiltinESMExports();}
  await assert.rejects(fs.lstat(p.history),{code:'ENOENT'});assert.deepEqual(await fs.readFile(`${p.source}.kept`),await fs.readFile(p.source));
});

test('substituted target directory is not used for publication or cleanup',async t=>{
  const p=await setup(t);await p.run('init');const original=fs.open;let swapped=false;
  fs.open=async(...args)=>{const f=await original(...args);if(args[1]==='wx'){const close=f.close.bind(f);f.close=async()=>{const r=await close();if(!swapped){swapped=true;await fs.rename(p.history,`${p.history}.kept`);await fs.mkdir(p.history);await fs.writeFile(join(p.history,'foreign'),'PRIVATE_KEEP');}return r;};}return f;};syncBuiltinESMExports();
  try{await assert.rejects(p.run('add'),{code:'HISTORY_WRITE'});}finally{fs.open=original;syncBuiltinESMExports();}
  assert.deepEqual(await fs.readdir(p.history),['foreign']);assert.equal(await fs.readFile(join(p.history,'foreign'),'utf8'),'PRIVATE_KEEP');
  assert.ok((await fs.readdir(`${p.history}.kept`)).includes('index.json'));
});

test('temporary substitution is preserved, and later explicit recovery does not sweep it',async t=>{
  const p=await setup(t);await p.run('init');const original=fs.link;let temporary;
  fs.link=async(from,to)=>{const r=await original(from,to);if(to.includes('/snapshot-')&&!temporary){temporary=from;await fs.unlink(from);await fs.writeFile(from,'PRIVATE_KEEP');}return r;};syncBuiltinESMExports();
  try{await assert.rejects(p.run('add'),{code:'HISTORY_WRITE'});}finally{fs.link=original;syncBuiltinESMExports();}
  assert.equal(await fs.readFile(temporary,'utf8'),'PRIVATE_KEEP');assert.equal((await state(p)).pending,1);
  await p.run('recover');assert.equal((await state(p)).committed,1);assert.equal(await fs.readFile(temporary,'utf8'),'PRIVATE_KEEP');
});

test('unlink failure leaves pending data explicit; recovery preserves earlier data and abandoned stages',async t=>{
  const p=await setup(t);await p.run('init');const first=await p.run('add');
  await fs.writeFile(p.source,json({...p.value,capturedAt:'2026-10-15T16:35:00.000Z'}));
  const original=fs.unlink;fs.unlink=async()=>{throw Error('PRIVATE_UNLINK');};syncBuiltinESMExports();
  try{await assert.rejects(p.run('add'),{code:'HISTORY_WRITE'});}finally{fs.unlink=original;syncBuiltinESMExports();}
  assert.equal((await state(p)).pending,1);
  await preserved(join(p.history,first.snapshot),()=>p.run('recover'));
  assert.equal((await state(p)).committed,2);assert.equal((await state(p)).staged,1);
});

test('an input/snapshot filename collision never overwrites an unrelated file',async t=>{
  const p=await setup(t);await p.run('init');const target=join(p.history,snap(p.value));await fs.writeFile(target,'PRIVATE_KEEP');
  await preserved(target,()=>assert.rejects(p.run('add'),{code:'HISTORY_CORRUPT'}));
  assert.deepEqual(await entries(p),[]);
});

test('history index reads stop at their byte limit even with lying stat sizes',async t=>{
  const p=await setup(t);await p.run('init');await fs.writeFile(join(p.history,'index.json'),Buffer.alloc(10000,32));
  const originalOpen=fs.open,originalStat=fs.lstat;let total=0;
  const fake=stat=>new Proxy(stat,{get(t,k){return k==='size'?10n:Reflect.get(t,k);}});
  fs.lstat=async(...a)=>{const s=await originalStat(...a);return String(a[0]).endsWith('/index.json')?fake(s):s;};
  fs.open=async(...a)=>{const f=await originalOpen(...a);if(String(a[0]).endsWith('/index.json')){const stat=f.stat.bind(f),read=f.read.bind(f);f.stat=async(...x)=>fake(await stat(...x));f.read=async(...x)=>{const r=await read(...x);total+=r.bytesRead;return r;};}return f;};syncBuiltinESMExports();
  try{await assert.rejects(p.run('verify'),{code:'HISTORY_CORRUPT'});assert.equal(total,4097);}finally{fs.open=originalOpen;fs.lstat=originalStat;syncBuiltinESMExports();}
});

test('concurrent init has one exclusive winner and never replaces its header',async t=>{
  const p=await setup(t),results=await Promise.all([cli(argv(p,'init')),cli(argv(p,'init'))]);
  assert.deepEqual(results.map(r=>r.code).sort(),[0,1]);safeFailure(results.find(r=>r.code===1),'HISTORY_EXISTS');
  assert.equal((await state(p)).committed,0);assert.deepEqual(await fs.readdir(p.history),['index.json']);
});

test('a disappeared new index entry cannot produce an added acknowledgement',async t=>{
  const p=await setup(t);await p.run('init');const original=fs.link;
  fs.link=async(from,to)=>{const result=await original(from,to);if(to.includes('/entry-'))await fs.unlink(to);return result;};syncBuiltinESMExports();
  try{await assert.rejects(p.run('add'),{code:'HISTORY_CHANGED'});}finally{fs.link=original;syncBuiltinESMExports();}
  assert.equal((await state(p)).committed,0);assert.equal((await state(p)).pending,1);
  assert.equal((await p.run('recover')).status,'recovered');
});

test('a replaced identity at the end of initialization cannot be acknowledged as the requested history',async t=>{
  const p=await setup(t),original=fs.link;
  fs.link=async(from,to)=>{const result=await original(from,to);if(to.endsWith('/index.json')){const header=JSON.parse(await fs.readFile(to));header.identity.chainId='2';await fs.writeFile(to,json(header));}return result;};syncBuiltinESMExports();
  try{await assert.rejects(p.run('init'),{code:'HISTORY_CHANGED'});}finally{fs.link=original;syncBuiltinESMExports();}
  assert.deepEqual(await fs.readdir(p.history),['index.json']);await assert.rejects(p.run('add'),{code:'HISTORY_IDENTITY'});
});
