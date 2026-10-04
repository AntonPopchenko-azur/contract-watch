import { data } from './validate.js';
import { resolveBeacon } from './beacon.js';

const ZERO_WORD = `0x${'0'.repeat(64)}`;
const ADDRESS_PADDING = `0x${'0'.repeat(24)}`;

// Conservative evidence selection, shared with offline validation of persisted v2.
export function implementationSelection(code, slots) {
  if (code === '0x') return { reason: 'NO_TARGET_CODE' };
  if (Object.values(slots).some(raw => !raw.startsWith(ADDRESS_PADDING))) return { reason: 'NONCANONICAL_SLOT' };
  if (slots.implementation !== ZERO_WORD && slots.beacon !== ZERO_WORD) return { reason: 'AMBIGUOUS_SLOTS' };
  if (slots.implementation !== ZERO_WORD) return { via: 'implementation-slot', address: `0x${slots.implementation.slice(-40)}` };
  if (slots.beacon !== ZERO_WORD) return { via: 'beacon', beacon: `0x${slots.beacon.slice(-40)}` };
  return { reason: 'EMPTY_SLOTS' };
}

export async function captureImplementation(rpc, target, code, slots, hash) {
  const selected = implementationSelection(code, slots);
  if (selected.reason) return { status: 'skipped', reason: selected.reason };
  let provenance = selected;
  if (selected.via === 'beacon') {
    const resolved = await resolveBeacon(rpc, target, code, slots, hash);
    provenance = { via: 'beacon', address: resolved.implementation, beacon: resolved.beacon, raw: resolved.raw };
  }
  // Exactly one additional code read; never traverse the observed implementation.
  const implementationCode = data(await rpc('eth_getCode', [
    provenance.address, { blockHash: hash, requireCanonical: true }
  ]));
  return { status: implementationCode === '0x' ? 'no-code' : 'observed', ...provenance, code: implementationCode };
}
