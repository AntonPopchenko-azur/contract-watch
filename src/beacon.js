import { fail } from './errors.js';

export const BEACON_SELECTOR = '0x5c60da1b'; // keccak256('implementation()')[0:4]
export const BEACON_GAS = '0x186a0'; // 100,000 gas, fixed; no estimation or retry.
export const MAX_BEACON_RESPONSE_BYTES = 4096;
export const MAX_BEACON_TIMEOUT_MS = 5000;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const ADDRESS_PADDING = `0x${'0'.repeat(24)}`;

export function decodeBeaconResult(value) {
  // ABI address: exactly 32 bytes, with 12 zero high bytes; no trailing data.
  if (typeof value !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value) ||
      value === ZERO_WORD) fail('BEACON_RESULT');
  const raw = value.toLowerCase();
  return { raw, implementation: `0x${raw.slice(-40)}` };
}

export async function resolveBeacon(rpc, target, code, slots, hash) {
  let reason;
  if (code === '0x') reason = 'NO_TARGET_CODE';
  else if (Object.values(slots).some(raw => !raw.startsWith(ADDRESS_PADDING))) reason = 'NONCANONICAL_SLOT';
  else if (slots.implementation !== ZERO_WORD) reason = 'IMPLEMENTATION_SLOT_POPULATED';
  else if (slots.beacon === ZERO_WORD) reason = 'EMPTY_BEACON';
  if (reason) return { status: 'skipped', reason };

  const beacon = `0x${slots.beacon.slice(-40)}`;
  const decoded = decodeBeaconResult(await rpc.beaconImplementation(target, beacon, hash));
  return { status: 'resolved', beacon, ...decoded };
}

export function beaconReport(resolution) {
  const suffix = 'Live beacon observation only; not saved in snapshot v1.';
  if (resolution.status === 'resolved') {
    return `Beacon ${resolution.beacon} implementation(): ${resolution.implementation}\n${suffix}`;
  }
  const reasons = {
    NO_TARGET_CODE: 'no target code',
    NONCANONICAL_SLOT: 'noncanonical address slot data',
    IMPLEMENTATION_SLOT_POPULATED: 'implementation slot populated',
    EMPTY_BEACON: 'beacon slot empty'
  };
  return `Beacon resolution skipped: ${reasons[resolution.reason]}.\n${suffix}`;
}
