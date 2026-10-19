import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { pruneHistory } from '../src/retention.js';
import { historyOperation } from '../src/history.js';
import { fixture, cli, CLI, ROOT } from './helpers/fake-rpc.js';
import { store, next, json, hash, snapshotName, stageName, tree, preserved } from './helpers/history-fixture.js';

const args = (p, token) => ['history', 'prune', '--dir', p.directory, '--keep-last', '1', '--apply', token, '--out-dir', p.output];
const preview = p => pruneHistory({ directory: p.directory, keepLast: '1' });
const verify = directory => historyOperation({ operation: 'verify', directory });
const values = () => [fixture(), next(fixture()), next(fixture(), 2)];
function failure(result, codes) {
  assert.equal(result.code, 1, result.stderr); assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(`^Error \\[(${codes})\\]: [^\\n]+\\n$`));
  assert.doesNotMatch(result.stderr, /PRIVATE|https?:|\.json|at .*\.js|\u001b/);
}
async function script(p, text) {
  const path = join(p.parent, 'fault.mjs'); await fs.writeFile(path, text);
  return path;
}
const env = path => ({ NODE_OPTIONS: `--import=${pathToFileURL(path).href}` });
function child(t, p, token, script) {
  const process = spawn(globalThis.process.execPath, [CLI, ...args(p, token)], {
    cwd: ROOT, env: { ...globalThis.process.env, ...env(script) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let stdout = '', stderr = ''; process.stdout.on('data', b => { stdout += b; }); process.stderr.on('data', b => { stderr += b; });
  let ready;
  const reached = new Promise(resolve => { ready = resolve; });
  process.once('message', ready);
  const result = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => { ready(false); resolve({ code, signal, stdout, stderr }); });
  });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  return { process, reached, result };
}

async function faultScript(p, kind, phase, stop = false, effect = '') {
  return script(p, `
    import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const output=${JSON.stringify(p.output)}, source=${JSON.stringify(p.directory)}, kind=${JSON.stringify(kind)}, phase=${JSON.stringify(phase)};
    let used=false; const types=new Map();
    const classify=text=>text.includes('contract-watch-history-entry')?'entry':text.includes('contract-watch-history')?'header':'snapshot';
    async function point(k,at){if(used||k!==kind||at!==phase)return;used=true;
      ${effect || (stop ? "await new Promise(resolve=>{process.once('message',resolve);process.send('ready')});" : "throw Error('https://PRIVATE_IO')")}
    }
    const open=fs.open, link=fs.link, unlink=fs.unlink;
    fs.open=async(path,...args)=>{const file=await open(path,...args);if(String(path).startsWith(output+'/')&&args[0]==='wx'){
      let type;const write=file.writeFile.bind(file),sync=file.sync.bind(file),close=file.close.bind(file);
      file.writeFile=async bytes=>{type=classify(bytes.toString());types.set(String(path),type);if(phase==='write'&&type===kind){await write(bytes.subarray(0,10));await point(type,'write')};await write(bytes)};
      file.sync=async()=>{await point(type,'sync');await sync()};
      file.close=async()=>{await close();await point(type,'close')};
    }return file};
    fs.link=async(from,to)=>{if(!String(to).startsWith(output+'/'))return link(from,to);const type=String(to).endsWith('/index.json')?'header':String(to).includes('/entry-')?'entry':'snapshot';await point(type,'link');await link(from,to);await point(type,'after-link')};
    fs.unlink=async path=>{if(String(path).startsWith(output+'/'))await point(types.get(String(path)),'cleanup');return unlink(path)};
    syncBuiltinESMExports();
  `);
}

for (const kind of ['snapshot', 'entry', 'header']) for (const phase of ['write', 'sync', 'close', 'link', 'after-link', 'cleanup']) test(`retention ${kind}/${phase} I/O failure preserves source and supports fresh-destination retry`, async t => {
  const p = await store(t, values()), plan = await preview(p), guard = await faultScript(p, kind, phase);
  await preserved(p.directory, async () => {
    failure(await cli(args(p, plan.planId), env(guard)), 'RETENTION_WRITE');
    const partial = await tree(p.output);
    failure(await cli(args(p, plan.planId)), 'HISTORY_EXISTS');
    assert.deepEqual(await tree(p.output), partial);
    const retry = { ...p, output: join(p.parent, 'retry') };
    assert.equal((await cli(args(retry, plan.planId))).code, 0); assert.equal((await verify(retry.output)).committed, 2);
  });
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) for (const [kind, phase] of [['snapshot', 'write'], ['entry', 'after-link'], ['header', 'sync'], ['header', 'link'], ['header', 'after-link']]) test(`real ${signal} at ${kind}/${phase} leaves only a complete header-committed copy readable`, { timeout: 15000 }, async t => {
  const p = await store(t, values()), plan = await preview(p), guard = await faultScript(p, kind, phase, true);
  await preserved(p.directory, async () => {
    const c = child(t, p, plan.planId, guard); assert.equal(await c.reached, 'ready'); c.process.kill(signal);
    const result = await c.result; assert.equal(result.signal, signal); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    if (kind === 'header' && phase === 'after-link') {
      const state = await verify(p.output); assert.equal(state.committed, 2); assert.ok(state.staged > 0);
    } else await assert.rejects(verify(p.output), { code: 'HISTORY_CORRUPT' });
    const before = await tree(p.output); failure(await cli(args(p, plan.planId)), 'HISTORY_EXISTS'); assert.deepEqual(await tree(p.output), before);
    const retry = { ...p, output: join(p.parent, 'retry') }; assert.equal((await cli(args(retry, plan.planId))).code, 0);
  });
});

test('concurrent source add during copy invalidates plan, preserves the new observation and leaves no committed copy', { timeout: 15000 }, async t => {
  const p = await store(t, values()), plan = await preview(p), guard = await faultScript(p, 'entry', 'after-link', true);
  const c = child(t, p, plan.planId, guard); assert.equal(await c.reached, 'ready');
  const extra = next(fixture(), 3), source = join(p.parent, 'new.json'); await fs.writeFile(source, json(extra));
  await historyOperation({ operation: 'add', directory: p.directory, input: source });
  const afterAdd = await tree(p.directory); c.process.send('continue'); failure(await c.result, 'HISTORY_CHANGED');
  assert.deepEqual(await tree(p.directory), afterAdd); assert.equal((await verify(p.directory)).committed, 4);
  await assert.rejects(fs.lstat(join(p.output, 'index.json')), { code: 'ENOENT' });
  failure(await cli(args({ ...p, output: join(p.parent, 'retry') }, plan.planId)), 'RETENTION_PLAN');
});

test('source mutation at header publication is detected after commit without partial stdout', async t => {
  const p = await store(t, values()), plan = await preview(p);
  const guard = await faultScript(p, 'header', 'link', false, `await fs.writeFile(source+'/${stageName(2)}','PRIVATE concurrent data');`);
  failure(await cli(args(p, plan.planId), env(guard)), 'HISTORY_CHANGED');
  assert.equal((await verify(p.output)).committed, 2);
  assert.equal(await fs.readFile(join(p.directory, stageName(2)), 'utf8'), 'PRIVATE concurrent data');
});

test('concurrent apply calls cannot reuse or overwrite the same destination', async t => {
  const p = await store(t, values()), plan = await preview(p);
  await preserved(p.directory, async () => {
    const result = await Promise.all([cli(args(p, plan.planId)), cli(args(p, plan.planId))]);
    assert.deepEqual(result.map(r => r.code).sort(), [0, 1]); failure(result.find(r => r.code === 1), 'HISTORY_EXISTS');
    assert.equal((await verify(p.output)).committed, 2);
  });
});

test('destination modification during the final source scan fails without overwriting the changed file', async t => {
  const p = await store(t, values()), plan = await preview(p);
  const guard = await script(p, `
    import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const open=fs.open;let headers=0;
    fs.open=async(path,...args)=>{
      if(String(path)===${JSON.stringify(join(p.directory, 'index.json'))} && ++headers===5)
        await fs.appendFile(${JSON.stringify(join(p.output, 'entry-0002.json'))},' ');
      return open(path,...args)
    };syncBuiltinESMExports();
  `);
  await preserved(p.directory, async () => failure(await cli(args(p, plan.planId), env(guard)), 'HISTORY_CHANGED'));
  assert.equal((await fs.readFile(join(p.output, 'entry-0002.json'), 'utf8')).at(-1), ' ');
  assert.equal((await verify(p.output)).committed, 2);
});

for (const mutation of ['foreign-file', 'foreign-stage', 'destination-swap', 'parent-swap', 'source-swap', 'snapshot-replace']) test(`apply detects ${mutation} without deleting foreign data`, async t => {
  const p = await store(t, values()), plan = await preview(p);
  const effect = mutation === 'foreign-file' ? `await fs.writeFile(output+'/PRIVATE_foreign','keep');`
    : mutation === 'foreign-stage' ? `await fs.writeFile(output+'/${stageName(9)}','keep');`
    : mutation === 'destination-swap' ? `await fs.rename(output,output+'-old');await fs.mkdir(output);await fs.writeFile(output+'/PRIVATE_foreign','keep');`
    : mutation === 'parent-swap' ? `await fs.rename(${JSON.stringify(p.parent)},${JSON.stringify(p.parent + '-old')});await fs.mkdir(${JSON.stringify(p.parent)});await fs.mkdir(output);await fs.writeFile(output+'/PRIVATE_foreign','keep');`
    : mutation === 'source-swap' ? `await fs.rename(source,source+'-old');await fs.mkdir(source);await fs.writeFile(source+'/PRIVATE_foreign','keep');`
    : `await fs.writeFile(source+'/${snapshotName(fixture())}','PRIVATE replaced');`;
  const guard = await faultScript(p, 'entry', 'after-link', false, effect);
  if (mutation === 'parent-swap') t.after(() => fs.rm(p.parent + '-old', { recursive: true, force: true }));
  failure(await cli(args(p, plan.planId), env(guard)), 'HISTORY_CHANGED|HISTORY_CORRUPT|HISTORY_DIRECTORY|RETENTION_WRITE');
  if (mutation === 'foreign-stage') assert.equal(await fs.readFile(join(p.output, stageName(9)), 'utf8'), 'keep');
  else if (mutation === 'source-swap') assert.equal(await fs.readFile(join(p.directory, 'PRIVATE_foreign'), 'utf8'), 'keep');
  else if (mutation === 'snapshot-replace') assert.equal(await fs.readFile(join(p.directory, snapshotName(fixture())), 'utf8'), 'PRIVATE replaced');
  else assert.equal(await fs.readFile(join(p.output, 'PRIVATE_foreign'), 'utf8'), 'keep');
});

for (const boundary of ['open', 'read', 'close']) test(`source ${boundary} error is fixed and empty stdout`, async t => {
  const p = await store(t, values());
  const guard = await script(p, `
    import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const open=fs.open;
    fs.open=async(path,...args)=>{if(String(path).includes('/snapshot-')&&${JSON.stringify(boundary)}==='open')throw Error('https://PRIVATE');
      const file=await open(path,...args);if(String(path).includes('/snapshot-')){
        if(${JSON.stringify(boundary)}==='read')file.read=async()=>{throw Error('PRIVATE')};
        if(${JSON.stringify(boundary)}==='close'){const close=file.close.bind(file);file.close=async()=>{await close();throw Error('PRIVATE')}};
      }return file};syncBuiltinESMExports();
  `);
  failure(await cli(['history', 'prune', '--dir', p.directory, '--keep-last', '1'], env(guard)), 'HISTORY_CORRUPT');
});

test('opaque stage fingerprint reads stop at the original byte limit when stat lies', async t => {
  const p = await store(t, values(), { stages: [''] });
  const guard = await script(p, `
    import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const open=fs.open;let consumed=0;
    fs.open=async(path,...args)=>{const file=await open(path,...args);if(String(path)===${JSON.stringify(join(p.directory, stageName(0)))}){
      file.read=async(buffer,offset,length)=>{if(buffer.length!==768*1024+1||consumed+length>768*1024+1)process.exit(91);
        buffer.fill(32,offset,offset+length);consumed+=length;return {bytesRead:length}};
    }return file};process.on('exit',()=>{if(consumed!==768*1024+1)process.exitCode=92});syncBuiltinESMExports();
  `);
  await preserved(p.directory, async () => failure(await cli(['history', 'prune', '--dir', p.directory, '--keep-last', '1'], env(guard)), 'HISTORY_CORRUPT'));
});

for (const boundary of ['mkdir', 'root-close']) test(`destination ${boundary} failure preserves source with safe empty stdout`, async t => {
  const p = await store(t, values()), plan = await preview(p);
  const guard = await script(p, `
    import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdir,open=fs.open;
    fs.mkdir=async(path,...args)=>{if(String(path)===${JSON.stringify(p.output)}&&${JSON.stringify(boundary)}==='mkdir')throw Error('https://PRIVATE');return mkdir(path,...args)};
    fs.open=async(path,...args)=>{const file=await open(path,...args);if(String(path)===${JSON.stringify(p.output)}&&${JSON.stringify(boundary)}==='root-close'){
      const close=file.close.bind(file);file.close=async()=>{await close();throw Error('PRIVATE')};
    }return file};syncBuiltinESMExports();
  `);
  await preserved(p.directory, async () => failure(await cli(args(p, plan.planId), env(guard)), boundary === 'mkdir' ? 'RETENTION_DESTINATION' : 'RETENTION_WRITE'));
});

test('dry-run performs no writes; dry-run/apply ignore network, environment, config and live signal lifecycle', async t => {
  const p = await store(t, values()), plan = await preview(p);
  for (const applying of [false, true]) {
    const guard = await script(p, `
      import fs from 'node:fs/promises';import http from 'node:http';import https from 'node:https';import net from 'node:net';
      import {constants} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';const output=${JSON.stringify(p.output)}, source=${JSON.stringify(p.directory)};
      const denied=()=>{throw Error('PRIVATE forbidden')};
      for(const key of ['mkdir','writeFile','appendFile','unlink','rename','link','chmod','utimes','copyFile']){
        const original=fs[key];fs[key]=async(...args)=>{
          if(!${applying} || args.slice(0,key==='link'||key==='rename'?2:1).some(path=>!String(path).startsWith(output)))denied();
          return original(...args)
        };
      }
      fs.rm=fs.rmdir=denied;const open=fs.open;
      fs.open=async(path,flags,...args)=>{const writing=typeof flags==='string'||Boolean(flags&(constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC|constants.O_APPEND));if(writing&&(!${applying}||!String(path).startsWith(output+'/')))denied();return open(path,flags,...args)};
      const read=fs.readFile;fs.readFile=(path,...args)=>{if(/config|targets|\\.env/.test(String(path)))denied();return read(path,...args)};
      http.request=http.get=https.request=https.get=net.connect=net.createConnection=globalThis.fetch=denied;
      process.env=new Proxy(process.env,{get(target,key){if(/RPC|CONTRACT_WATCH|PRIVATE/.test(String(key)))denied();return target[key]}});
      const on=process.on;process.on=function(event,...args){if(['SIGINT','SIGTERM'].includes(event))denied();return on.call(this,event,...args)};
      syncBuiltinESMExports();
    `);
    await preserved(p.directory, async () => {
      const result = await cli(applying ? args(p, plan.planId) : ['history', 'prune', '--dir', p.directory, '--keep-last', '1'], env(guard));
      assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    });
  }
});

async function rechain(directory, mutate) {
  const path = join(directory, 'index.json'), header = JSON.parse(await fs.readFile(path)); mutate(header);
  let bytes = json(header); await fs.writeFile(path, bytes); let previous = hash(bytes);
  for (const name of (await fs.readdir(directory)).filter(n => n.startsWith('entry-')).sort()) {
    const path = join(directory, name), entry = JSON.parse(await fs.readFile(path)); entry.previous = previous;
    bytes = json(entry); await fs.writeFile(path, bytes); previous = hash(bytes);
  }
}
for (const mutation of ['unknown-field', 'missing-retention', 'bad-baseline', 'bad-recent', 'bad-count', 'bad-policy', 'bad-token', 'bad-digest', 'missing-prefix', 'v1-extra']) test(`history v2 rejects invalid retention provenance: ${mutation}`, async t => {
  const p = await store(t, values()), plan = await preview(p); assert.equal((await cli(args(p, plan.planId))).code, 0);
  await rechain(p.output, header => {
    if (mutation === 'unknown-field') header.retention.PRIVATE = true;
    if (mutation === 'missing-retention') delete header.retention;
    if (mutation === 'bad-baseline') header.retention.ordinals[0] = 2;
    if (mutation === 'bad-recent') header.retention.ordinals[1] = 2;
    if (mutation === 'bad-count') header.retention.sourceCommitted = 129;
    if (mutation === 'bad-policy') header.retention.keepLast = 0.5;
    if (mutation === 'bad-token') header.retention.planId = 'https://PRIVATE';
    if (mutation === 'bad-digest') header.retention.observationsSha256 = '0'.repeat(64);
    if (mutation === 'v1-extra') header.schemaVersion = 1;
  });
  if (mutation === 'missing-prefix') await fs.unlink(join(p.output, 'entry-0002.json'));
  await preserved(p.output, async () => {
    for (const command of [['verify'], ['timeline', '--json'], ['prune', '--keep-last', '1']]) failure(await cli(['history', ...command, '--dir', p.output]), 'HISTORY_CORRUPT');
  });
});
