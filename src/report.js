import { createHash } from 'node:crypto';
import { fail } from './errors.js';
import { SLOTS, ZERO_WORD, validateSnapshot } from './snapshot.js';
import { beaconReport } from './beacon.js';

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
  if (beacon !== ZERO_WORD) return snapshot.schemaVersion === 2
    ? 'Beacon implementation() address observed; proxy behavior unverified.'
    : 'Beacon slot populated; beacon implementation is not resolved.';
  if (admin !== ZERO_WORD) return 'Admin slot only; no EIP-1967 target found.';
  return 'No EIP-1967 target found; other proxy patterns may exist.';
}

function codeDetails(code) {
  const bytes = Buffer.from(code.slice(2), 'hex');
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function codeSummary({ bytes, sha256 }) {
  return `${bytes} bytes, SHA-256 ${sha256}`;
}

function slotDetails(raw) {
  const status = raw === ZERO_WORD ? 'empty'
    : raw.startsWith(`0x${'0'.repeat(24)}`) ? 'address' : 'noncanonical';
  return { raw, status, address: status === 'address' ? `0x${raw.slice(-40)}` : null };
}

function implementationReport(value) {
  if (value.status === 'skipped') return `Implementation code skipped: ${value.reason}.`;
  return [
    `Implementation address: ${value.address} (via ${value.via})`,
    ...(value.via === 'beacon' ? [`Beacon ${value.beacon} implementation() raw: ${value.raw}`] : []),
    `Implementation code: ${codeSummary(codeDetails(value.code))}`,
    ...(value.status === 'no-code' ? ['No code at the observed implementation address at this block.'] : []),
    'Implementation observation only; code presence is not proof of proxy behavior or safety.'
  ].join('\n');
}

export function snapshotReport(snapshot, { beaconResolution } = {}) {
  validateSnapshot(snapshot);
  return [
    `Contract Watch | chain ${snapshot.chainId} | ${snapshot.address}`,
    `Source: ${snapshot.source}${snapshot.source === 'synthetic' ? ' (demonstration only)' : ''}`,
    `Block: ${BigInt(snapshot.block.number)} (${snapshot.block.hash})`,
    `${snapshot.schemaVersion === 2 ? 'Target code' : 'Code'}: ${codeSummary(codeDetails(snapshot.code))}`,
    ...Object.keys(SLOTS).map(name => `${name}: ${slotValue(snapshot.slots[name])}`),
    beaconResolution?.status === 'resolved'
      ? 'Beacon implementation() returned an address; proxy behavior and implementation code are unverified.'
      : observation(snapshot),
    ...(beaconResolution ? [beaconReport(beaconResolution)] : []),
    ...(snapshot.schemaVersion === 2 ? [implementationReport(snapshot.implementation)] : [])
  ].join('\n');
}

// This document is independently versioned from the input snapshot schema.
// Only validated, explicitly selected fields are included; never input paths.
export function diffDocument(before, after) {
  validateSnapshot(before);
  validateSnapshot(after);
  if (before.schemaVersion !== 1 || after.schemaVersion !== 1) fail('DIFF_VERSION');
  if (before.chainId !== after.chainId || before.address !== after.address || before.source !== after.source) fail('INCOMPARABLE');
  if (BigInt(after.block.number) < BigInt(before.block.number)) fail('ORDER');
  const changes = [];
  if (before.code !== after.code) changes.push({ field: 'code', before: codeDetails(before.code), after: codeDetails(after.code) });
  for (const name of Object.keys(SLOTS)) {
    if (before.slots[name] !== after.slots[name]) {
      changes.push({ field: name, before: slotDetails(before.slots[name]), after: slotDetails(after.slots[name]) });
    }
  }
  const notices = [];
  if (before.block.number === after.block.number && before.block.hash !== after.block.hash) {
    notices.push('SAME_HEIGHT_DIFFERENT_HASH');
  }
  if (before.block.hash === after.block.hash && (changes.length || before.block.number !== after.block.number)) {
    notices.push('INCONSISTENT_BLOCK_DATA');
  }
  return {
    kind: 'contract-watch-diff', schemaVersion: 1,
    chainId: before.chainId, address: before.address, source: before.source,
    blocks: {
      before: { number: before.block.number, hash: before.block.hash },
      after: { number: after.block.number, hash: after.block.hash }
    },
    changed: changes.length > 0, changes, notices
  };
}

export function compare(before, after) {
  const { changes, notices } = diffDocument(before, after);
  const messages = {
    SAME_HEIGHT_DIFFERENT_HASH: 'Same height, different block hashes: possible reorg; this is not evidence of an upgrade.',
    INCONSISTENT_BLOCK_DATA: 'Same block hash has inconsistent data; check the provider or snapshot files.'
  };
  return {
    changes: changes.map(change => ({
      field: change.field,
      before: change.field === 'code' ? codeSummary(change.before) : slotValue(change.before.raw),
      after: change.field === 'code' ? codeSummary(change.after) : slotValue(change.after.raw)
    })),
    notices: notices.map(code => messages[code])
  };
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
