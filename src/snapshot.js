import { open, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { address, chainId, blockTag, blockHash, depth, quantity, data } from './validate.js';
import { fail } from './errors.js';
import { createRpc } from './rpc.js';
import { resolveBeacon, decodeBeaconResult } from './beacon.js';
import { captureImplementation, implementationSelection } from './implementation.js';

// https://eips.ethereum.org/EIPS/eip-1967
export const SLOTS = Object.freeze({
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
});
export const ZERO_WORD = `0x${'0'.repeat(64)}`;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_V2_BYTES = 768 * 1024;
export const MAX_SNAPSHOT_V3_BYTES = MAX_SNAPSHOT_V2_BYTES;
export const MAX_SNAPSHOT_V4_BYTES = MAX_SNAPSHOT_V3_BYTES;
const fileLimit = version => [2, 3, 4].includes(version) ? MAX_SNAPSHOT_V4_BYTES : MAX_SNAPSHOT_BYTES;

function blockHeader(value) {
  if (value === null) fail('BLOCK_UNAVAILABLE');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RPC_DATA');
  return { number: quantity(value.number), hash: data(value.hash, 32) };
}

async function genesisHash(rpc) {
  const header = blockHeader(await rpc('eth_getBlockByNumber', ['0x0', false]));
  if (header.number !== '0x0' || header.hash === ZERO_WORD) fail('RPC_DATA');
  return header.hash;
}

// The default API retains v1; explicit genesis opts into the v4 file contract.
export async function capture(options) {
  return (await captureObservation(options, false)).snapshot;
}

// Resolution is transient: never add it to the saved v1/v4 object.
export async function captureWithBeacon(options) {
  return captureObservation(options, true);
}

export async function captureWithImplementation(options) {
  return (await captureObservation(options, false, true)).snapshot;
}

async function captureObservation({
  rpcUrl, address: inputAddress, chainId: expectedChain,
  block, blockHash: inputHash, depth: inputDepth, timeoutMs = 10000, strictChecksum = false,
  genesis = false
}, includeBeacon, includeImplementation = false) {
  if (typeof genesis !== 'boolean') fail('USAGE');
  if ([block, inputHash, inputDepth].filter(value => value !== undefined).length > 1) fail('USAGE');
  const target = address(inputAddress, { strictChecksum });
  const expected = chainId(expectedChain);
  const hash = inputHash === undefined ? undefined : blockHash(inputHash);
  const distance = inputDepth === undefined ? undefined : depth(inputDepth);
  const tag = hash === undefined ? blockTag(block) : undefined;
  const rpc = createRpc(rpcUrl, timeoutMs);
  const actual = BigInt(quantity(await rpc('eth_chainId'))).toString();
  if (actual !== expected) fail('CHAIN_MISMATCH');
  const initialGenesis = genesis ? await genesisHash(rpc) : undefined;
  let pinned = blockHeader(await rpc(
    hash === undefined ? 'eth_getBlockByNumber' : 'eth_getBlockByHash', [hash ?? tag, false]
  ));
  if (distance !== undefined) {
    // In depth mode the first lookup is latest. Fix the target once, before reads.
    const initialHeight = BigInt(pinned.number);
    if (distance > initialHeight) fail('DEPTH_UNDERFLOW');
    if (distance > 0n) {
      const number = `0x${(initialHeight - distance).toString(16)}`;
      pinned = blockHeader(await rpc('eth_getBlockByNumber', [number, false]));
      if (pinned.number !== number) fail('RPC_DATA');
    }
  } else if (hash !== undefined) {
    if (pinned.hash !== hash) fail('RPC_DATA');
    // A by-hash lookup may return a side-chain block. Reject it before state reads.
    const canonical = blockHeader(await rpc('eth_getBlockByNumber', [pinned.number, false]));
    if (canonical.number !== pinned.number) fail('RPC_DATA');
    if (canonical.hash !== pinned.hash) fail('BLOCK_NOT_CANONICAL');
  } else if (tag.startsWith('0x') && pinned.number !== tag) fail('RPC_DATA');
  if (genesis && pinned.number === '0x0' && pinned.hash !== initialGenesis) fail('GENESIS_CHANGED');
  const selector = { blockHash: pinned.hash, requireCanonical: true };
  const code = data(await rpc('eth_getCode', [target, selector]));
  const slots = {};
  for (const [name, position] of Object.entries(SLOTS)) {
    slots[name] = data(await rpc('eth_getStorageAt', [target, position, selector]), 32);
  }
  const beaconResolution = includeBeacon ? await resolveBeacon(rpc, target, code, slots, pinned.hash) : undefined;
  const implementation = includeImplementation
    ? await captureImplementation(rpc, target, code, slots, pinned.hash) : undefined;
  // A late reorg cannot mix state (all reads use a hash); detect canonical changes too.
  const confirmed = blockHeader(await rpc('eth_getBlockByNumber', [pinned.number, false]));
  if (confirmed.number !== pinned.number || confirmed.hash !== pinned.hash) fail('BLOCK_CHANGED');
  if (genesis && await genesisHash(rpc) !== initialGenesis) fail('GENESIS_CHANGED');
  if (BigInt(quantity(await rpc('eth_chainId'))).toString() !== expected) fail('CHAIN_MISMATCH');
  const snapshot = {
    schemaVersion: genesis ? 4 : includeImplementation ? 2 : 1, source: 'rpc', capturedAt: new Date().toISOString(),
    chainId: expected, address: target, block: pinned, code, slots,
    ...(includeImplementation ? { implementation } : genesis ? { implementation: { status: 'not-recorded' } } : {}),
    ...(genesis ? { genesis: { status: 'observed', hash: initialGenesis } } : {})
  };
  return { snapshot, beaconResolution };
}

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('SNAPSHOT');
}

export function validateSnapshot(value) {
  try {
    keys(value, ['schemaVersion', 'source', 'capturedAt', 'chainId', 'address', 'block', 'code', 'slots',
      ...([2, 3, 4].includes(value?.schemaVersion) ? ['implementation'] : []),
      ...(value?.schemaVersion === 3 || (value?.schemaVersion === 4 && value?.genesis?.status === 'not-recorded') ? ['migration'] : []),
      ...(value?.schemaVersion === 4 ? ['genesis'] : [])]);
    keys(value.block, ['number', 'hash']);
    keys(value.slots, Object.keys(SLOTS));
    if (![1, 2, 3, 4].includes(value.schemaVersion) || !['rpc', 'synthetic'].includes(value.source) ||
        typeof value.capturedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.capturedAt) ||
        new Date(value.capturedAt).toISOString() !== value.capturedAt ||
        chainId(value.chainId) !== value.chainId || address(value.address) !== value.address ||
        quantity(value.block.number) !== value.block.number || data(value.block.hash, 32) !== value.block.hash ||
        data(value.code) !== value.code) fail('SNAPSHOT');
    for (const name of Object.keys(SLOTS)) {
      if (data(value.slots[name], 32) !== value.slots[name]) fail('SNAPSHOT');
    }
    if (value.schemaVersion === 2) validateImplementation(value);
    if (value.schemaVersion === 3 || (value.schemaVersion === 4 && value.genesis.status === 'not-recorded')) {
      keys(value.migration, ['fromVersion']);
      if (value.migration.fromVersion === 1) {
        keys(value.implementation, ['status']);
        if (value.implementation.status !== 'not-recorded') fail('SNAPSHOT');
      } else if (value.migration.fromVersion === 2) validateImplementation(value);
      else fail('SNAPSHOT');
    }
    if (value.schemaVersion === 4) {
      if (value.genesis.status === 'not-recorded') keys(value.genesis, ['status']);
      else {
        keys(value.genesis, ['status', 'hash']);
        if (value.genesis.status !== 'observed' || data(value.genesis.hash, 32) !== value.genesis.hash ||
            value.genesis.hash === ZERO_WORD ||
            (value.block.number === '0x0' && value.block.hash !== value.genesis.hash)) fail('SNAPSHOT');
        if (value.implementation.status === 'not-recorded') keys(value.implementation, ['status']);
        else validateImplementation(value);
      }
    }
    return value;
  } catch { fail('SNAPSHOT'); }
}

function validateImplementation(snapshot) {
  const selected = implementationSelection(snapshot.code, snapshot.slots);
  const observed = snapshot.implementation;
  if (selected.reason) {
    keys(observed, ['status', 'reason']);
    if (observed.status !== 'skipped' || observed.reason !== selected.reason) fail('SNAPSHOT');
    return;
  }
  keys(observed, ['status', 'via', 'address', 'code', ...(selected.via === 'beacon' ? ['beacon', 'raw'] : [])]);
  if (observed.via !== selected.via || data(observed.code) !== observed.code ||
      observed.status !== (observed.code === '0x' ? 'no-code' : 'observed')) fail('SNAPSHOT');
  if (selected.via === 'implementation-slot') {
    if (observed.address !== selected.address) fail('SNAPSHOT');
  } else {
    const decoded = decodeBeaconResult(observed.raw);
    if (observed.beacon !== selected.beacon || observed.raw !== decoded.raw ||
        observed.address !== decoded.implementation) fail('SNAPSHOT');
  }
}

export async function readSnapshot(path) {
  let file;
  let text;
  let size = 0;
  try {
    // Nonblocking open prevents special files such as FIFOs from hanging the CLI.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_V4_BYTES) fail('FILE_READ');
    const buffer = Buffer.alloc(MAX_SNAPSHOT_V4_BYTES + 1);
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_SNAPSHOT_V4_BYTES) fail('FILE_READ');
    text = buffer.subarray(0, size).toString('utf8');
  } catch { fail('FILE_READ'); }
  finally { await file?.close().catch(() => {}); }
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail(size > MAX_SNAPSHOT_BYTES ? 'FILE_READ' : 'SNAPSHOT'); }
  if (size > fileLimit(parsed?.schemaVersion)) fail('FILE_READ');
  return validateSnapshot(parsed);
}

export async function saveSnapshot(path, snapshot) {
  validateSnapshot(snapshot);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let file;
  let created = false;
  try {
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > fileLimit(snapshot.schemaVersion)) fail('FILE_WRITE');
    file = await open(temporary, 'wx', 0o600);
    created = true;
    await file.writeFile(serialized, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    // A same-directory hard link publishes a complete file without replacing any target.
    await link(temporary, path);
  } catch (error) {
    fail(error.code === 'EEXIST' ? 'FILE_EXISTS' : 'FILE_WRITE');
  } finally {
    await file?.close().catch(() => {});
    if (created) await unlink(temporary).catch(() => {});
  }
}
