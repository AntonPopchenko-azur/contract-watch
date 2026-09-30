import { fail } from './errors.js';

export const MAX_CODE_BYTES = 128 * 1024;
const MAX_UINT256 = (1n << 256n) - 1n;

export function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail('ADDRESS');
  return value.toLowerCase();
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
