import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import http from 'node:http';
import { runLive } from '../src/cancellation.js';
import { OwnedOutputs } from '../src/owned-outputs.js';
import { createCapturePolicy } from '../src/capture-policy.js';
import { createRpc } from '../src/rpc.js';
import { captureMany } from '../src/batch.js';
import { runReady } from '../src/scheduler.js';
import { saveSnapshot, SLOTS } from '../src/snapshot.js';
import { ADDRESS, HASH, EMPTY, IMPLEMENTATION, word, fixture, fakeRpc, temporaryDirectory, protocolResult, ROOT, CLI, cli } from './helpers/fake-rpc.js';

const cancelled = 'Error [CAPTURE_CANCELLED]: Capture cancelled; owned output was removed.\n';
const cleanup = 'Error [CANCEL_CLEANUP]: Capture cancelled; output cleanup was incomplete. Inspect the destination before reuse.\n';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function absent(path) { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }); }
function host() {
  const h = new EventEmitter(); h.out = ''; h.err = '';
  h.stdout = { write: value => { h.out += value; } }; h.stderr = { write: value => { h.err += value; } };
  return h;
}
async function config(t, count = 3, chains = false) {
  const dir = await temporaryDirectory(t), configPath = join(dir, 'PRIVATE_CONFIG.json');
  const targets = Array.from({ length: count }, (_, index) => ({ name: `private-${index}`, address: ADDRESS,
    chainId: chains ? String(index + 1) : '1', rpcEnv: `PRIVATE_RPC_${index}` }));
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, targets }));
  return { dir, configPath, targets, output: join(dir, 'PRIVATE_OUTPUT') };
}
function args(paths, many = true, extra = []) {
  return many ? ['snapshot-many', '--config', paths.configPath, ...paths.targets.flatMap(t => ['--target', t.name]), '--out-dir', paths.output, ...extra]
    : ['snapshot', '--address', ADDRESS, '--chain-id', '1', '--out', paths.output, ...extra];
}

// IPC gates make signals occur at the actual native operation boundary. No
// production test switches and no sleeps used to guess when an operation starts.
async function preload(paths, point) {
  const path = join(paths.dir, `gate-${point}.mjs`);
  await fs.writeFile(path, `
import fs from 'node:fs/promises';
import timers from 'node:timers/promises';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
const point=${JSON.stringify(point)};
let gated=false;
async function gate(name) {
  if(point!==name||gated)return;
  gated=true;
  await new Promise(resolve=>{process.once('message',resolve);process.send({point:name});});
}
const on=process.on;
process.on=function(name,fn){
  if(name==='SIGINT'||name==='SIGTERM')return on.call(this,name,(...a)=>{fn(...a);process.send({signal:name});});
  return on.call(this,name,fn);
};
const immediate=timers.setImmediate;
timers.setImmediate=async(...a)=>{await gate('before-request');return immediate(...a);};
const sleep=timers.setTimeout;
timers.setTimeout=(ms,...a)=>{if(point==='backoff'||point==='rate-limit')process.send({point,ms});return sleep(ms,...a);};
const open=fs.open;
fs.open=async(...a)=>{
  const f=await open(...a);
  if(a[1]==='wx'){
    await gate('open');
    const write=f.writeFile.bind(f),sync=f.sync.bind(f),close=f.close.bind(f);
    f.writeFile=async(text,opts)=>{
      if(point==='write'){await write(text.slice(0,100),opts);await gate('write');}
      return write(text,opts);
    };
    f.sync=async()=>{await gate('before-sync');const r=await sync();await gate('after-sync');return r;};
    f.close=async()=>{await gate('close');return close();};
  }
  return f;
};
const link=fs.link;
fs.link=async(...a)=>{await gate('before-link');const r=await link(...a);await gate('after-link');return r;};
const unlink=fs.unlink;
fs.unlink=async(...a)=>{if(String(a[0]).endsWith('.tmp'))await gate('temp-cleanup');return unlink(...a);};
const mkdir=fs.mkdir;
fs.mkdir=async(...a)=>{const r=await mkdir(...a);await gate('mkdir');return r;};
syncBuiltinESMExports();
`);
  return path;
}
function child(t, argv, env = {}) {
  const p = spawn(process.execPath, [CLI, ...argv], { cwd: ROOT, env: { ...process.env, CONTRACT_WATCH_RPC_URL: '', ...env }, stdio: ['ignore','pipe','pipe','ipc'] });
  let stdout = '', stderr = ''; const messages = [], waiting = [];
  p.stdout.on('data', b => { stdout += b; }); p.stderr.on('data', b => { stderr += b; });
  p.on('message', m => { messages.push(m); for (const wake of waiting.splice(0)) wake(); });
  const result = new Promise((resolve, reject) => { p.once('error', reject); p.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  t.after(() => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); });
  const message = async predicate => {
    for (;;) {
      const i = messages.findIndex(predicate);
      if (i !== -1) return messages.splice(i, 1)[0];
      await new Promise(resolve => waiting.push(resolve));
    }
  };
  return { p, result, message };
}
async function interrupt(c, signal, release = false, repeated = false) {
  c.p.kill(signal);
  await c.message(m => m.signal === signal);
  if (repeated) {
    const next = signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT';
    c.p.kill(next); await c.message(m => m.signal === next);
  }
  if (release) c.p.send('release');
  const result = await c.result;
  assert.deepEqual(result, { code: signal === 'SIGINT' ? 130 : 143, signal: null, stdout: '', stderr: cancelled });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  for (const point of ['before-request', 'headers', 'body', 'backoff', 'rate-limit']) {
    test(`real CLI ${signal}: ${point}, no retry or late output`, { timeout: 10000 }, async t => {
      const paths = await config(t); let active = 0;
      const hit = deferred();
      const fake = await fakeRpc(t, (r, res) => {
        active++; res.once('close', () => { active--; });
        if (point === 'body') { res.writeHead(200); res.write('{"jsonrpc":"2.0",'); }
        if (point === 'backoff' || point === 'rate-limit') { res.writeHead(point === 'backoff' ? 503 : 429, { 'Retry-After': '30' }); res.end('PRIVATE_PROVIDER'); }
        hit.resolve();
      });
      const script = await preload(paths, point);
      const c = child(t, args(paths, false, ['--retries','3','--deadline-ms','60000']), { CONTRACT_WATCH_RPC_URL: fake.url,
        NODE_OPTIONS: `--import=${pathToFileURL(script).href}` });
      if (['headers','body'].includes(point)) await hit.promise;
      else await c.message(m => m.point === point);
      await interrupt(c, signal, point === 'before-request');
      await turn(); assert.equal(active, 0); assert.equal(fake.calls.length, point === 'before-request' ? 0 : 1);
      await absent(paths.output);
    });
  }
  for (const many of [false, true]) for (const point of ['open', 'write', 'before-sync', 'after-sync', 'before-link', 'after-link', 'temp-cleanup', 'close', ...(many ? ['mkdir'] : [])]) {
    test(`real CLI ${signal}: ${many ? 'batch' : 'single'} ${point}, repeated signals drain then roll back`, { timeout: 10000 }, async t => {
      const paths = await config(t), fake = await fakeRpc(t), script = await preload(paths, point);
      const c = child(t, args(paths, many), { CONTRACT_WATCH_RPC_URL: fake.url,
        ...Object.fromEntries(paths.targets.map(t => [t.rpcEnv, fake.url])), NODE_OPTIONS: `--import=${pathToFileURL(script).href}` });
      await c.message(m => m.point === point);
      await interrupt(c, signal, true, true);
      await absent(paths.output);
      const files = await fs.readdir(paths.dir);
      assert.equal(files.some(name => name.endsWith('.tmp')), false);
      assert.equal(fake.calls.length, point === 'mkdir' ? 0 : 8);
    });
  }
}

for (const concurrency of [1,2,8]) for (const sharedBlock of [false,true]) {
  test(`queued env stays unread and all active requests drain: ${concurrency}, shared ${sharedBlock}`, { timeout: 10000 }, async t => {
    const paths = await config(t, 12), h = host(), entered = deferred();
    let active = 0, max = 0, envReads = 0, requests = 0;
    const fake = await fakeRpc(t, (r, res) => {
      active++; requests++; max = Math.max(max, active); res.once('close', () => { active--; });
      if (active === (sharedBlock ? 1 : concurrency)) entered.resolve();
    });
    const env = Object.fromEntries(paths.targets.map(target => [target.rpcEnv, fake.url]));
    const environment = new Proxy(env, { get(t, k) { envReads++; return t[k]; } });
    let signal;
    const result = runLive(async operation => {
      signal = operation.signal;
      const report = await captureMany({ configPath: paths.configPath, names: paths.targets.map(t => t.name), outputDir: paths.output,
        concurrency, sharedBlock }, environment, operation);
      return { stdout: JSON.stringify(report) };
    }, h);
    await entered.promise; h.emit('SIGINT'); await result; await turn();
    assert.equal(h.out, ''); assert.equal(h.err, cancelled); assert.equal(h.exitCode, 130);
    assert.equal(envReads, sharedBlock ? 1 : concurrency); assert.equal(requests, envReads); assert.equal(max, envReads); assert.equal(active, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    assert.equal(h.listenerCount('SIGINT') + h.listenerCount('SIGTERM'), 0);
    await absent(paths.output);
  });
}

for (const shared of [false,true]) for (const concurrency of [1,2,8]) {
  test(`CLI interrupt after earlier saved file, shared=${shared}, concurrency=${concurrency}`, { timeout: 10000 }, async t => {
    const paths = await config(t, 12), script = await preload(paths, 'none');
    const first = await fakeRpc(t), entered = deferred(); let active = 0;
    const later = await fakeRpc(t, (r, res) => {
      active++; res.once('close', () => { active--; });
      // Wait for proof of the earlier published file, without releasing this RPC.
      entered.resolve();
    });
    const env = Object.fromEntries(paths.targets.map((target, i) => [target.rpcEnv, i ? later.url : first.url]));
    // Gate link of first output so the parent has a deterministic saved-file event.
    await fs.appendFile(script, `\nconst publish=fs.link;fs.link=async(...a)=>{const r=await publish(...a);if(String(a[1]).endsWith('/target-01.json'))process.send({point:'saved'});return r;};syncBuiltinESMExports();\n`);
    const c = child(t, args(paths, true, ['--concurrency',String(concurrency),...(shared ? ['--shared-block'] : [])]), { ...env, NODE_OPTIONS: `--import=${pathToFileURL(script).href}` });
    await c.message(m => m.point === 'saved'); await entered.promise;
    assert.equal((await fs.stat(join(paths.output, 'target-01.json'))).isFile(), true);
    await interrupt(c, 'SIGTERM'); await turn(); assert.equal(active, 0);
    await absent(paths.output); assert.ok(later.calls.length <= concurrency);
  });
}

test('scheduler abort between admission and work prevents all env/work, removes listener', async () => {
  const controller = new AbortController(); let calls = 0;
  const pending = runReady(32, 8, () => true, () => { calls++; }, controller.signal);
  controller.abort(Error('PRIVATE_REASON'));
  await assert.rejects(pending, { code: 'CAPTURE_CANCELLED' });
  assert.equal(calls, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation wins the live outcome when deadline and transport fail together', async t => {
  const h = host(), controller = new AbortController(); let now = 0, calls = 0;
  const policy = createCapturePolicy({ retries: 3, deadlineMs: 100 }, { now: () => now, signal: controller.signal });
  const pending = policy.read(async () => { calls++; now = 100; controller.abort('PRIVATE_REASON'); throw Error('PRIVATE'); }, 10000, () => true);
  await assert.rejects(pending, { code: 'CAPTURE_DEADLINE' }); assert.equal(calls, 1);
  await runLive(async operation => { h.emit('SIGINT'); h.emit('SIGTERM'); operation.check(); }, h);
  assert.equal(h.err, cancelled); assert.equal(h.out, ''); assert.equal(h.exitCode, 130);
});

for (const mode of ['beacon','implementation','genesis','final-chain']) {
  test(`shared cancellation reaches ${mode} reads without replacing anchor`, { timeout: 10000 }, async t => {
    const paths = await config(t, 3), h = host(), hit = deferred(); let chains = 0;
    const fake = await fakeRpc(t, (r, res) => {
      if (r.method === 'eth_chainId') chains++;
      if ((mode === 'beacon' && r.method === 'eth_call') ||
          (mode === 'implementation' && r.method === 'eth_getCode' && r.params[0] === IMPLEMENTATION) ||
          (mode === 'genesis' && r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0') ||
          (mode === 'final-chain' && r.method === 'eth_chainId' && chains === 3)) { hit.resolve(); return; }
      if (r.method === 'eth_getStorageAt' && mode === 'beacon') return { result: r.params[1] === SLOTS.beacon ? word(IMPLEMENTATION) : EMPTY };
      return { result: protocolResult(r) };
    });
    const pending = runLive(async operation => ({ stdout: JSON.stringify(await captureMany({ configPath: paths.configPath,
      names: paths.targets.map(t => t.name), outputDir: paths.output, sharedBlock: true,
      includeBeacon: mode === 'beacon', includeImplementation: mode === 'implementation', options: { genesis: mode === 'genesis' } },
    Object.fromEntries(paths.targets.map(t => [t.rpcEnv, fake.url])), operation)) }), h);
    await hit.promise; const count = fake.calls.length; h.emit('SIGTERM'); await pending;
    assert.equal(fake.calls.length, count); assert.equal(h.err, cancelled); await absent(paths.output);
  });
}

for (const replacement of ['file', 'symlink', 'modified', 'directory', 'added', 'unlink-failure', 'stat-failure']) {
  test(`rollback preserves foreign output: ${replacement}`, async t => {
    const paths = await config(t), h = host();
    const foreign = join(paths.dir, 'foreign'); await fs.writeFile(foreign, 'PRIVATE_KEEP');
    let originalUnlink, originalStat;
    const { syncBuiltinESMExports } = await import('node:module');
    try {
      await runLive(async operation => {
        const directory = await operation.outputs.mkdir(paths.output), output = join(directory, 'saved.json');
        await saveSnapshot(output, fixture(), operation.outputs);
        if (replacement === 'file' || replacement === 'symlink') {
          await fs.unlink(output);
          if (replacement === 'file') await fs.writeFile(output, 'PRIVATE_KEEP'); else await fs.symlink(foreign, output);
        }
        if (replacement === 'modified') await fs.writeFile(output, 'PRIVATE_KEEP');
        if (replacement === 'directory') { await fs.rename(directory, `${directory}-moved`); await fs.mkdir(directory); await fs.writeFile(output, 'PRIVATE_KEEP'); }
        if (replacement === 'added') await fs.writeFile(join(directory, 'user-added'), 'PRIVATE_KEEP');
        if (replacement === 'unlink-failure') { originalUnlink = fs.unlink; fs.unlink = async () => { throw Error('PRIVATE_PATH'); }; syncBuiltinESMExports(); }
        if (replacement === 'stat-failure') { originalStat = fs.lstat; fs.lstat = async () => { throw Error('PRIVATE_PATH'); }; syncBuiltinESMExports(); }
        h.emit('SIGINT'); operation.check();
      }, h);
    } finally {
      if (originalUnlink) fs.unlink = originalUnlink;
      if (originalStat) fs.lstat = originalStat;
      syncBuiltinESMExports();
    }
    assert.equal(h.out, ''); assert.equal(h.err, cleanup); assert.equal(h.exitCode, 130);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'PRIVATE_KEEP');
    if (['file','symlink','modified','directory'].includes(replacement)) assert.equal(await fs.readFile(join(paths.output, 'saved.json'), 'utf8'), 'PRIVATE_KEEP');
    if (replacement === 'added') { await absent(join(paths.output, 'saved.json')); assert.equal(await fs.readFile(join(paths.output, 'user-added'), 'utf8'), 'PRIVATE_KEEP'); }
  });
}

test('substituted batch directory cannot receive queued writes through a symlink', async t => {
  const paths = await config(t), controller = new AbortController(), outputs = new OwnedOutputs(controller.signal);
  await outputs.mkdir(paths.output);
  const foreign = join(paths.dir, 'foreign'); await fs.mkdir(foreign);
  await fs.rename(paths.output, `${paths.output}-moved`); await fs.symlink(foreign, paths.output);
  await assert.rejects(saveSnapshot(join(paths.output, 'saved.json'), fixture(), outputs), { code: 'FILE_WRITE' });
  controller.abort(); assert.equal(await outputs.rollback(), false); assert.deepEqual(await fs.readdir(foreign), []);
});

test('commit precedes stdout; a signal during/after delivery cannot roll back committed files', async t => {
  const dir = await temporaryDirectory(t), path = join(dir, 'saved.json'), h = host();
  h.stdout.write = value => { h.out += value; h.emit('SIGINT'); h.emit('SIGTERM'); };
  await runLive(async operation => { await saveSnapshot(path, fixture(), operation.outputs); return { stdout: 'complete\n' }; }, h);
  assert.equal(h.out, 'complete\n'); assert.equal(h.err, ''); assert.equal(h.exitCode, 0);
  assert.equal(h.listenerCount('SIGINT') + h.listenerCount('SIGTERM'), 0);
  assert.equal(JSON.parse(await fs.readFile(path)).schemaVersion, 1);
});

for (const flags of [[], ['--implementation-code'], ['--genesis']]) {
  test(`live success still supports offline inspect/diff/migrate ${flags}`, async t => {
    const paths = await config(t), fake = await fakeRpc(t, r => ({ result: r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0' ? { number: '0x0', hash: HASH } : protocolResult(r) }));
    const result = await cli(args(paths, false, flags), { CONTRACT_WATCH_RPC_URL: fake.url });
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.equal((await cli(['inspect', paths.output])).code, 0);
    assert.equal((await cli(['diff', '--json', paths.output, paths.output])).code, 0);
    if (!flags.includes('--genesis')) assert.equal((await cli(['migrate', paths.output, '--to-version','4','--out',join(paths.dir,'v4.json')])).code, 0);
    assert.equal((await fs.stat(paths.output)).mode & 0o777, 0o600);
  });
}

for (const phase of ['before-send', 'headers', 'body', 'wait']) {
  test(`request and abort listeners close once: ${phase}`, { timeout: 10000 }, async t => {
    const controller = new AbortController(), hit = deferred();
    let opened = 0, closed = 0;
    const request = http.request;
    t.mock.method(http, 'request', (...args) => {
      const req = request(...args); opened++;
      req.once('close', () => { closed++; }); return req;
    });
    const fake = await fakeRpc(t, (r, res) => {
      if (phase === 'body') res.write('{');
      if (phase === 'wait') { res.writeHead(429, { 'Retry-After': '30' }); res.end(); }
      if (phase !== 'wait') hit.resolve();
    });
    const timers = await import('node:timers/promises');
    const policy = createCapturePolicy({ retries: 3, deadlineMs: 60000 }, { signal: controller.signal,
      sleep: (ms, signal) => { const pending = timers.setTimeout(ms, undefined, { signal }); hit.resolve(); return pending; } });
    if (phase === 'before-send') controller.abort('PRIVATE_REASON');
    const pending = assert.rejects(createRpc(fake.url, 10000, policy)('eth_chainId'), { code: 'RETRY_CANCELLED' });
    if (phase !== 'before-send') { await hit.promise; controller.abort('PRIVATE_REASON'); }
    await pending;
    assert.equal(opened, phase === 'before-send' ? 0 : 1); assert.equal(closed, opened);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

for (const fault of ['write', 'sync', 'close', 'link']) {
  test(`ordinary ${fault} failure remains per-target; successful output stays`, { timeout: 10000 }, async t => {
    const paths = await config(t), fake = await fakeRpc(t), script = join(paths.dir, `fault-${fault}.mjs`);
    await fs.writeFile(script, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const open=fs.open,link=fs.link;
const fail=()=>{throw Object.assign(Error('PRIVATE_FAILURE'),{code:'EIO'});};
fs.open=async(...a)=>{const f=await open(...a);if(a[1]==='wx'&&String(a[0]).includes('target-02.json')){
  const method=${JSON.stringify(fault === 'write' ? 'writeFile' : fault)};
  if(method!=='link'){const original=f[method].bind(f);f[method]=async(...args)=>{if(method==='close')await original(...args);fail();};}
}return f;};
fs.link=async(...a)=>{if(${JSON.stringify(fault)}==='link'&&String(a[1]).endsWith('/target-02.json'))fail();return link(...a);};syncBuiltinESMExports();`);
    const result = await cli(args(paths), { ...Object.fromEntries(paths.targets.map(t => [t.rpcEnv, fake.url])), NODE_OPTIONS: `--import=${pathToFileURL(script).href}` });
    assert.equal(result.code, 1); assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.outcomes.map(o => o.status), ['saved', 'failed', 'saved']);
    assert.equal(report.outcomes[1].error.code, 'FILE_WRITE');
    assert.deepEqual(await fs.readdir(paths.output), ['target-01.json','target-03.json']);
  });
}

test('a no-overwrite collision is never journaled as owned or deleted on cancellation', async t => {
  const paths = await config(t), h = host();
  await runLive(async operation => {
    const dir = await operation.outputs.mkdir(paths.output), foreign = join(dir, 'saved.json');
    await fs.writeFile(foreign, 'PRIVATE_KEEP');
    await assert.rejects(saveSnapshot(foreign, fixture(), operation.outputs), { code: 'FILE_EXISTS' });
    h.emit('SIGTERM'); operation.check();
  }, h);
  assert.equal(h.err, cleanup); assert.equal(h.exitCode, 143);
  assert.deepEqual(await fs.readdir(paths.output), ['saved.json']);
  assert.equal(await fs.readFile(join(paths.output,'saved.json'), 'utf8'), 'PRIVATE_KEEP');
});

test('cancelled single config read never reads the selected env or makes RPC', async t => {
  const paths = await config(t), script = await preload(paths, 'none'), fake = await fakeRpc(t);
  await fs.appendFile(script, `const original=fs.open;fs.open=async(...a)=>{const f=await original(...a);if(String(a[0]).endsWith('PRIVATE_CONFIG.json'))await new Promise(resolve=>{process.once('message',resolve);process.send({point:'config'});});return f;};
process.env=new Proxy(process.env,{get(t,k){if(String(k).startsWith('PRIVATE_RPC_'))throw Error('PRIVATE_ENV_READ');return Reflect.get(t,k);}});syncBuiltinESMExports();`);
  const c = child(t, ['snapshot','--config',paths.configPath,'--target',paths.targets[0].name,'--out',paths.output], {
    ...Object.fromEntries(paths.targets.map(t => [t.rpcEnv, fake.url])), NODE_OPTIONS: `--import=${pathToFileURL(script).href}` });
  await c.message(m => m.point === 'config'); await interrupt(c,'SIGINT',true);
  assert.equal(fake.calls.length,0); await absent(paths.output);
});

test('a retained handle close failure cannot report normal completion', async t => {
  const dir = await temporaryDirectory(t), h = host(); let close, file;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = fs.open;
  fs.open = async (...args) => {
    const opened = await original(...args);
    if (typeof args[1] === 'number') { file = opened; close = file.close.bind(file); file.close = async () => { throw Error('PRIVATE_CLOSE'); }; }
    return opened;
  };
  syncBuiltinESMExports();
  try {
    await runLive(async operation => { await saveSnapshot(join(dir, 'saved.json'), fixture(), operation.outputs); return { stdout: 'should not print' }; }, h);
  } finally {
    fs.open = original; syncBuiltinESMExports(); if (close) await close();
  }
  assert.equal(h.out,''); assert.equal(h.exitCode,1); assert.match(h.err,/^Error \[FILE_WRITE\]:/);
  assert.equal(h.err.includes('PRIVATE'),false);
});

for (const signal of ['SIGINT','SIGTERM']) {
  test(`real ${signal} after completion preserves committed files`, { timeout: 10000 }, async t => {
    const paths = await config(t), fake = await fakeRpc(t), script = join(paths.dir,'after-completion.mjs');
    await fs.writeFile(script, `const write=process.stdout.write.bind(process.stdout);process.stdout.write=(...a)=>{const result=write(...a);setImmediate(()=>{process.once('message',()=>{});process.send({point:'complete'});});return result;};`);
    const c = child(t, args(paths,false), { CONTRACT_WATCH_RPC_URL:fake.url, NODE_OPTIONS:`--import=${pathToFileURL(script).href}` });
    await c.message(m=>m.point==='complete'); c.p.kill(signal);
    const result=await c.result;
    assert.equal(result.signal,signal); assert.equal(result.stderr,''); assert.match(result.stdout,/Snapshot saved/);
    assert.equal(JSON.parse(await fs.readFile(paths.output)).schemaVersion,1);
  });
}

test('rollback continues past a substituted file to remove other owned outputs', async t => {
  const paths = await config(t), h = host();
  await runLive(async operation => {
    const dir=await operation.outputs.mkdir(paths.output);
    for (const name of ['one.json','two.json','three.json']) await saveSnapshot(join(dir,name),fixture(),operation.outputs);
    await fs.unlink(join(dir,'two.json')); await fs.writeFile(join(dir,'two.json'),'PRIVATE_KEEP');
    h.emit('SIGTERM'); operation.check();
  },h);
  assert.equal(h.err,cleanup); assert.deepEqual(await fs.readdir(paths.output),['two.json']);
  assert.equal(await fs.readFile(join(paths.output,'two.json'),'utf8'),'PRIVATE_KEEP');
});
