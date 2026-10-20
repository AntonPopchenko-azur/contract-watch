import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fail } from './errors.js';
import { checkCancellation } from './cancellation.js';

export const MAX_WATCH_ATTEMPTS = 128;
export function watchLimits({ intervalMs, count, durationMs }) {
  const number = (value, min, max) => {
    if (typeof value !== 'string' || value.length > 6 || !/^[1-9][0-9]*$/.test(value) ||
        Number(value) < min || Number(value) > max) fail('WATCH_LIMIT');
    return Number(value);
  };
  if (count === undefined && durationMs === undefined) fail('WATCH_LIMIT');
  return {
    intervalMs: number(intervalMs, 100, 60000),
    count: count === undefined ? null : number(count, 1, MAX_WATCH_ATTEMPTS),
    durationMs: durationMs === undefined ? null : number(durationMs, 100, 600000)
  };
}

// The timer interrupts active transport/waits. Synchronous checks additionally
// prevent new reads when the event loop has not yet delivered that timer.
export function watchClock(limits, runtime = {}) {
  const now = runtime.now ?? (() => performance.now());
  const wait = runtime.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const duration = new AbortController(), timer = new AbortController();
  const signal = AbortSignal.any([duration.signal, ...(runtime.signal ? [runtime.signal] : [])]);
  const timerSignal = AbortSignal.any([timer.signal, signal]);
  const end = limits.durationMs === null ? Infinity : now() + limits.durationMs;
  let timerError;
  const expired = () => {
    if (now() >= end) duration.abort();
    return duration.signal.aborted;
  };
  const check = () => {
    checkCancellation(runtime.signal);
    if (timerError) throw timerError;
    if (expired()) fail('WATCH_DURATION');
  };
  const wake = async until => {
    for (;;) {
      check();
      const remaining = Math.min(until, end) - now();
      if (remaining <= 0) { check(); return; }
      try { await wait(Math.ceil(remaining), signal); }
      catch (error) { check(); throw error; }
    }
  };
  const alarm = end === Infinity ? Promise.resolve() : (async () => {
    try {
      while (!timerSignal.aborted && !expired()) {
        await wait(Math.max(1, Math.ceil(end - now())), timerSignal);
      }
    } catch (error) {
      if (!timerSignal.aborted) { timerError = error; duration.abort(); }
    }
  })();
  return {
    signal, check, now, wake,
    async close() { timer.abort(); await alarm; }
  };
}

// One awaited observation owns the entire capture/write/cleanup interval.
export async function watchLoop(limits, attempt, runtime = {}) {
  const clock = watchClock(limits, runtime), outcomes = [];
  let stopReason;
  try {
    for (;;) {
      try { clock.check(); }
      catch (error) {
        if (error.code !== 'WATCH_DURATION') throw error;
        stopReason = 'duration'; break;
      }
      const ordinal = outcomes.length + 1;
      try { outcomes.push(await attempt(ordinal, clock)); }
      catch (error) {
        if (error.code !== 'WATCH_DURATION') throw error;
        outcomes.push({ ordinal, status: 'stopped', reason: 'duration' });
        stopReason = 'duration'; break;
      }
      try { clock.check(); }
      catch (error) {
        if (error.code !== 'WATCH_DURATION') throw error;
        stopReason = 'duration'; break;
      }
      if (outcomes.length === limits.count) { stopReason = 'count'; break; }
      if (outcomes.length === MAX_WATCH_ATTEMPTS) { stopReason = 'attempt-limit'; break; }
      try { await clock.wake(clock.now() + limits.intervalMs); }
      catch (error) {
        if (error.code !== 'WATCH_DURATION') throw error;
        stopReason = 'duration'; break;
      }
    }
    return { stopReason, outcomes };
  } finally { await clock.close(); }
}
