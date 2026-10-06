import { fail } from './errors.js';
import { keccak256 } from './keccak.js';

export const MAX_CODE_BYTES = 128 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;

export function address(value, { strictChecksum = false } = {}) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail('ADDRESS');
  const normalized = value.toLowerCase();
  if (strictChecksum) {
    // EIP-55 hashes ASCII lowercase hex WITHOUT 0x, not the decoded 20 bytes.
    const hex = normalized.slice(2);
    const hash = keccak256(Buffer.from(hex, 'ascii'));
    const checksummed = hex.replace(/[a-f]/g, (digit, index) =>
      Number.parseInt(hash[index], 16) >= 8 ? digit.toUpperCase() : digit);
    if (value !== `0x${checksummed}`) fail('ADDRESS_CHECKSUM');
  }
  return normalized;
}

function inputInteger(value, code) {
  if (typeof value !== 'string' || value.length > 78 ||
      !/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) fail(code);
  const number = BigInt(value);
  if (number > MAX_UINT256) fail(code);
  return number;
}

export function chainId(value) {
  const number = inputInteger(value, 'CHAIN_ID');
  if (number === 0n) fail('CHAIN_ID');
  return number.toString();
}

export function blockTag(value = 'latest') {
  if (['latest', 'safe', 'finalized'].includes(value)) return value;
  return `0x${inputInteger(value, 'BLOCK').toString(16)}`;
}

export function blockHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail('BLOCK_HASH');
  return value.toLowerCase();
}

export function depth(value) {
  if (typeof value !== 'string' || value.length > 78 || !/^(?:0|[1-9][0-9]*)$/.test(value)) fail('DEPTH');
  const number = BigInt(value);
  if (number > MAX_UINT256) fail('DEPTH');
  return number;
}

// Shared by capture and config selection so local options can be checked before
// resolving a secret-bearing environment value. Preserve original address casing.
export function captureInput({ address: inputAddress, chainId: expectedChain,
  block, blockHash: inputHash, depth: inputDepth, strictChecksum = false, genesis = false }) {
  if (typeof genesis !== 'boolean') fail('USAGE');
  if ([block, inputHash, inputDepth].filter(value => value !== undefined).length > 1) fail('USAGE');
  const target = address(inputAddress, { strictChecksum });
  const expected = chainId(expectedChain);
  const hash = inputHash === undefined ? undefined : blockHash(inputHash);
  const distance = inputDepth === undefined ? undefined : depth(inputDepth);
  const tag = hash === undefined ? blockTag(block) : undefined;
  return { target, expected, hash, distance, tag };
}

export function quantity(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) fail('RPC_DATA');
  return value.toLowerCase();
}

export function data(value, bytes) {
  if (typeof value !== 'string' || value.length > 2 + MAX_CODE_BYTES * 2 ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
      (bytes !== undefined && value.length !== 2 + bytes * 2)) fail('RPC_DATA');
  return value.toLowerCase();
}

export function rpcUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || /\s/.test(value)) fail('RPC_URL');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.hash || value.includes('#')) fail('RPC_URL');
    return url;
  } catch { fail('RPC_URL'); }
}

export function timeout(value = '10000') {
  if (typeof value !== 'string' || !/^[0-9]{3,5}$/.test(value) ||
      Number(value) < 100 || Number(value) > 60000) fail('TIMEOUT_OPTION');
  return Number(value);
}
