import { fail } from './errors.js';

export const retainedOrdinals = (count, keepLast) => Array.from({ length: count }, (_, n) => n + 1)
  .filter(n => n === 1 || n > count - keepLast);

export function retentionCount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(value) || Number(value) > 128) fail('RETENTION_KEEP');
  return Number(value);
}

export function validateRetention(value) {
  const keys = ['policy', 'keepLast', 'sourceState', 'sourceCommitted', 'sourcePending', 'sourceStaged',
    'ordinals', 'observationsSha256', 'planId'];
  const count = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== keys.sort().join(',') || value.policy !== 'baseline-and-last' ||
      !count(value.keepLast, 128) || !count(value.sourceCommitted, 128) ||
      !count(value.sourcePending, 511) || !count(value.sourceStaged, 511) ||
      1 + value.sourceCommitted * 2 + value.sourcePending + value.sourceStaged > 512 ||
      !['sourceState', 'observationsSha256', 'planId'].every(key => typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key])) ||
      !Array.isArray(value.ordinals) || JSON.stringify(value.ordinals) !== JSON.stringify(retainedOrdinals(value.sourceCommitted, value.keepLast))) fail('HISTORY_CORRUPT');
  return value;
}
