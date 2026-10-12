import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { retryAfter, MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_LENGTH } from '../src/retry-after.js';
import { CAPTURE_POLICY, createCapturePolicy } from '../src/capture-policy.js';
import { createRpc } from '../src/rpc.js';
import { WatchError, errorDetails } from '../src/errors.js';
import { capture, captureWithBeacon, captureWithImplementation, readSnapshot, SLOTS } from '../src/snapshot.js';
import { captureMany } from '../src/batch.js';
import { fakeRpc, protocolResult, temporaryDirectory, cli, ADDRESS, HASH, EMPTY, IMPLEMENTATION, word } from './helpers/fake-rpc.js';

const WALL = Date.UTC(2026, 9, 12, 8), GENESIS = `0x${'c1'.repeat(32)}`, OTHER = `0x${'d2'.repeat(32)}`;
const BEACON = `0x${'33'.repeat(20)}`;
const header = value => value === undefined ? [] : ['Retry-After', value];
const date = ms => new Date(ms).toUTCString();
function fakeTime(options = { retries: 3, deadlineMs: 600000 }, hooks = {}) {
  let time = 0, wall = WALL; const waits = [];
  const runtime = { now: () => time, wallNow: () => wall + time, signal: hooks.signal,
    sleep: async (ms, signal) => { waits.push(ms); if (hooks.sleep) await hooks.sleep(ms, signal); else time += ms; } };
  return { policy: createCapturePolicy(options, runtime), waits, now: () => time,
    advance: ms => { time += ms; }, wall: value => { wall = value; } };
}
const safe = value => assert.doesNotMatch(JSON.stringify(value), /PRIVATE|https?:|retry-after|Retry-After|rpcEnv/);
function track(t, limit = 1) {
  const original = http.request, state = { active: 0, peak: 0, opened: 0, closed: 0 };
  t.mock.method(http, 'request', (...args) => {
    assert.ok(state.active < limit, 'transport from prior attempt is still active');
    const req = original(...args); state.active++; state.opened++; state.peak = Math.max(state.peak, state.active);
    req.once('close', () => { state.active--; state.closed++; }); return req;
  });
  return state;
}
function rateResponse(res, value) { res.writeHead(429, header(value)); res.end('PRIVATE_BODY'); }
async function setup(t, count = 3) {
  const dir = await temporaryDirectory(t), configPath = join(dir, 'config.json'), outputDir = join(dir, 'out');
  const targets = Array.from({ length: count }, (_, i) => ({ name: `target-${i + 1}`, address: ADDRESS, chainId: '1', rpcEnv: `PRIVATE_RPC_${i + 1}` }));
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, targets }));
  return { dir, configPath, outputDir, names: targets.map(t => t.name) };
}
const batchArgs = p => ['snapshot-many', '--config', p.configPath, ...p.names.flatMap(n => ['--target', n]), '--out-dir', p.outputDir];

test('Retry-After integer seconds: zero, leading zeros, OWS, cap, overflow and bounded input', () => {
  for (let seconds = 0; seconds <= 30; seconds++) assert.equal(retryAfter(header(String(seconds)), WALL), seconds * 1000);
  for (const value of ['00', '0000', '0'.repeat(MAX_RETRY_AFTER_LENGTH)]) assert.equal(retryAfter(header(value), WALL), 0);
  assert.equal(retryAfter(['rEtRy-AfTeR', '\t 00030 \t'], WALL), MAX_RETRY_AFTER_MS);
  for (const value of ['31', '999', '9007199254740993', '9'.repeat(128), '9'.repeat(100000), '0'.repeat(129), 'x'.repeat(129)]) {
    assert.equal(retryAfter(header(value), WALL), Infinity);
  }
  for (const value of [undefined, '', ' ', '\t', '-1', '+1', '1.5', '1e2', '0x10', 'Infinity', 'NaN', '１', '1 0', '1\t0', '"1"', '1;foo', 'PRIVATE']) {
    assert.equal(retryAfter(header(value), WALL), undefined);
  }
});

test('HTTP-date uses all three RFC formats and exact calendar/time/weekday validation', () => {
  for (const value of ['Mon, 12 Oct 2026 08:00:10 GMT', 'Monday, 12-Oct-26 08:00:10 GMT', 'Mon Oct 12 08:00:10 2026']) {
    assert.equal(retryAfter(header(value), WALL), 10000);
    assert.equal(retryAfter(header(value), WALL + 10000), 0);
    assert.equal(retryAfter(header(value), WALL + 11000), 0);
  }
  for (const value of ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) {
    assert.equal(retryAfter(header(value), WALL), 0);
  }
  assert.equal(retryAfter(header(date(WALL + 30000)), WALL), 30000);
  assert.equal(retryAfter(header(date(WALL + 31000)), WALL), Infinity);
  assert.equal(retryAfter(header(date(WALL + 31000)), WALL + 999), Infinity);
  assert.equal(retryAfter(header(date(WALL + 1000)), WALL + 250), 750);
  for (const value of ['Mon, 12 Oct 2026 08:00:10 UTC', 'Mon, 12 Oct 2026 08:00:10 +0000',
    'Tue, 12 Oct 2026 08:00:10 GMT', 'Mon, 12 Xxx 2026 08:00:10 GMT', 'Mon, 32 Oct 2026 08:00:10 GMT',
    'Mon, 12 Oct 2026 24:00:10 GMT', 'Mon, 12 Oct 2026 08:60:10 GMT', 'Mon, 12 Oct 2026 08:00:60 GMT',
    'Mon, 12 Oct 2026 08:00:61 GMT', 'Mon, 12 Oct 2026 08:00:10.5 GMT', 'mon, 12 Oct 2026 08:00:10 GMT',
    'Mon,  12 Oct 2026 08:00:10 GMT', 'Mon, 12 Oct 2026 08:00:10 GMT, Mon, 12 Oct 2026 08:00:20 GMT',
    'Mon, 12 Oct 2026 08:00:10 GMT\n', 'Thu, 29 Feb 2023 00:00:00 GMT']) assert.equal(retryAfter(header(value), WALL), Infinity);
  for (const value of ['2026-10-12T08:00:10Z', '10/12/2026', 'Mon Oct 32 08:00:10 2026', 'Mon Oct 12 24:00:10 2026']) {
    assert.equal(retryAfter(header(value), WALL), undefined);
  }
  const leap = Date.UTC(2024, 1, 29); assert.equal(retryAfter(header('Thu, 29 Feb 2024 00:00:00 GMT'), leap - 1000), 1000);
  const midnight = Date.UTC(2017, 0, 1);
  assert.equal(retryAfter(header('Sat, 31 Dec 2016 23:59:60 GMT'), midnight - 1000), 1000);
});

test('RFC850 two-digit year resolves across centuries and the precise 50-year boundary', () => {
  const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const oldDate = ms => { const d = new Date(ms); return `${names[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, '0')}-Oct-${String(d.getUTCFullYear() % 100).padStart(2, '0')} 08:00:00 GMT`; };
  assert.equal(retryAfter(header(oldDate(Date.UTC(2076, 9, 12, 8))), WALL), Infinity); // exactly +50 years
  assert.equal(retryAfter(header(oldDate(Date.UTC(1976, 9, 13, 8))), WALL), 0); // +50 years +1 day maps back
  assert.equal(retryAfter(header(oldDate(Date.UTC(2100, 9, 12, 8))), Date.UTC(2099, 9, 12, 8)), Infinity);
  assert.equal(retryAfter(header(oldDate(Date.UTC(2000, 9, 12, 8))), Date.UTC(1999, 9, 12, 8)), Infinity);
});

test('duplicates, combined values, invalid clock and oversized raw structures refuse safely', () => {
  for (const values of [['0','0'], ['0','31'], ['31','0'], ['PRIVATE','0'], ['', '1']]) {
    assert.equal(retryAfter(['Retry-After', values[0], 'retry-after', values[1]], WALL), Infinity);
  }
  for (const value of ['0, 0', '0, 31', '1,2', 'PRIVATE, PRIVATE']) assert.equal(retryAfter(header(value), WALL), Infinity);
  for (const raw of [null, {}, ['Retry-After'], ['Retry-After', 0], Array(8194).fill('')]) assert.equal(retryAfter(raw, WALL), Infinity);
  for (const wall of [NaN, Infinity, -Infinity]) assert.equal(retryAfter(header('1'), wall), Infinity);
});

test('zero retries never parse headers/read wall time/wait, with or without deadline', async () => {
  for (const options of [{}, { retries: 0 }, { retries: 0, deadlineMs: 100 }]) {
    const p = createCapturePolicy(options, { now: () => 0, wallNow: () => assert.fail('wall read'), sleep: () => assert.fail('sleep') });
    assert.equal(p.rateLimit(new Proxy([], { get() { assert.fail('header access'); } })), false);
    let attempts = 0;
    await assert.rejects(p.read(async () => { attempts++; throw new WatchError('RPC_HTTP'); }, 100, () => assert.fail('retry classification')), { code: 'RPC_HTTP' });
    assert.equal(attempts, 1);
  }
});

test('fake delays honor 429 minima, fallback, exhaustion and mixed-error attempt indices', async () => {
  for (const retries of [1, 2, 3]) for (const value of [undefined, '-1', '0', '2', '30', date(WALL + 3000)]) {
    const c = fakeTime({ retries, deadlineMs: 600000 }); let attempts = 0, decision;
    await assert.rejects(c.policy.read(async () => { attempts++; decision = c.policy.rateLimit(header(value)); throw new WatchError('RPC_HTTP'); }, 10000, () => decision), { code: 'RPC_HTTP' });
    const ms = value === '0' ? 0 : value === '2' ? 2000 : value === '30' ? 30000 : value?.includes('GMT') ? 3000 : undefined;
    // A fixed date is already reached after its first delay; delta-seconds recur.
    assert.deepEqual(c.waits, ms === undefined ? [100,200,400].slice(0,retries) : ms === 0 ? [] : value.includes('GMT') ? [ms] : Array(retries).fill(ms));
    assert.equal(attempts, retries + 1);
  }
  const c = fakeTime(); let attempts = 0, decision;
  const answer = await c.policy.read(async () => {
    attempts++;
    if (attempts === 4) return 'ok';
    decision = attempts === 2 ? c.policy.rateLimit(header('2')) : true;
    throw new WatchError(attempts === 3 ? 'RPC_NETWORK' : 'RPC_HTTP');
  }, 10000, () => decision);
  assert.equal(answer, 'ok'); assert.equal(attempts, 4); assert.deepEqual(c.waits, [100, 2000, 400]);
});

test('huge/excess-budget/equal-budget server minimum is refused without waiting or another attempt', async () => {
  for (const [value, deadlineMs] of [['31',600000], ['9'.repeat(128),600000], ['2',1000], ['1',1000], [date(WALL+1000),1000]]) {
    const c = fakeTime({ retries: 3, deadlineMs }); let attempts = 0, decision;
    await assert.rejects(c.policy.read(async () => { attempts++; decision = c.policy.rateLimit(header(value)); throw new WatchError('RPC_HTTP'); }, 10000, () => decision), { code: 'RPC_HTTP' });
    assert.equal(attempts, 1); assert.deepEqual(c.waits, []);
  }
  const c = fakeTime({ retries: 3, deadlineMs: 1000 }); let decision;
  await assert.rejects(c.policy.read(async () => { decision = c.policy.rateLimit(header('1')); c.advance(1000); throw new WatchError('RPC_HTTP'); }, 10000, () => decision), { code: 'CAPTURE_DEADLINE' });
});

test('early waking cannot shorten any minimum, and wall-clock changes do not move a scheduled wait', async () => {
  for (const value of ['1', date(WALL+1000), undefined]) {
    let wake = 0; const c = fakeTime(undefined, { sleep: async ms => { c.advance(++wake === 1 ? ms / 4 : ms); c.wall(WALL + 999999999); } });
    let attempts = 0, decision;
    await c.policy.read(async () => {
      if (++attempts === 2) { assert.equal(c.now(), value === undefined ? 100 : 1000); return 'ok'; }
      decision = c.policy.rateLimit(header(value)); throw new WatchError('RPC_HTTP');
    }, 10000, () => decision);
    assert.deepEqual(c.waits, value === undefined ? [100,75] : [1000,750]);
  }
});

test('fake deadline expires during early-waking fallback or delayed wake without further attempts', async () => {
  for (const value of [undefined, '1']) {
    let wake = 0; const c = fakeTime({ retries: 3, deadlineMs: value === undefined ? 150 : 1500 }, {
      sleep: async ms => { c.advance(++wake === 1 ? 20 : 2000); }
    });
    let attempts = 0, decision;
    await assert.rejects(c.policy.read(async () => { attempts++; c.advance(60); decision = c.policy.rateLimit(header(value)); throw new WatchError('RPC_HTTP'); }, 10000, () => decision), { code: 'CAPTURE_DEADLINE' });
    assert.equal(attempts, 1); assert.equal(c.waits.length, 2);
  }
});

test('fake sleep cancellation clears pending wait/listener and forbids further attempts; deadline has priority', async () => {
  for (const expired of [false, true]) {
    const controller = new AbortController(); let pending = 0, attempts = 0, decision, started;
    const ready = new Promise(resolve => { started = resolve; });
    const c = fakeTime({ retries: 3, deadlineMs: 5000 }, { signal: controller.signal, sleep: (ms, signal) => new Promise((resolve, reject) => {
      assert.equal(signal, controller.signal); pending++;
      const abort = () => { signal.removeEventListener('abort', abort); pending--; reject(new Error('PRIVATE_ABORT_REASON')); };
      signal.addEventListener('abort', abort, { once: true }); started();
    }) });
    const work = c.policy.read(async () => { attempts++; decision = c.policy.rateLimit(header('1')); throw new WatchError('RPC_HTTP'); }, 10000, () => decision);
    const checked = assert.rejects(work, error => { assert.equal(error.code, expired ? 'CAPTURE_DEADLINE' : 'RETRY_CANCELLED'); safe(errorDetails(error)); return true; });
    await ready; if (expired) c.advance(5000); controller.abort('PRIVATE_SIGNAL'); await checked;
    assert.equal(attempts, 1); assert.equal(pending, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(c.policy.read(() => assert.fail('new attempt'), 1000, () => true), { code: expired ? 'CAPTURE_DEADLINE' : 'RETRY_CANCELLED' });
  }
});

test('real transports close before fake waits/retries; IDs/params fixed; 503 ignores Retry-After as before', async t => {
  for (const kind of ['429-seconds', '429-date', '429-fallback', '503']) await t.test(kind, async t => {
    const state = track(t); let tries = 0;
    const c = fakeTime(undefined, { sleep: async ms => { assert.equal(state.active, 0); c.advance(ms); } });
    const fake = await fakeRpc(t, (r, res) => {
      if (++tries === 1) { res.writeHead(kind === '503' ? 503 : 429, header(kind === '429-date' ? date(WALL + 1000) : kind === '429-fallback' ? undefined : '1')); res.end('PRIVATE_BODY'); return; }
      return { result: protocolResult(r) };
    });
    const params = [ADDRESS, { blockHash: HASH, requireCanonical: true }];
    assert.equal(await createRpc(fake.url, 1000, c.policy)('eth_getCode', params), '0x60006000');
    assert.deepEqual(c.waits, [kind === '503' || kind === '429-fallback' ? 100 : 1000]);
    assert.deepEqual(fake.calls.map(r => r.id), [1,2]); assert.deepEqual(fake.calls.map(r => r.params), [params,params]);
    assert.equal(state.active, 0); assert.equal(state.opened, state.closed);
  });
});

test('real duplicate/huge headers cannot hide a long wait; zero/default stays one safe RPC_HTTP', async t => {
  for (const kind of ['duplicate', 'late-duplicate', 'long', 'oversize', 'default', 'zero']) await t.test(kind, async t => {
    const c = fakeTime(kind === 'default' ? {} : { retries: kind === 'zero' ? 0 : 3, deadlineMs: 10000 }), state = track(t);
    const fake = await fakeRpc(t, (r, res) => {
      const fields = kind === 'late-duplicate' ? ['Retry-After','0', ...Array.from({ length: 1100 }, () => ['x','']).flat(), 'Retry-After','31']
        : kind === 'duplicate' ? ['Retry-After','0','retry-after','31'] : header(kind === 'oversize' ? 'x'.repeat(17000) : kind === 'long' ? '9'.repeat(129) : '1');
      res.writeHead(429, fields); res.end('PRIVATE_BODY');
    });
    await assert.rejects(createRpc(fake.url, 1000, c.policy)('eth_chainId'), error => { assert.equal(error.code, kind === 'oversize' ? 'RPC_NETWORK' : 'RPC_HTTP'); safe(errorDetails(error)); return true; });
    assert.equal(fake.calls.length, 1); assert.deepEqual(c.waits, []); assert.equal(state.active, 0);
  });
});

test('429 wait cancellation with real RPC has already closed transport and cannot save a capture', async t => {
  const controller = new AbortController(), state = track(t); let started, pending = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const c = fakeTime(undefined, { signal: controller.signal, sleep: (ms, signal) => new Promise((resolve, reject) => {
    assert.equal(state.active, 0); pending++;
    const abort = () => { pending--; signal.removeEventListener('abort', abort); reject(Error('PRIVATE')); };
    signal.addEventListener('abort', abort, { once: true }); started();
  }) });
  const fake = await fakeRpc(t, (r, res) => rateResponse(res, '1'));
  const checked = assert.rejects(capture({ address: ADDRESS, chainId: '1', rpcUrl: fake.url, [CAPTURE_POLICY]: c.policy }), { code: 'RETRY_CANCELLED' });
  await ready; controller.abort(); await checked;
  assert.equal(pending, 0); assert.equal(state.active, 0); assert.equal(fake.calls.length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

function observation(r, beacon = false) {
  if (r.method === 'eth_getBlockByNumber') return { number: r.params[0].startsWith('0x') ? r.params[0] : '0x64', hash: r.params[0] === '0x0' ? GENESIS : HASH };
  if (r.method === 'eth_getStorageAt' && beacon) return r.params[1] === SLOTS.beacon ? word(BEACON) : EMPTY;
  if (r.method === 'eth_call') return word(IMPLEMENTATION);
  return protocolResult(r);
}

test('429 across selectors/genesis/beacon/implementation preserves pins and old strict snapshots', async t => {
  for (const selector of [{}, { block: 'safe' }, { block: 'finalized' }, { block: '100' }, { blockHash: HASH }, { depth: '0' }, { depth: '1' }]) {
    for (const mode of ['plain','live-beacon','implementation-direct','implementation-beacon']) await t.test(`${JSON.stringify(selector)}/${mode}`, async t => {
      const c = fakeTime(), seen = new Set(), beacon = mode.includes('beacon');
      const fake = await fakeRpc(t, (r, res) => {
        const key = JSON.stringify([r.method,r.params]);
        if (!seen.has(key)) { seen.add(key); rateResponse(res, '1'); return; }
        return { result: observation(r, beacon) };
      });
      const engine = mode.startsWith('implementation') ? captureWithImplementation : mode === 'live-beacon' ? captureWithBeacon : capture;
      const captured = await engine({ address: ADDRESS, chainId: '1', rpcUrl: fake.url, genesis: true, ...selector, [CAPTURE_POLICY]: c.policy });
      const snapshot = captured.snapshot ?? captured;
      assert.equal(snapshot.schemaVersion, 4); assert.equal(snapshot.genesis.hash, GENESIS); assert.equal(snapshot.block.hash, HASH);
      assert.deepEqual(fake.calls.map(r => r.id), Array.from({ length: fake.calls.length }, (_, i) => i + 1));
      assert.ok(fake.calls.filter(r => ['eth_getCode','eth_getStorageAt','eth_call'].includes(r.method)).every(r => r.params.at(-1).blockHash === HASH && r.params.at(-1).requireCanonical));
      assert.equal(c.waits.length, seen.size); assert.ok(c.waits.every(ms => ms === 1000));
      safe(snapshot);
    });
  }
});

test('reorg and changed genesis after recovered 429 still abort without re-pinning', async t => {
  for (const kind of ['reorg','genesis']) await t.test(kind, async t => {
    const c = fakeTime(); let code = 0, head = 0, genesis = 0;
    const fake = await fakeRpc(t, (r, res) => {
      if (r.method === 'eth_getCode' && ++code === 1) { rateResponse(res, '1'); return; }
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === 'latest') head++;
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x0' && ++genesis === 2 && kind === 'genesis') return { result: { number:'0x0',hash:OTHER } };
      if (r.method === 'eth_getBlockByNumber' && r.params[0] === '0x64' && kind === 'reorg') return { result: { number:'0x64',hash:OTHER } };
      return { result: observation(r) };
    });
    await assert.rejects(capture({ address:ADDRESS,chainId:'1',rpcUrl:fake.url,genesis:true,[CAPTURE_POLICY]:c.policy }), { code:kind === 'reorg' ? 'BLOCK_CHANGED' : 'GENESIS_CHANGED' });
    assert.equal(head, 1); assert.equal(code, 2); assert.deepEqual(c.waits,[1000]);
  });
});

test('CLI single/default and partial concurrent shared batch preserve output schemas and offline reuse', async t => {
  const paths = await setup(t), seen = new Set();
  const fake = await fakeRpc(t, (r,res,req) => {
    if (req.url === '/3') { rateResponse(res,'31'); return; }
    const key = JSON.stringify([req.url,r.method,r.params]);
    if (!seen.has(key)) { seen.add(key); rateResponse(res,'0'); return; }
    return { result:protocolResult(r) };
  });
  const single = await cli(['snapshot','--address',ADDRESS,'--chain-id','1','--rpc',`${fake.url}/single`,'--out',join(paths.dir,'single.json'),'--retries','1','--deadline-ms','5000']);
  assert.equal(single.code,0,single.stderr); assert.equal((await readSnapshot(join(paths.dir,'single.json'))).schemaVersion,1);
  for (const flags of [[],['--retries','0']]) {
    const failed = await cli(['snapshot','--address',ADDRESS,'--chain-id','1','--rpc',`${fake.url}/default-${flags.length}`,'--out',join(paths.dir,'absent.json'),...flags]);
    assert.equal(failed.code,1); assert.equal(failed.stdout,''); assert.match(failed.stderr,/RPC_HTTP/); safe(failed.stderr);
  }
  const value = await cli([...batchArgs(paths),'--shared-block','--concurrency','2','--retries','1','--deadline-ms','5000'],
    Object.fromEntries([1,2,3].map(i=>[`PRIVATE_RPC_${i}`,`${fake.url}/${i}`])));
  assert.equal(value.code,1); assert.equal(value.stderr,''); const report = JSON.parse(value.stdout); safe(report);
  assert.deepEqual(Object.keys(report),['kind','schemaVersion','mode','groups','selected','saved','failed','outcomes']);
  assert.equal(report.schemaVersion,2); assert.equal(report.groups[0].status,'resolved'); assert.equal(report.saved,2);
  assert.equal(report.outcomes[2].error.code,'RPC_HTTP'); assert.deepEqual(report.outcomes.map(o=>o.ordinal),[1,2,3]);
  assert.deepEqual((await fs.readdir(paths.outputDir)).sort(),['target-01.json','target-02.json']);
  const file=join(paths.outputDir,'target-01.json'); assert.equal((await cli(['inspect',file])).code,0);
  assert.equal((await cli(['diff','--json',file,file])).code,0);
  assert.equal((await cli(['migrate',file,'--to-version','4','--out',join(paths.dir,'migrated.json')])).code,0);
});

test('429 delays keep whole-capture concurrency 1/2/8, independent/shared jobs and ordered outcomes', async t => {
  for (const concurrency of [1,2,8]) for (const sharedBlock of [false,true]) await t.test(`${concurrency}/${sharedBlock}`, async t => {
    const paths = await setup(t,8), seen = new Set(), state = track(t,concurrency);
    const fake = await fakeRpc(t,(r,res,req)=>{
      if(r.method === 'eth_getCode' && !seen.has(req.url)){seen.add(req.url);rateResponse(res,undefined);return;}
      return {result:protocolResult(r)};
    });
    const report = await captureMany({...paths,concurrency,sharedBlock,options:{retries:1,deadlineMs:5000}},
      Object.fromEntries(Array.from({length:8},(_,i)=>[`PRIVATE_RPC_${i+1}`,`${fake.url}/${i+1}`])));
    assert.equal(report.saved,8);assert.equal(state.peak,concurrency);assert.equal(state.active,0);assert.equal(state.opened,state.closed);
    assert.equal(fake.calls.length,(sharedBlock?2+9*8:8*8)+8);assert.deepEqual(report.outcomes.map(o=>o.ordinal),[1,2,3,4,5,6,7,8]);
  });
});

test('shared leader budget spans 429 waits; followers get own budget and failed resolver reads no follower env', async t => {
  // Inject only clocks and sleep in the child, using Node built-ins; no real retry timers.
  for(const phase of ['resolver','capture']) await t.test(phase,async t=>{
    const paths=await setup(t,2), preload=join(paths.dir,'fake-clock.mjs');
    await fs.writeFile(preload,`import {performance} from 'node:perf_hooks';import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';let now=0;performance.now=()=>now;timers.setTimeout=async ms=>{now+=ms;};syncBuiltinESMExports();`);
    let first=true;const fake=await fakeRpc(t,(r,res,req)=>{
      if(req.url==='/1' && first && r.method==='eth_getBlockByNumber'){first=false;rateResponse(res,phase==='resolver'?'31':'1');return;}
      if(req.url==='/1' && r.method==='eth_getCode'){rateResponse(res,'1');return;}
      return {result:protocolResult(r)};
    });
    const value=await cli([...batchArgs(paths),'--shared-block','--retries','1','--deadline-ms','1500'],
      {PRIVATE_RPC_1:`${fake.url}/1`,PRIVATE_RPC_2:phase==='resolver'?'PRIVATE_INVALID':`${fake.url}/2`,NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`});
    assert.equal(value.code,1);assert.equal(value.stderr,'');const report=JSON.parse(value.stdout);safe(report);
    assert.equal(report.outcomes[0].error.code,'RPC_HTTP');
    if(phase==='resolver'){assert.equal(report.groups[0].status,'unavailable');assert.equal(report.outcomes[1].error.code,'SHARED_BLOCK_UNAVAILABLE');}
    else{assert.equal(report.groups[0].status,'resolved');assert.equal(report.outcomes[1].status,'saved');assert.equal(report.saved,1);}
  });
});
