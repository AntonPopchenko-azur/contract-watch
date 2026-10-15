import { open, lstat, opendir, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';

export const MAX_HISTORY_FILES = 512;
export const sameInode = (a, b) => ['dev', 'ino', 'mode'].every(key => a[key] === b[key]);
const stable = (a, b) => sameInode(a, b) && ['size', 'mtimeNs'].every(key => a[key] === b[key]);
const stat = path => lstat(path, { bigint: true });
const READ = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

export async function readBounded(path, limit, code = 'HISTORY_CORRUPT') {
  let file, result, failed = false;
  try {
    const named = await stat(path);
    if (!named.isFile() || named.size > BigInt(limit)) fail(code);
    file = await open(path, READ);
    const before = await file.stat({ bigint: true });
    if (!sameInode(named, before) || !before.isFile() || before.size > BigInt(limit)) fail(code);
    // The extra byte detects growth without trusting stat or allocating from it.
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (size > limit || BigInt(size) !== before.size || !stable(before, after) ||
        !stable(after, await stat(path))) fail(code);
    result = buffer.subarray(0, size);
  } catch { failed = true; }
  finally { try { await file?.close(); } catch { failed = true; } }
  if (failed) fail(code);
  return result;
}

export function parseHistoryJson(bytes, code = 'HISTORY_CORRUPT') {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const stack = [];
    // Reject duplicate decoded keys and excessive nesting before JSON.parse.
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        const start = i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
        if (i === text.length) fail(code);
        let next = i + 1;
        while (next < text.length && /[\t\r\n ]/.test(text[next])) next++;
        if (text[next] === ':') {
          const frame = stack.at(-1), key = JSON.parse(text.slice(start, i + 1));
          if (frame?.kind !== '{' || frame.keys.has(key)) fail(code);
          frame.keys.add(key);
        }
      } else if (char === '{' || char === '[') {
        stack.push({ kind: char, keys: new Set() });
        if (stack.length > 6) fail(code);
      } else if (char === '}' || char === ']') {
        if (stack.pop()?.kind !== (char === '}' ? '{' : '[')) fail(code);
      }
    }
    return JSON.parse(text);
  } catch { fail(code); }
}

export async function openHistoryRoot(path) {
  let file;
  try {
    path = resolve(path);
    const named = await stat(path);
    if (!named.isDirectory()) fail('HISTORY_DIRECTORY');
    file = await open(path, READ | constants.O_DIRECTORY);
    const identity = await file.stat({ bigint: true });
    if (!identity.isDirectory() || !sameInode(named, identity)) fail('HISTORY_DIRECTORY');
    return { path, file, identity };
  } catch {
    await file?.close().catch(() => {});
    fail('HISTORY_DIRECTORY');
  }
}

export async function checkRoot(root) {
  try {
    const current = await stat(root.path);
    if (!sameInode(current, root.identity)) fail('HISTORY_CHANGED');
    return current;
  } catch { fail('HISTORY_CHANGED'); }
}

export async function historyNames(root) {
  await checkRoot(root);
  const names = [];
  try {
    // No recursive scan and no unbounded readdir array, even for hostile input.
    const directory = await opendir(root.path, { bufferSize: 16 });
    for await (const entry of directory) {
      if (names.length === MAX_HISTORY_FILES) fail('HISTORY_LIMIT');
      names.push(entry.name);
    }
  } catch (error) {
    if (error.code === 'HISTORY_LIMIT') throw error;
    fail('HISTORY_DIRECTORY');
  }
  await checkRoot(root);
  return names.sort();
}

export async function checkHistoryFile(root, name, limit) {
  await checkRoot(root);
  try {
    const value = await stat(join(root.path, name));
    if (!value.isFile() || value.size > BigInt(limit)) fail('HISTORY_CORRUPT');
  } catch { fail('HISTORY_CORRUPT'); }
}

export async function publishHistoryFile(root, name, bytes) {
  const temporary = join(root.path, `.cw-stage-${randomUUID()}.tmp`);
  let file, pin, identity, created = false, published = false, collision = false, failed = false;
  try {
    await checkRoot(root);
    file = await open(temporary, 'wx', 0o600);
    created = true;
    identity = await file.stat({ bigint: true });
    await file.writeFile(bytes);
    await file.sync();
    identity = await file.stat({ bigint: true });
    pin = await open(temporary, READ);
    if (!stable(identity, await pin.stat({ bigint: true }))) fail('HISTORY_WRITE');
    await file.close(); // Close errors precede publication, as in snapshot writes.
    await checkRoot(root);
    if (!stable(identity, await stat(temporary))) fail('HISTORY_WRITE');
    try { await link(temporary, join(root.path, name)); published = true; }
    catch (error) { if (error.code === 'EEXIST') collision = true; else throw error; }
  } catch { failed = true; }
  finally {
    if (created) try {
      await checkRoot(root);
      // Pin the actual inode; never delete a replacement at the temporary name.
      const owner = pin ?? file;
      if (owner?.fd !== -1) identity = await owner.stat({ bigint: true });
      if (!identity || !stable(identity, await stat(temporary))) fail('HISTORY_WRITE');
      await unlink(temporary);
    } catch { failed = true; }
    for (const handle of [file, pin]) try { await handle?.close(); } catch { failed = true; }
  }
  if (failed) fail('HISTORY_WRITE');
  return published && !collision;
}
