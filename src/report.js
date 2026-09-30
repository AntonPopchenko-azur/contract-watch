import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { SLOTS, ZERO_WORD, validateSnapshot } from './snapshot.js';

export function slotValue(raw) {
  if (raw === ZERO_WORD) return 'empty';
  if (!raw.startsWith(`0x${'0'.repeat(24)}`)) return `noncanonical word ${raw}`;
  return `0x${raw.slice(-40)}`;
}

export function observation(snapshot) {
  if (snapshot.code === '0x') return 'No code at this block; proxy behavior is not established.';
  const { implementation, admin, beacon } = snapshot.slots;
  if (Object.values(snapshot.slots).some(raw => slotValue(raw).startsWith('noncanonical'))) {
    return 'Noncanonical address slot data; inspect raw words.';
  }
  if (implementation !== ZERO_WORD && beacon !== ZERO_WORD) return 'Both implementation and beacon slots populated; ambiguous evidence.';
  if (implementation !== ZERO_WORD) return 'Implementation slot populated; proxy behavior unverified.';
  if (beacon !== ZERO_WORD) return 'Beacon slot populated; beacon implementation is not resolved.';
  if (admin !== ZERO_WORD) return 'Admin slot only; no EIP-1967 target found.';
  return 'No EIP-1967 target found; other proxy patterns may exist.';
}

function codeSummary(code) {
  const bytes = Buffer.from(code.slice(2), 'hex');
  return `${bytes.length} bytes, SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`;
}

export function snapshotReport(snapshot) {
  validateSnapshot(snapshot);
  return [
    `Contract Watch | chain ${snapshot.chainId} | ${snapshot.address}`,
    `Source: ${snapshot.source}${snapshot.source === 'synthetic' ? ' (demonstration only)' : ''}`,
    `Block: ${BigInt(snapshot.block.number)} (${snapshot.block.hash})`,
    `Code: ${codeSummary(snapshot.code)}`,
    ...Object.keys(SLOTS).map(name => `${name}: ${slotValue(snapshot.slots[name])}`),
    observation(snapshot)
  ].join('\n');
}

export function compare(before, after) {
  validateSnapshot(before);
  validateSnapshot(after);
  if (before.chainId !== after.chainId || before.address !== after.address || before.source !== after.source) fail('INCOMPARABLE');
  if (BigInt(after.block.number) < BigInt(before.block.number)) fail('ORDER');
  const changes = [];
  if (before.code !== after.code) changes.push({ field: 'code', before: codeSummary(before.code), after: codeSummary(after.code) });
  for (const name of Object.keys(SLOTS)) {
    if (before.slots[name] !== after.slots[name]) {
      changes.push({ field: name, before: slotValue(before.slots[name]), after: slotValue(after.slots[name]) });
    }
  }
  const notices = [];
  if (before.block.number === after.block.number && before.block.hash !== after.block.hash) {
    notices.push('Same height, different block hashes: possible reorg; this is not evidence of an upgrade.');
  }
  if (before.block.hash === after.block.hash && (changes.length || before.block.number !== after.block.number)) {
    notices.push('Same block hash has inconsistent data; check the provider or snapshot files.');
  }
  return { changes, notices };
}

export function diffReport(before, after) {
  const { changes, notices } = compare(before, after);
  return [
    `Contract Watch diff | chain ${before.chainId} | ${before.address}`,
    `Source: ${before.source}${before.source === 'synthetic' ? ' (demonstration only)' : ''}`,
    `Blocks: ${BigInt(before.block.number)} -> ${BigInt(after.block.number)}`,
    ...notices,
    ...(changes.length ? changes.map(change => `${change.field}: ${change.before} -> ${change.after}`) : ['No code or EIP-1967 slot changes.']),
    `Observation: ${observation(after)}`,
    'This comparison is not a contract safety assessment.'
  ].join('\n');
}
