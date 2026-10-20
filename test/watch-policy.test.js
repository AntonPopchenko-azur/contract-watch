import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { watchLimits, watchClock, watchLoop } from '../src/watch-policy.js';
import { createCapturePolicy } from '../src/capture-policy.js';

function clock() {
  let time = 0;
  const waits = new Set(), trace = [];
  const runtime = {
    now: () => time,
    sleep(ms, signal) {
      trace.push([time, ms]);
      return new Promise((resolve, reject) => {
        const entry = { at: time + ms, wake: () => done(resolve) };
        const aborted = () => done(() => reject(Error('aborted')));
        function done(action) { waits.delete(entry); signal?.removeEventListener('abort', aborted); action(); }
        if (signal?.aborted) { aborted(); return; }
        signal?.addEventListener('abort', aborted, { once: true }); waits.add(entry);
      });
    }
  };
  return { runtime, trace, waits,
    jump(value) { time = value; },
    async advance(value, early = false) {
      time = value;
      for (const entry of [...waits]) if (early || entry.at <= time) entry.wake();
      await turn();
    }
  };
}
const limits = values => watchLimits({ intervalMs: '100', count: '3', ...values });
const saved = ordinal => ({ ordinal, status: 'saved' });

for (const [key, good, bad] of [
  ['intervalMs', ['100', '60000'], ['0','99','60001','0100','+100',' 100','100 ','1e3','0x64','100.0','１００','1\n']],
  ['count', ['1','128'], ['0','129','01','+1','1 ','1e1','0x1','1.0','１','1\n']],
  ['durationMs', ['100','600000'], ['0','99','600001','0100','-100','100 ','1e3','0x64','100.0','１００','1\n']]
]) {
  for (const value of good) test(`watch limit ${key} accepts boundary ${value}`, () => {
    assert.equal(limits({ [key]: value })[key], Number(value));
  });
  for (const value of [...bad, '', undefined, 100, null, '9'.repeat(1000)]) {
    if (value === undefined && key !== 'intervalMs') continue;
    test(`watch limit ${key} rejects ${String(JSON.stringify(value)).slice(0, 40)}`, () => {
      assert.throws(() => limits({ [key]: value }), { code: 'WATCH_LIMIT' });
    });
  }
}
test('a finite explicit limit is mandatory; optional limits use null in reports', () => {
  assert.throws(() => watchLimits({ intervalMs: '100' }), { code: 'WATCH_LIMIT' });
  assert.deepEqual(watchLimits({ intervalMs: '60000', durationMs: '600000' }),
    { intervalMs: 60000, durationMs: 600000, count: null });
});

test('immediate first attempt, fixed delay after long work, early/late wakes, no catch-up', async () => {
  const c = clock(), starts = [];
  const pending = watchLoop(limits(), async ordinal => {
    starts.push(c.runtime.now());
    if (ordinal === 1) c.jump(250);
    return saved(ordinal);
  }, c.runtime);
  await turn();
  assert.deepEqual(starts, [0]);
  await c.advance(300, true);
  assert.deepEqual(starts, [0]);
  assert.deepEqual(c.trace, [[250,100],[300,50]]);
  await c.advance(350);
  assert.deepEqual(starts, [0,350]);
  await c.advance(5000);
  assert.deepEqual(await pending, { stopReason: 'count', outcomes: [saved(1),saved(2),saved(3)] });
  assert.deepEqual(starts, [0,350,5000]);
  assert.equal(c.waits.size, 0);
});

for (const [values, times, expected] of [
  [{ count: undefined, durationMs: '250' }, [100,200,250], ['duration',3]],
  [{ count: '2', durationMs: '250' }, [100], ['count',2]],
  [{ count: '5', durationMs: '200' }, [100,200], ['duration',2]],
  [{ count: '1', durationMs: '100' }, [], ['count',1]]
]) test(`first user limit wins ${JSON.stringify(values)}`, async () => {
  const c = clock(), pending = watchLoop(limits(values), async ordinal => saved(ordinal), c.runtime);
  await turn();
  for (const time of times) await c.advance(time);
  const report = await pending;
  assert.equal(report.stopReason, expected[0]); assert.equal(report.outcomes.length, expected[1]);
  assert.equal(c.waits.size, 0);
});

for (const count of ['128', undefined]) test(`hard attempt cap includes every failure, count=${count}`, async () => {
  const c = clock(), starts = [];
  const pending = watchLoop(limits({ count, durationMs: '600000' }), async ordinal => {
    starts.push(c.runtime.now()); return { ordinal, status: 'failed' };
  }, c.runtime);
  await turn();
  for (let n = 1; n < 128; n++) await c.advance(n * 100);
  const report = await pending;
  assert.equal(report.stopReason, count ? 'count' : 'attempt-limit');
  assert.equal(report.outcomes.length, 128);
  assert.deepEqual(starts, Array.from({ length: 128 }, (_, n) => n * 100));
  assert.equal(c.waits.size, 0);
});

test('duration cancels active work and produces a stopped ordinal, not saved or failed', async () => {
  const c = clock();
  const pending = watchLoop(limits({ durationMs: '100' }), async (ordinal, policy) => {
    try { await c.runtime.sleep(1000, policy.signal); }
    finally { policy.check(); }
    return saved(ordinal);
  }, c.runtime);
  await c.advance(100);
  assert.deepEqual(await pending, { stopReason: 'duration', outcomes: [{ ordinal: 1, status: 'stopped', reason: 'duration' }] });
  assert.equal(c.waits.size, 0);
});

test('late deadline callback cannot admit a new RPC; same check handles long file work', async () => {
  const c = clock(), policy = watchClock(limits({ durationMs: '100' }), c.runtime);
  let calls = 0;
  const capture = createCapturePolicy({ retries: 3, deadlineMs: 1000 },
    { ...c.runtime, signal: policy.signal, check: policy.check });
  c.jump(100); // do not dispatch timer callbacks
  await assert.rejects(capture.read(() => { calls++; }, 1000, () => true), { code: 'WATCH_DURATION' });
  assert.equal(calls, 0);
  assert.equal(policy.signal.aborted, true);
  await policy.close(); assert.equal(c.waits.size, 0);
});

test('wall clock jumps cannot move intervals, session duration or count', async () => {
  const c = clock(), old = Date.now, starts = [];
  try {
    Date.now = () => -1e12;
    const pending = watchLoop(limits({ durationMs: '200' }), async ordinal => {
      starts.push(c.runtime.now()); return saved(ordinal);
    }, c.runtime);
    await turn(); Date.now = () => 1e12;
    await c.advance(100); Date.now = () => 0;
    await c.advance(200);
    assert.equal((await pending).stopReason, 'duration');
    assert.deepEqual(starts, [0,100]); assert.equal(c.waits.size, 0);
  } finally { Date.now = old; }
});

test('signal cancels interval and deadline timers and has precedence over duration', async () => {
  const c = clock(), controller = new AbortController();
  const pending = watchLoop(limits({ durationMs: '100' }), async ordinal => saved(ordinal),
    { ...c.runtime, signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CAPTURE_CANCELLED' });
  await turn(); c.jump(100); controller.abort(); await rejected;
  assert.equal(c.waits.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('duration after started file work drains it, then records only stopped attempt', async () => {
  const c = clock();
  let release, finished = false;
  const pending = watchLoop(limits({ durationMs: '100' }), async (ordinal, policy) => {
    await new Promise(resolve => { release = resolve; });
    finished = true; policy.check(); return saved(ordinal);
  }, c.runtime);
  await c.advance(100); assert.equal(finished, false);
  release();
  assert.deepEqual(await pending, { stopReason: 'duration', outcomes: [{ ordinal: 1, status: 'stopped', reason: 'duration' }] });
  assert.equal(c.waits.size, 0);
});

test('early duration and interval timer wakes re-wait without admitting an observation',async()=>{
  const c=clock(),starts=[];
  const pending=watchLoop(limits({durationMs:'150'}),async ordinal=>{starts.push(c.runtime.now());return saved(ordinal);},c.runtime);
  await turn();await c.advance(50,true);
  assert.deepEqual(starts,[0]);
  await c.advance(100);assert.deepEqual(starts,[0,100]);
  await c.advance(125,true);assert.deepEqual(starts,[0,100]);
  await c.advance(150);assert.equal((await pending).stopReason,'duration');assert.equal(c.waits.size,0);
});
