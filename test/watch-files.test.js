import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as turn } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { WatchOutput } from '../src/watch.js';
import { OwnedOutputs } from '../src/owned-outputs.js';
import { readSnapshot, saveSnapshot } from '../src/snapshot.js';
import { temporaryDirectory, fakeRpc, protocolResult, fixture, cli } from './helpers/fake-rpc.js';
import { watchArgs, watchChild, watchPreload, cancelled, cleanup } from './helpers/watch-child.js';

const deferred = () => { let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; };
const env = (script,url) => ({CONTRACT_WATCH_RPC_URL:url,NODE_OPTIONS:`--import=${pathToFileURL(script).href}`});
async function stop(c, signal, release=false, expected=cancelled) {
  c.p.kill(signal); await c.message(m=>m.signal===signal);
  if(release){
    const next=signal==='SIGINT'?'SIGTERM':'SIGINT';
    c.p.kill(next); await c.message(m=>m.signal===next);
  }
  if(release)c.p.send('release');
  assert.deepEqual(await c.result,{code:signal==='SIGINT'?130:143,signal:null,stdout:'',stderr:expected});
}

for(const signal of ['SIGINT','SIGTERM']) {
  for(const point of ['open','write','before-sync','after-sync','close','before-link','after-link','temp-cleanup','pin-close']) {
    test(`watch ${signal} during second ${point}: retain first commit, drain then clean only current`,{timeout:10000},async t=>{
      const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t),script=await watchPreload(dir,point);
      const c=watchChild(t,watchArgs(output),env(script,fake.url));
      await c.message(m=>m.point===point);
      const first=await fs.readFile(join(output,'observation-001.json'));
      await fs.writeFile(join(output,'user-added'),'KEEP');
      await stop(c,signal,true);
      assert.deepEqual(await fs.readdir(output),['observation-001.json','user-added']);
      assert.deepEqual(await fs.readFile(join(output,'observation-001.json')),first);
      assert.equal(await fs.readFile(join(output,'user-added'),'utf8'),'KEEP');
      assert.equal(fake.calls.length,16);
    });
  }
  for(const point of ['headers','body','backoff','rate-limit','interval','mkdir']) {
    test(`watch ${signal} at ${point}: stop admission/transport/timers, preserve confirmed files`,{timeout:10000},async t=>{
      const dir=await temporaryDirectory(t),output=join(dir,'session'),hit=deferred();let active=0;
      const fake=await fakeRpc(t,(r,res)=>{
        active++;res.once('close',()=>active--);
        if(fake.calls.length<=8)return {result:protocolResult(r)};
        if(point==='body'){res.writeHead(200);res.write('{"jsonrpc":');}
        if(point==='backoff'||point==='rate-limit'){res.writeHead(point==='backoff'?503:429,{'Retry-After':'30'});res.end('PRIVATE');}
        hit.resolve();
      });
      const script=await watchPreload(dir,point);
      const argv=watchArgs(output,['--retries','3','--deadline-ms','60000']);
      if(point==='interval')argv[argv.indexOf('--interval-ms')+1]='60000';
      const c=watchChild(t,argv,env(script,fake.url));
      if(['headers','body'].includes(point))await hit.promise;else await c.message(m=>m.point===point);
      await stop(c,signal,point==='mkdir');await turn();
      assert.equal(active,0);
      assert.deepEqual(await fs.readdir(output),point==='mkdir'?[]:['observation-001.json']);
      assert.equal(fake.calls.length,point==='mkdir'?0:point==='interval'?8:9);
    });
  }
}

for(const point of ['write','after-link','temp-cleanup','pin-close']) test(`duration during ${point}: drain and roll back only current observation`,{timeout:10000},async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t),script=await watchPreload(dir,point);
  const c=watchChild(t,watchArgs(output,['--duration-ms','600000']),env(script,fake.url));
  await c.message(m=>m.point===point);c.p.send('expire');
  const result=await c.result;
  assert.equal(result.code,1);assert.equal(result.stderr,'');
  const report=JSON.parse(result.stdout);
  assert.equal(report.stopReason,'duration');assert.equal(report.saved,1);assert.equal(report.stopped,1);
  assert.deepEqual(report.outcomes[1],{ordinal:2,status:'stopped',reason:'duration'});
  assert.deepEqual(await fs.readdir(output),['observation-001.json']);assert.equal(fake.calls.length,16);
});

for(const type of ['file','directory','symlink','hardlink']) test(`existing destination ${type} refused without RPC or modification`,async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),foreign=join(dir,'foreign'),fake=await fakeRpc(t);
  await fs.writeFile(foreign,'KEEP');
  if(type==='directory')await fs.mkdir(output);
  if(type==='file')await fs.writeFile(output,'KEEP');
  if(type==='symlink')await fs.symlink(foreign,output);
  if(type==='hardlink')await fs.link(foreign,output);
  const before=await fs.lstat(output);
  const result=await cli(watchArgs(output),{CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/WATCH_EXISTS/);
  assert.equal((await fs.lstat(output)).ino,before.ino);assert.equal(await fs.readFile(foreign,'utf8'),'KEEP');
  assert.equal(fake.calls.length,0);
});

test('concurrent session directory creation has one winner and no reused files',async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t);
  const argv=watchArgs(output);argv[argv.indexOf('--count')+1]='1';
  const results=await Promise.all([cli(argv,{CONTRACT_WATCH_RPC_URL:fake.url}),cli(argv,{CONTRACT_WATCH_RPC_URL:fake.url})]);
  assert.deepEqual(results.map(r=>r.code).sort(),[0,1]);
  assert.match(results.find(r=>r.code).stderr,/WATCH_EXISTS/);
  assert.equal(fake.calls.length,8);assert.deepEqual(await fs.readdir(output),['observation-001.json']);
});

for(const type of ['file','symlink','hardlink']) test(`collision at second publication preserves foreign ${type} and earlier commit`,{timeout:10000},async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),foreign=join(dir,'foreign'),fake=await fakeRpc(t);
  await fs.writeFile(foreign,'KEEP');const script=await watchPreload(dir,'before-link');
  const c=watchChild(t,watchArgs(output),env(script,fake.url));await c.message(m=>m.point==='before-link');
  const target=join(output,'observation-002.json');
  if(type==='file')await fs.writeFile(target,'KEEP');
  if(type==='symlink')await fs.symlink(foreign,target);
  if(type==='hardlink')await fs.link(foreign,target);
  c.p.send('release');const result=await c.result;
  assert.equal(result.code,1);assert.equal(JSON.parse(result.stdout).outcomes[1].error.code,'FILE_EXISTS');
  assert.equal(await fs.readFile(target,'utf8'),'KEEP');assert.equal(await fs.readFile(foreign,'utf8'),'KEEP');
  await readSnapshot(join(output,'observation-001.json'));
  assert.deepEqual(await fs.readdir(output),['observation-001.json','observation-002.json']);
});

for(const type of ['file','symlink','modified','directory','unlink-error','stat-error']) test(`current ownership cleanup preserves uncertain paths: ${type}`,async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),controller=new AbortController();
  const owner=new OwnedOutputs(controller.signal);await owner.mkdir(output);
  const clock={signal:controller.signal,check(){if(controller.signal.aborted)throw Error('stop');}};
  const first=new WatchOutput(clock,owner.directories[0]);
  await saveSnapshot(join(output,'observation-001.json'),fixture(),first);await first.commit();
  const current=new WatchOutput(clock,owner.directories[0]),path=join(output,'observation-002.json');
  await saveSnapshot(path,fixture(),current);
  const foreign=join(dir,'foreign');await fs.writeFile(foreign,'KEEP');
  if(type==='file'||type==='symlink'){await fs.unlink(path);if(type==='file')await fs.writeFile(path,'KEEP');else await fs.symlink(foreign,path);}
  if(type==='modified')await fs.writeFile(path,'KEEP');
  if(type==='directory'){await fs.rename(output,output+'-moved');await fs.mkdir(output);await fs.writeFile(path,'KEEP');}
  const originalUnlink=fs.unlink,originalStat=fs.lstat;
  try{
    if(type==='unlink-error')fs.unlink=async()=>{throw Error('PRIVATE');};
    if(type==='stat-error')fs.lstat=async()=>{throw Error('PRIVATE');};
    syncBuiltinESMExports();controller.abort();assert.equal(await current.rollback(),false);
  }finally{fs.unlink=originalUnlink;fs.lstat=originalStat;syncBuiltinESMExports();}
  assert.equal(await fs.readFile(foreign,'utf8'),'KEEP');
  if(['file','symlink','modified','directory'].includes(type))assert.equal(await fs.readFile(path,'utf8'),'KEEP');
  await readSnapshot(join(type==='directory'?output+'-moved':output,'observation-001.json'));
  assert.equal(current.handles.size,0);
});

test('substituted session directory fails before another RPC and never writes through replacement symlink',{timeout:10000},async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),foreign=join(dir,'foreign'),fake=await fakeRpc(t);
  await fs.mkdir(foreign);await fs.writeFile(join(foreign,'KEEP'),'KEEP');
  const script=await watchPreload(dir,'before-link');
  const c=watchChild(t,watchArgs(output),env(script,fake.url));await c.message(m=>m.point==='before-link');
  await fs.rename(output,output+'-moved');await fs.symlink(foreign,output);c.p.send('release');
  const result=await c.result;
  assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(result.stderr,cleanup);
  assert.deepEqual(await fs.readdir(foreign),['KEEP']);
  await readSnapshot(join(output+'-moved','observation-001.json'));
});

for(const signal of ['SIGINT','SIGTERM',null]) test(`cleanup I/O failure is global, preserves commits, signal=${signal}`,{timeout:10000},async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t);
  const script=await watchPreload(dir,'temp-cleanup',2,`
const cleanupUnlink=fs.unlink;
fs.unlink=async(...a)=>{if(writes===2){await gate('temp-cleanup',writes);throw Error('PRIVATE_TOKEN');}return cleanupUnlink(...a);};
`);
  const c=watchChild(t,watchArgs(output),env(script,fake.url));await c.message(m=>m.point==='temp-cleanup');
  if(signal)await stop(c,signal,true,cleanup);
  else{c.p.send('release');assert.deepEqual(await c.result,{code:1,signal:null,stdout:'',stderr:cleanup});}
  await readSnapshot(join(output,'observation-001.json'));
  assert.equal(fake.calls.length,16);
  assert.ok((await fs.readdir(output)).some(name=>name.endsWith('.tmp')));
});

test('SIGKILL after second link preserves earlier commit; destination is never resumed',{timeout:10000},async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t),script=await watchPreload(dir,'after-link');
  const c=watchChild(t,watchArgs(output),env(script,fake.url));await c.message(m=>m.point==='after-link');
  c.p.kill('SIGKILL');const killed=await c.result;
  assert.equal(killed.signal,'SIGKILL');assert.equal(killed.stdout,'');
  await readSnapshot(join(output,'observation-001.json'));
  await readSnapshot(join(output,'observation-002.json'));
  const retry=await cli(watchArgs(output),{CONTRACT_WATCH_RPC_URL:fake.url});
  assert.equal(retry.code,1);assert.match(retry.stderr,/WATCH_EXISTS/);assert.equal(fake.calls.length,16);
});

for(const point of ['open','write','sync','close','link']) test(`ordinary second ${point} I/O failure cleans current and retains confirmed first`,async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t);
  const script=await watchPreload(dir,'none',2,`
let injected=false;
const faultOpen=fs.open;
fs.open=async(...a)=>{
  if(${JSON.stringify(point)}==='open'&&a[1]==='wx'&&writes===1&&!injected){injected=true;throw Error('PRIVATE_PATH');}
  const f=await faultOpen(...a);
  if(a[1]==='wx'&&writes===2){
    const method=({write:'writeFile',sync:'sync',close:'close'})[${JSON.stringify(point)}];
    if(method){const original=f[method].bind(f);f[method]=async(...b)=>{if(!injected){injected=true;throw Error('PRIVATE_PATH');}return original(...b);};}
  }
  return f;
};
const faultLink=fs.link;
fs.link=async(...a)=>{if(${JSON.stringify(point)}==='link'&&writes===2&&!injected){injected=true;throw Error('PRIVATE_PATH');}return faultLink(...a);};
`);
  const result=await cli(watchArgs(output),env(script,fake.url));
  assert.equal(result.code,1);assert.equal(result.stderr,'');
  const report=JSON.parse(result.stdout);
  assert.equal(report.saved,1);assert.equal(report.failed,1);assert.equal(report.outcomes[1].error.code,'FILE_WRITE');
  assert.deepEqual(await fs.readdir(output),['observation-001.json']);assert.equal(fake.calls.length,16);
});

test('retained handle close failure stops the session with a safe global error',async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t);
  const script=await watchPreload(dir,'none',2,`
const failPinOpen=fs.open;
fs.open=async(...a)=>{
  const f=await failPinOpen(...a);
  if(typeof a[1]==='number'&&String(a[0]).includes('.observation-002.'))f.close=async()=>{throw Error('PRIVATE_HANDLE');};
  return f;
};
`);
  const result=await cli(watchArgs(output),env(script,fake.url));
  assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(result.stderr,cleanup);
  await readSnapshot(join(output,'observation-001.json'));assert.equal(fake.calls.length,16);
});

for(const signal of ['SIGINT','SIGTERM']) test(`signal after the last observation commit suppresses JSON but preserves it: ${signal}`,{timeout:10000},async t=>{
  const dir=await temporaryDirectory(t),output=join(dir,'session'),fake=await fakeRpc(t),script=await watchPreload(dir,'report',1);
  const argv=watchArgs(output);argv[argv.indexOf('--count')+1]='1';
  const c=watchChild(t,argv,env(script,fake.url));await c.message(m=>m.point==='report');
  await stop(c,signal,true);
  assert.deepEqual(await fs.readdir(output),['observation-001.json']);await readSnapshot(join(output,'observation-001.json'));
  assert.equal(fake.calls.length,8);
});
