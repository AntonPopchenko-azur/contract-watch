import { open, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { address, chainId, blockTag, quantity, data } from './validate.js';
import { fail } from './errors.js';
import { createRpc } from './rpc.js';

// https://eips.ethereum.org/EIPS/eip-1967
export const SLOTS = Object.freeze({
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
});
export const ZERO_WORD = `0x${'0'.repeat(64)}`;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

function blockHeader(value) {
  if (value === null) fail('BLOCK_UNAVAILABLE');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RPC_DATA');
  return { number: quantity(value.number), hash: data(value.hash, 32) };
}

export async function capture({ rpcUrl, address: inputAddress, chainId: expectedChain, block = 'latest', timeoutMs = 10000 }) {
  const target = address(inputAddress);
  const expected = chainId(expectedChain);
  const tag = blockTag(block);
  const rpc = createRpc(rpcUrl, timeoutMs);
  const actual = BigInt(quantity(await rpc('eth_chainId'))).toString();
  if (actual !== expected) fail('CHAIN_MISMATCH');
  const pinned = blockHeader(await rpc('eth_getBlockByNumber', [tag, false]));
  if (tag.startsWith('0x') && pinned.number !== tag) fail('RPC_DATA');
  const selector = { blockHash: pinned.hash, requireCanonical: true };
  const code = data(await rpc('eth_getCode', [target, selector]));
  const slots = {};
  for (const [name, position] of Object.entries(SLOTS)) {
    slots[name] = data(await rpc('eth_getStorageAt', [target, position, selector]), 32);
  }
  // A late reorg cannot mix state (all reads use a hash); detect canonical changes too.
  const confirmed = blockHeader(await rpc('eth_getBlockByNumber', [pinned.number, false]));
  if (confirmed.number !== pinned.number || confirmed.hash !== pinned.hash) fail('BLOCK_CHANGED');
  if (BigInt(quantity(await rpc('eth_chainId'))).toString() !== expected) fail('CHAIN_MISMATCH');
  return {
    schemaVersion: 1, source: 'rpc', capturedAt: new Date().toISOString(),
    chainId: expected, address: target, block: pinned, code, slots
  };
}

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('SNAPSHOT');
}

export function validateSnapshot(value) {
  try {
    keys(value, ['schemaVersion', 'source', 'capturedAt', 'chainId', 'address', 'block', 'code', 'slots']);
    keys(value.block, ['number', 'hash']);
    keys(value.slots, Object.keys(SLOTS));
    if (value.schemaVersion !== 1 || !['rpc', 'synthetic'].includes(value.source) ||
        typeof value.capturedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.capturedAt) ||
        new Date(value.capturedAt).toISOString() !== value.capturedAt ||
        chainId(value.chainId) !== value.chainId || address(value.address) !== value.address ||
        quantity(value.block.number) !== value.block.number || data(value.block.hash, 32) !== value.block.hash ||
        data(value.code) !== value.code) fail('SNAPSHOT');
    for (const name of Object.keys(SLOTS)) {
      if (data(value.slots[name], 32) !== value.slots[name]) fail('SNAPSHOT');
    }
    return value;
  } catch { fail('SNAPSHOT'); }
}

export async function readSnapshot(path) {
  let file;
  let text;
  try {
    // Nonblocking open prevents special files such as FIFOs from hanging the CLI.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) fail('FILE_READ');
    const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_SNAPSHOT_BYTES) fail('FILE_READ');
    text = buffer.subarray(0, size).toString('utf8');
  } catch { fail('FILE_READ'); }
  finally { await file?.close().catch(() => {}); }
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail('SNAPSHOT'); }
  return validateSnapshot(parsed);
}

export async function saveSnapshot(path, snapshot) {
  validateSnapshot(snapshot);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let file;
  let created = false;
  try {
    file = await open(temporary, 'wx', 0o600);
    created = true;
    await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
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
