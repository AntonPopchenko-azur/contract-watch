import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { runReady } from '../src/scheduler.js';
import { captureMany } from '../src/batch.js';
import { readSnapshot, SLOTS } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, protocolResult, ADDRESS, HASH, EMPTY, word, CLI, ROOT } from './helpers/fake-rpc.js';

const GENESIS = `0x${'c1'.repeat(32)}`, OTHER = `0x${'d2'.repeat(32)}`;
const CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const BEACON = '0x3333333333333333333333333333333333333333', IMPL = '0x4444444444444444444444444444444444444444';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const entry = (i, extra = {}) => ({ name: `private-${i}`, address: ADDRESS, chainId: '1', rpcEnv: `PRIVATE_RPC_${i}`, ...extra });
async function setup(t, entries = [entry(1), entry(2), entry(3)]) {
  const dir = await temporaryDirectory(t), configPath = join(dir, 'PRIVATE_CONFIG.json'), outputDir = join(dir, 'PRIVATE_BATCH');
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, targets: entries }));
  return { dir, configPath, outputDir, names: entries.map(e => e.name) };
}
const args = p => ['snapshot-many', '--config', p.configPath, ...p.names.flatMap(n => ['--target', n]), '--out-dir', p.outputDir];
function safe(value) { assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /PRIVATE_|private-|https?:|rpcEnv|\n\s+at\s/); }
function report(result, saved, failed, shared = false) {
  assert.equal(result.code, failed ? 1 : 0, result.stderr); assert.equal(result.stderr, ''); safe(result.stdout);
  const value = JSON.parse(result.stdout); assert.equal(value.schemaVersion, shared ? 2 : 1); assert.equal(value.saved, saved); assert.equal(value.failed, failed);
  assert.deepEqual(Object.keys(value), shared ? ['kind','schemaVersion','mode','groups','selected','saved','failed','outcomes'] : ['kind','schemaVersion','selected','saved','failed','outcomes']);
  assert.deepEqual(value.outcomes.map(o => o.ordinal), Array.from({ length: saved + failed }, (_, i) => i + 1));
  return value;
}
function trackRequests(t, limit) {
  const original = http.request; const state = { active: 0, peak: 0, opened: 0, closed: 0, exceeded: false };
  http.request = (...args) => {
    const req = original(...args); state.active++; state.opened++; state.peak = Math.max(state.peak, state.active);
    if (state.active > limit) state.exceeded = true;
    req.once('close', () => { state.active--; state.closed++; }); return req;
  };
  t.after(() => { http.request = original; });
  return state;
}
function drained(state, peak) { assert.equal(state.exceeded, false); assert.equal(state.active, 0); assert.equal(state.opened, state.closed); if (peak) assert.equal(state.peak, peak); }

// No time-based ordering: explicit barriers control readiness, failures and drain.
test('ready queue skips dependencies, wakes on anchor resolution, preserves FIFO readiness and drains errors', async t => {
  const release = deferred(), second = deferred(), started = [], finished = []; let available = false;
  const running = runReady(4, 2, i => i !== 1 || available, async (i, wake) => {
    started.push(i);
    if (i === 0) { await release.promise; available = true; wake(); }
    if (i === 2) await second.promise;
    finished.push(i);
  });
  await Promise.resolve(); assert.deepEqual(started, [0, 2]); release.resolve();
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(started, [0, 2, 1, 3]);
  second.resolve(); await running; assert.deepEqual(finished, [0, 1, 3, 2]);

  for (const kind of ['work rejects', 'readiness throws']) await t.test(kind, async () => {
    const gate = deferred(), began = [], complete = []; let rejectReady = false, settled = false;
    const job = runReady(4, 2, () => { if (rejectReady) throw Error('PRIVATE_READY'); return true; }, async (i, wake) => {
      began.push(i);
      if (i === 0) { if (kind === 'work rejects') throw Error('PRIVATE_WORK'); rejectReady = true; wake(); }
      if (i === 1) await gate.promise;
      complete.push(i);
    });
    const checked = assert.rejects(job, { code: 'INTERNAL' }).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(began, [0, 1]); assert.equal(settled, false);
    gate.resolve(); await checked; assert.ok(complete.includes(1)); assert.deepEqual(began, [0, 1]);
  });
});

test('actual active HTTP requests stay within 1/2/8 for 1/32 targets on the same endpoint, independent and shared', async t => {
  for (const sharedBlock of [false, true]) for (const concurrency of [1, 2, 8]) for (const count of [1, 32]) await t.test(`${sharedBlock}/${concurrency}/${count}`, async t => {
    const paths = await setup(t, Array.from({ length: count }, (_, i) => entry(i + 1, { address: `0x${(i + 1).toString(16).padStart(40, '0')}` })));
    const state = trackRequests(t, concurrency), gate = deferred(); let arrived = 0;
    const fake = await fakeRpc(t, async r => {
      if (r.method === 'eth_getCode' && arrived < Math.min(concurrency, count)) {
        arrived++; if (arrived === Math.min(concurrency, count)) gate.resolve(); await gate.promise;
      }
      return { result: protocolResult(r) };
    });
    t.after(() => gate.resolve());
    const value = await captureMany({ ...paths, sharedBlock, concurrency }, Object.fromEntries(Array.from({ length: count }, (_, i) => [`PRIVATE_RPC_${i + 1}`, fake.url])));
    assert.equal(value.saved, count); assert.equal(value.failed, 0); drained(state, Math.min(concurrency, count));
    assert.equal(fake.calls.length, sharedBlock ? 2 + 9 * count : 8 * count);
    assert.deepEqual(value.outcomes.map(o => o.ordinal), Array.from({ length: count }, (_, i) => i + 1));
    for (const o of value.outcomes) { const path = join(paths.outputDir, o.file); const snapshot = await readSnapshot(path); assert.deepEqual(snapshot.block, { number: '0x64', hash: HASH }); assert.equal((await fs.stat(path)).mode & 0o777, 0o600); }
    assert.equal((await fs.stat(paths.outputDir)).mode & 0o777, 0o700); safe(value);
  });
});

test('reverse publication never changes report order and final stdout waits for every started capture/save', async t => {
  const paths = await setup(t); const gates = [deferred(), deferred(), deferred()], reached = [deferred(), deferred(), deferred()];
  t.after(() => gates.forEach(g => g.resolve()));
  const fake = await fakeRpc(t, async (r, res, req) => {
    const i = Number(req.url.slice(1)) - 1;
    if (r.id === 8) { reached[i].resolve(); await gates[i].promise; }
    return { result: protocolResult(r) };
  });
  const child = spawn(process.execPath, [CLI, ...args(paths), '--concurrency', '8'], { cwd: ROOT, env: { ...process.env, ...Object.fromEntries([1,2,3].map(i => [`PRIVATE_RPC_${i}`, `${fake.url}/${i}`])) }, stdio: ['ignore','pipe','pipe'] });
  t.after(() => child.kill()); let stdout = '', stderr = '';
  child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const done = new Promise((resolve,reject) => { child.on('error',reject); child.on('close',resolve); });
  // Filesystem events are hints; test the actual atomic destination after each.
  const watching = new AbortController();
  const events = fs.watch(paths.dir, { recursive: true, signal: watching.signal }); t.after(() => watching.abort());
  async function published(name) {
    for (;;) {
      try { await readSnapshot(join(paths.outputDir,name)); return; } catch {}
      await Promise.race([events.next(), done.then(() => { throw Error('Child ended before publication'); })]);
    }
  }
  await Promise.race([Promise.all(reached.map(g => g.promise)), done.then(() => { throw Error('Child ended before barriers'); })]);
  for (const i of [2,1]) { gates[i].resolve(); await published(`target-0${i + 1}.json`); assert.equal(stdout, ''); assert.equal(stderr, ''); }
  assert.deepEqual(await fs.readdir(paths.outputDir), ['target-02.json','target-03.json']);
  gates[0].resolve(); report({ code: await done, stdout, stderr }, 3, 0);
  assert.equal(fake.calls.length,24);
});

test('mixed shared groups skip waiting followers without starvation, resolve leaders once and block failed groups without env', async t => {
  const entries = [entry(1),entry(2),entry(3,{chainId:'2'}),entry(4,{chainId:'0x01'}),entry(5,{chainId:'0x02'}),entry(6,{chainId:'3'}),entry(7,{chainId:'0x03'}),entry(8)];
  const paths = await setup(t, entries), state = trackRequests(t,2), slow = deferred(), otherStarted = deferred(); let resolutions = 0;
  const traffic = [], envReads = [];
  const fake = await fakeRpc(t, async (r,res,req) => {
    const i = Number(req.url.slice(1)); traffic.push([i,r]);
    if (i === 1 && r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') { resolutions++; await slow.promise; }
    if (i === 3) otherStarted.resolve();
    if (i === 6) return { error: { code: -32000, message:'PRIVATE_PROVIDER' } };
    if (r.method === 'eth_chainId') return { result: i === 3 || i === 5 ? '0x2' : '0x1' };
    return { result: protocolResult(r) };
  });
  t.after(() => slow.resolve());
  const env = new Proxy(Object.fromEntries(entries.map((e,i) => [e.rpcEnv, `${fake.url}/${i+1}`])), { get(o,k) { envReads.push(k); assert.notEqual(k,'PRIVATE_RPC_7'); return Reflect.get(o,k); } });
  const running = captureMany({ ...paths, sharedBlock:true, concurrency:2 }, env);
  await otherStarted.promise; assert.deepEqual(envReads.slice(0,2), ['PRIVATE_RPC_1','PRIVATE_RPC_3']);
  slow.resolve(); const value = await running; drained(state,2);
  assert.equal(resolutions,1); assert.equal(value.saved,6); assert.equal(value.failed,2);
  assert.deepEqual(value.groups.map(g => [g.chainId,g.leaderOrdinal,g.status]), [['1',1,'resolved'],['2',3,'resolved'],['3',6,'unavailable']]);
  assert.deepEqual(value.outcomes.map(o => o.error?.code ?? o.status), ['saved','saved','saved','saved','saved','RPC_REMOTE','SHARED_BLOCK_UNAVAILABLE','saved']);
  assert.equal(envReads.length,7); assert.equal(new Set(envReads).size,7);
  assert.equal(traffic.filter(([i,r]) => r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest').length,2);
  assert.equal(fake.calls.length,2*2+6*9+1); safe(value);
});

async function guard(dir) {
  const path=join(dir,'guard.mjs');
  await fs.writeFile(path, `import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';let calls=0;const no=()=>{calls++;throw Error('PRIVATE_FORBIDDEN');};process.env=new Proxy(process.env,{get(t,k){if(k==='CONTRACT_WATCH_RPC_URL'||String(k).startsWith('PRIVATE_RPC_'))return no();return Reflect.get(t,k);}});http.request=no;https.request=no;fs.mkdir=no;syncBuiltinESMExports();process.on('exit',()=>assert.equal(calls,0));`);
  return { NODE_OPTIONS:`--import=${pathToFileURL(path).href}` };
}
test('concurrency syntax, duplicates, wrong commands and config options fail before env/FS/RPC', async t => {
  const p=await setup(t), env=await guard(p.dir);
  const invalid = ['0','9','32','01','+2','-2','2.0','2e0','0x2',' 2','2 ','Infinity','NaN','２'];
  for (const value of invalid) { const r=await cli([...args(p),'--concurrency',value],env); assert.equal(r.code,1);assert.equal(r.stdout,'');assert.match(r.stderr,/^Error \[CONCURRENCY\]:/);safe(r.stderr); }
  for (const command of [
    [...args(p),'--concurrency'],[...args(p),'--concurrency',''],[...args(p),'--concurrency','2','--concurrency','2'],[...args(p),'--concurrency=2'],
    [...args(p),'--concurrency','2','--shared-block','--shared-block'], [...args(p),'--concurrency','2','--resolve-beacon','--implementation-code'],
    ['snapshot','--address',ADDRESS,'--chain-id','1','--out','x','--concurrency','2'], ['inspect','x','--concurrency','2'],['diff','x','y','--concurrency','2'],['migrate','x','--to-version','3','--out','y','--concurrency','2']
  ]) { const r=await cli(command,env);assert.equal(r.code,1);assert.equal(r.stdout,'');assert.match(r.stderr,/^Error \[USAGE\]:/); }
  await fs.writeFile(p.configPath,JSON.stringify({schemaVersion:1,targets:[entry(1),entry(2),entry(3,{concurrency:2})]}));
  const bad=await cli([...args({...p,names:['private-1']}),'--concurrency','8'],env);assert.equal(bad.code,1);assert.match(bad.stderr,/^Error \[CONFIG\]:/);
  await fs.writeFile(p.configPath,JSON.stringify({schemaVersion:1,targets:[entry(1),entry(2,{address:CHECKSUM.toLowerCase()})]}));
  const checksum=await cli([...args({...p,names:['private-1','private-2']}),'--concurrency','8','--strict-checksum'],env);assert.equal(checksum.code,1);assert.match(checksum.stderr,/^Error \[ADDRESS_CHECKSUM\]:/);
  assert.deepEqual(await fs.readdir(p.dir),['PRIVATE_CONFIG.json','guard.mjs']);
  for(const concurrency of [0,9,NaN,Infinity,1.5,'2',null]) await assert.rejects(captureMany({...p,concurrency}),{code:'CONCURRENCY'});
});

function modeResult(r, mode, chain = '0x1') {
  if (r.method === 'eth_chainId') return chain;
  if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0') return { number:'0x0', hash:GENESIS };
  if (r.method === 'eth_getCode' && mode === 'skip') return '0x';
  if (r.method === 'eth_getStorageAt') return ['beacon','live'].includes(mode)
    ? r.params[1] === SLOTS.beacon ? word(BEACON) : EMPTY
    : r.params[1] === SLOTS.implementation ? word(IMPL) : EMPTY;
  if (r.method === 'eth_call') return word(IMPL);
  return protocolResult(r);
}
test('default/explicit one preserve traces and report bytes; concurrent selectors/features preserve each target protocol and budgets', async t => {
  const selections = [{},{block:'safe'},{block:'finalized'},{block:'100'},{blockHash:HASH},{depth:'0'},{depth:'1'}];
  for (const sharedBlock of [false,true]) for (const genesis of [false,true]) for (const mode of ['plain','direct','beacon','skip','live']) for (const selection of selections) await t.test(`${sharedBlock}/${genesis}/${mode}/${JSON.stringify(selection)}`, async t => {
    const paths=await setup(t,[1,2,3].map(i=>entry(i,{address:CHECKSUM}))), traffic=[];
    const state=trackRequests(t,3);
    const fake=await fakeRpc(t,async(r,res,req)=>{
      traffic.push([req.url,r]); await new Promise(resolve=>setImmediate(resolve));
      if(selection.depth==='1'&&r.method==='eth_getBlockByNumber'&&r.params[0]==='latest')return{result:{number:'0x65',hash:OTHER}};
      return {result:modeResult(r,mode)};
    });
    const env=Object.fromEntries([1,2,3].map(i=>[`PRIVATE_RPC_${i}`,`${fake.url}/${i}`]));
    const options={...selection,genesis,strictChecksum:true}; const reports=[],traces=[],saved=[];
    for(const concurrency of [undefined,1,3]){
      const outputDir=join(paths.dir,`out-${concurrency??'default'}`), start=traffic.length;
      reports.push(await captureMany({...paths,outputDir,options,sharedBlock,...(concurrency===undefined?{}:{concurrency}),includeBeacon:mode==='live',includeImplementation:['direct','beacon','skip'].includes(mode)},env));
      traces.push(traffic.slice(start));
      saved.push(await Promise.all([1,2,3].map(async i=>{const snapshot=await readSnapshot(join(outputDir,`target-0${i}.json`));delete snapshot.capturedAt;return snapshot;})));
    }
    assert.equal(reports[0].saved,3);assert.equal(reports[0].failed,0);assert.equal(JSON.stringify(reports[1]),JSON.stringify(reports[0]));assert.equal(JSON.stringify(reports[2]),JSON.stringify(reports[0]));
    assert.deepEqual(traces[0],traces[1]);for(const i of [1,2,3])assert.deepEqual(traces[0].filter(([path])=>path===`/${i}`),traces[2].filter(([path])=>path===`/${i}`));
    assert.deepEqual(saved[0],saved[1]);assert.deepEqual(saved[0],saved[2]);
    const s=selection.blockHash||selection.depth==='1'?1:0, extra=({plain:0,direct:1,beacon:2,skip:0,live:1})[mode];
    const budget=sharedBlock?(2+Number(genesis)+s)+3*(9+2*Number(genesis)+extra):3*(8+s+2*Number(genesis)+extra);
    assert.equal(traces[0].length,budget);assert.equal(traces[2].length,budget);drained(state);
    for(const[,r]of traffic.filter(([,r])=>['eth_getCode','eth_getStorageAt','eth_call'].includes(r.method)))assert.deepEqual(r.params.at(-1),{blockHash:HASH,requireCanonical:true});
  });
});

test('timeout, abort, HTTP/body and beacon errors close resources before queued targets replace a worker', async t => {
  for(const sharedBlock of [false,true])for(const fault of ['timeout','body timeout','body abort','client abort','malformed','http','oversize','beacon timeout'])await t.test(`${sharedBlock}/${fault}`,async t=>{
    const paths=await setup(t,Array.from({length:5},(_,i)=>entry(i+1,{chainId:String(i+1)}))), state=trackRequests(t,2);
    if(fault==='client abort'){
      const tracked=http.request;let first=true;
      http.request=(...args)=>{const req=tracked(...args);if(first){first=false;queueMicrotask(()=>req.destroy(Error('PRIVATE_ABORT')));}return req;};
    }
    const mode=fault==='beacon timeout'?'beacon':'plain';
    const fake=await fakeRpc(t,(r,res,req)=>{
      const i=Number(req.url.slice(1));
      if(i===1&&(fault==='beacon timeout'?r.method==='eth_call':r.id===1)&&fault!=='client abort'){
        if(fault==='timeout'||fault==='beacon timeout')return;
        if(fault==='body timeout'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
        if(fault==='body abort'){res.writeHead(200,{'content-type':'application/json','content-length':'5000'});res.write('{');setImmediate(()=>res.destroy());return;}
        if(fault==='malformed'){res.end('PRIVATE_INVALID_JSON');return;}
        if(fault==='http'){res.writeHead(503);res.end('PRIVATE_PROVIDER');return;}
        if(fault==='oversize'){res.writeHead(200,{'content-length':String(1024*1024+1)});res.write('x');return;}
      }
      return{result:modeResult(r,mode,`0x${i.toString(16)}`)};
    });
    const value=await captureMany({...paths,concurrency:2,sharedBlock,includeImplementation:mode==='beacon',options:{timeoutMs:100}},Object.fromEntries([1,2,3,4,5].map(i=>[`PRIVATE_RPC_${i}`,`${fake.url}/${i}`])));
    assert.equal(value.saved,4);assert.equal(value.failed,1);assert.equal(value.outcomes[0].error.code,({'timeout':'RPC_TIMEOUT','body timeout':'RPC_TIMEOUT','body abort':'RPC_NETWORK','client abort':'RPC_NETWORK','malformed':'RPC_ENVELOPE','http':'RPC_HTTP','oversize':'RPC_SIZE','beacon timeout':'RPC_TIMEOUT'})[fault]);
    drained(state);assert.equal(state.opened,(sharedBlock?4*(mode==='beacon'?13:11):4*(mode==='beacon'?10:8))+(fault==='beacon timeout'?(sharedBlock?10:7):1));
    assert.deepEqual(await fs.readdir(paths.outputDir),['target-02.json','target-03.json','target-04.json','target-05.json']);safe(value);
  });
});

test('concurrent golden v1/v2 fixtures remain unchanged and failed writes do not cancel other targets',async t=>{
  for(const sharedBlock of [false,true]){
    const entries=sharedBlock?[entry(1),entry(2,{chainId:'2'}),entry(3),entry(4,{chainId:'0x02'})]:[entry(1),entry(2)];
    const paths=await setup(t,entries);const fake=await fakeRpc(t,r=>({result:r.method==='eth_chainId'&&sharedBlock?'0x2':protocolResult(r)}));
    const env=sharedBlock?{PRIVATE_RPC_2:fake.url,PRIVATE_RPC_4:fake.url}:{PRIVATE_RPC_1:fake.url};
    const value=report(await cli([...args(paths),'--concurrency','8',...(sharedBlock?['--shared-block']:[])],env),sharedBlock?2:1,sharedBlock?2:1,sharedBlock);
    assert.deepEqual(value,JSON.parse(await fs.readFile(new URL(`./fixtures/batch/${sharedBlock?'shared-mixed':'mixed'}.json`,import.meta.url),'utf8')));
  }
  const paths=await setup(t),fake=await fakeRpc(t),keep=join(paths.dir,'keep');await fs.writeFile(keep,'PRIVATE_KEEP');
  const env=Object.fromEntries([1,2,3].map(i=>[`PRIVATE_RPC_${i}`,fake.url]));
  const race=await Promise.all([cli([...args(paths),'--concurrency','8'],env),cli([...args(paths),'--concurrency','8'],env)]);
  report(race.find(r=>r.code===0),3,0);assert.match(race.find(r=>r.code===1).stderr,/^Error \[BATCH_EXISTS\]:/);assert.equal(fake.calls.length,24);
  for(const fault of ['io','symlink']){
    const preload=join(paths.dir,`${fault}.mjs`),outputDir=join(paths.dir,fault);
    await fs.writeFile(preload,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const link=fs.link;fs.link=async(from,to)=>{if(to.endsWith('/target-02.json')){${fault==='io'?"const e=Error('PRIVATE_WRITE');e.code='EIO';throw e;":`await fs.symlink(${JSON.stringify(keep)},to);`}}return link(from,to);};syncBuiltinESMExports();`);
    const result=report(await cli([...args({...paths,outputDir}),'--concurrency','8','--shared-block'],{...env,NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`}),2,1,true);
    assert.equal(result.outcomes[1].error.code,fault==='io'?'FILE_WRITE':'FILE_EXISTS');assert.equal(result.groups[0].status,'resolved');
    for(const name of ['target-01.json','target-03.json'])await readSnapshot(join(outputDir,name));
    assert.ok(!(await fs.readdir(outputDir)).some(n=>n.endsWith('.tmp')));assert.equal(await fs.readFile(keep,'utf8'),'PRIVATE_KEEP');
  }
  assert.equal(fake.calls.length,24+2*29);
});
