import { depth, quantity } from './validate.js';
import { fail } from './errors.js';

export const RANGE_LIMITS = Object.freeze({ blocks: 32, pages: 63, depth: 5, requests: 258,
  responseBytes: 16 * 1024 * 1024, receivedLogs: 1024, uniqueLogs: 512, transactions: 4096,
  reportBytes: 2 * 1024 * 1024 });
export const hexNumber = number => `0x${number.toString(16)}`;

export function rangeBounds(from, to, hex = false) {
  let first, last;
  try { first = hex ? BigInt(quantity(from)) : depth(from); last = hex ? BigInt(quantity(to)) : depth(to); }
  catch { fail('RANGE_INPUT'); }
  if (last < first || last - first >= BigInt(RANGE_LIMITS.blocks)) fail('RANGE_INPUT');
  return { first, last, count: Number(last - first + 1n) };
}

export function pageLimit(value = '63') {
  if (typeof value !== 'string' || !/^[1-9][0-9]?$/.test(value) || Number(value) > RANGE_LIMITS.pages) fail('RANGE_INPUT');
  return Number(value);
}

export function splitRange(first, last) {
  if (first >= last) fail('RANGE_UNSPLITTABLE');
  const middle = first + (last - first) / 2n;
  return [[first, middle], [middle + 1n, last]];
}

// Invocation-local accounting, not a retry policy or provider scheduler.
export function rangeBudget(maxPages) {
  let requests = 0, logRequests = 0, responseBytes = 0;
  return {
    beforeRequest(method) {
      if (requests === RANGE_LIMITS.requests) fail('RANGE_BUDGET');
      if (method === 'eth_getLogs' && logRequests === maxPages) fail('RANGE_PAGES');
      requests++; if (method === 'eth_getLogs') logRequests++;
    },
    receiveBytes(count) {
      responseBytes += count;
      if (responseBytes > RANGE_LIMITS.responseBytes) fail('RANGE_BYTES');
    },
    snapshot: () => ({ requests, logRequests, responseBytes })
  };
}
