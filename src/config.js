import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { address, chainId, captureInput, timeout, rpcUrl } from './validate.js';
import { fail } from './errors.js';

export const MAX_CONFIG_BYTES = 16 * 1024;
export const MAX_CONFIG_TARGETS = 32;
const targetName = value => typeof value === 'string' && value.length <= 64 &&
  /^[a-z]/.test(value) && !/[^a-z0-9-]/.test(value);
const envName = value => typeof value === 'string' && value.length <= 64 &&
  /^[A-Z_]/.test(value) && !/[^A-Z0-9_]/.test(value);

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('CONFIG');
}

export function validateConfig(value) {
  try {
    keys(value, ['schemaVersion', 'targets']);
    if (value.schemaVersion !== 1 || !Array.isArray(value.targets) ||
        value.targets.length < 1 || value.targets.length > MAX_CONFIG_TARGETS) fail('CONFIG');
    const names = new Set();
    for (const entry of value.targets) {
      keys(entry, ['name', 'address', 'chainId', 'rpcEnv']);
      if (!targetName(entry.name) || names.has(entry.name) || !envName(entry.rpcEnv)) fail('CONFIG');
      address(entry.address); // Syntax for every entry; selected checksum is checked later.
      chainId(entry.chainId); // Exact string input; JSON numbers are rejected.
      // Enforce the complete stored string, including terminal line separators.
      if (entry.address.length !== 42 || entry.chainId.trim() !== entry.chainId) fail('CONFIG');
      names.add(entry.name);
    }
    return value;
  } catch { fail('CONFIG'); }
}

// Bounded lexical preflight before JSON.parse: depth <= 3 (root/targets/entry)
// and no duplicate decoded object keys, including Unicode-escaped aliases.
function parseConfig(text) {
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index++;
        index++;
      }
      if (index === text.length) fail('CONFIG');
      let next = index + 1;
      while (/[\t\r\n ]/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const frame = stack.at(-1);
        const key = JSON.parse(text.slice(start, index + 1));
        if (frame?.kind !== '{' || frame.keys.has(key)) fail('CONFIG');
        frame.keys.add(key);
      }
    } else if (char === '{' || char === '[') {
      stack.push({ kind: char, keys: new Set() });
      if (stack.length > 3) fail('CONFIG');
    } else if (char === '}' || char === ']') {
      if (stack.pop()?.kind !== (char === '}' ? '{' : '[')) fail('CONFIG');
    }
  }
  return validateConfig(JSON.parse(text));
}

export async function readConfig(path) {
  let file;
  let bytes;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_CONFIG_BYTES)) fail('CONFIG_READ');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (size > MAX_CONFIG_BYTES || BigInt(size) !== before.size ||
        ['size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) fail('CONFIG_READ');
    bytes = buffer.subarray(0, size);
  } catch { fail('CONFIG_READ'); }
  finally { await file?.close().catch(() => {}); }
  try {
    // Fatal UTF-8; preserve (and reject) a BOM instead of silently stripping it.
    return parseConfig(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch { fail('CONFIG'); }
}

export async function configuredCapture(path, name, options, environment = process.env) {
  const config = await readConfig(path); // Validate all entries, not just the selected one.
  if (!targetName(name)) fail('CONFIG_TARGET');
  const selected = config.targets.find(entry => entry.name === name);
  if (!selected) fail('CONFIG_TARGET');
  const capture = { ...options, address: selected.address, chainId: selected.chainId };
  captureInput(capture);
  timeout(String(capture.timeoutMs ?? 10000));
  let endpoint;
  try {
    // Only this own property may be read. Never try another target or the default env.
    if (!Object.hasOwn(environment, selected.rpcEnv)) fail('CONFIG_ENV');
    endpoint = environment[selected.rpcEnv];
    rpcUrl(endpoint);
  } catch { fail('CONFIG_ENV'); }
  return { ...capture, rpcUrl: endpoint };
}
