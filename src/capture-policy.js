import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { retryOptions } from './validate.js';
import { fail } from './errors.js';

// Internal runtime context, never a config field or persisted observation.
export const CAPTURE_POLICY = Symbol('capture policy');
const DELAYS = [100, 200, 400];

export function createCapturePolicy(options = {}, runtime = {}) {
  const { retries, deadlineMs } = retryOptions(options);
  const now = runtime.now ?? (() => performance.now());
  const wait = runtime.sleep ?? sleep;
  const end = deadlineMs === undefined ? Infinity : now() + deadlineMs;
  let nextId = 0;
  const check = () => {
    const remaining = end === Infinity ? Infinity : end - now();
    if (remaining <= 0) fail('CAPTURE_DEADLINE');
    return remaining;
  };
  return {
    check,
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
          if (index === retries || !retryable(error)) throw error;
          const delay = DELAYS[index], available = check();
          await wait(Math.min(delay, available));
          check();
          // A deadline-limited wait cannot start another attempt, even if a
          // platform timer wakes fractionally early.
          if (available <= delay) fail('CAPTURE_DEADLINE');
        }
      }
    }
  };
}

export function capturePolicy(options) {
  return options[CAPTURE_POLICY] ?? createCapturePolicy(options);
}

export function startCapture(options) {
  return { ...options, [CAPTURE_POLICY]: createCapturePolicy(options) };
}
