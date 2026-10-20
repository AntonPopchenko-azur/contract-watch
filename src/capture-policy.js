import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { retryOptions } from './validate.js';
import { fail } from './errors.js';
import { retryAfter } from './retry-after.js';

// Internal runtime context, never a config field or persisted observation.
export const CAPTURE_POLICY = Symbol('capture policy');
const DELAYS = [100, 200, 400];

export function createCapturePolicy(options = {}, runtime = {}) {
  const { retries, deadlineMs } = retryOptions(options);
  const now = runtime.now ?? (() => performance.now());
  const wallNow = runtime.wallNow ?? (() => Date.now());
  // Shared signal covers transport, retry waits and all reads in this capture.
  const signal = runtime.signal;
  const wait = runtime.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const end = deadlineMs === undefined ? Infinity : now() + deadlineMs;
  let nextId = 0;
  const check = () => {
    runtime.check?.();
    const remaining = end === Infinity ? Infinity : end - now();
    if (remaining <= 0) fail('CAPTURE_DEADLINE');
    if (signal?.aborted) fail('RETRY_CANCELLED');
    return remaining;
  };
  const waitUntil = async until => {
    for (;;) {
      const available = check(), remaining = until - now();
      if (remaining <= 0) return;
      try { await wait(Math.ceil(Math.min(remaining, available)), signal); }
      catch (error) { check(); throw error; }
      // Recheck the monotonic minimum after early wakes; never reset the target.
      check();
    }
  };
  return {
    check,
    signal,
    retryEnabled: retries > 0,
    rateLimit(rawHeaders) {
      if (retries === 0) return false;
      const delay = retryAfter(rawHeaders, wallNow());
      if (delay === Infinity) return false;
      return delay === undefined ? true : { notBefore: now() + delay };
    },
    // Preserve legacy per-client IDs when no deadline/retries were requested.
    nextId: deadlineMs === undefined ? undefined : () => ++nextId,
    async guard(work) {
      check();
      try { return await work(); }
      finally { check(); }
    },
    async read(attempt, timeout, retryable) {
      for (let index = 0; ; index++) {
        const remaining = check();
        try {
          const result = await attempt(Math.min(timeout, remaining), remaining <= timeout);
          check();
          return result;
        } catch (error) {
          // Deadline takes precedence over simultaneous exhaustion/provider errors.
          check();
          if (index === retries) throw error;
          const retry = retryable(error);
          if (!retry) throw error;
          check();
          const start = now();
          const until = retry === true ? start + DELAYS[index] : retry.notBefore;
          // A valid server minimum that cannot fit is refused, never shortened.
          if (retry !== true && until >= end) throw error;
          await waitUntil(until);
        }
      }
    }
  };
}

export function capturePolicy(options) {
  return options[CAPTURE_POLICY] ?? createCapturePolicy(options);
}

export function startCapture(options, runtime = {}) {
  return { ...options, [CAPTURE_POLICY]: createCapturePolicy(options, runtime) };
}
