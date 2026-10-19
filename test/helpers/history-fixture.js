import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { temporaryDirectory, fixture } from './fake-rpc.js';
import assert from 'node:assert/strict';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => `${JSON.stringify(value, null, 2)}\n`;
export function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
}
export const id = value => hash(JSON.stringify(sorted(value)));
export const snapshotName = value => `snapshot-${id(value)}.json`;
export const stageName = n => `.cw-stage-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000.tmp`;
export const next = (value, n = 1) => ({ ...structuredClone(value),
  capturedAt: new Date(Date.parse(value.capturedAt) + n * 1000).toISOString(),
  block: { number: `0x${(BigInt(value.block.number) + BigInt(n)).toString(16)}`, hash: `0x${Math.abs(n).toString(16).padStart(64, '0')}` } });

// Write documented v1 history bytes independently of production history APIs.
export async function store(t, values, { pending = [], stages = [], seed = values[0] ?? fixture(), bytes = json, indexBytes = json } = {}) {
  const parent = await temporaryDirectory(t), directory = join(parent, 'PRIVATE_history');
  await fs.mkdir(directory, { mode: 0o700 });
  const identity = { address: seed.address, chainId: seed.chainId, source: seed.source,
    snapshotVersion: seed.schemaVersion, genesis: seed.genesis ?? { status: 'not-recorded' } };
  const header = { kind: 'contract-watch-history', schemaVersion: 1, identity }, headerBytes = indexBytes(header);
  await fs.writeFile(join(directory, 'index.json'), headerBytes, { mode: 0o600 });
  let previous = hash(headerBytes);
  const committed = new Map(), snapshots = new Map(), entries = [];
  for (const [i, value] of [...values, ...pending].entries()) {
    const raw = bytes(value), observationId = id(value);
    await fs.writeFile(join(directory, snapshotName(value)), raw, { mode: 0o600 });
    snapshots.set(observationId, value);
    if (i >= values.length) continue;
    const record = { kind: 'contract-watch-history-entry', schemaVersion: 1,
      ordinal: i + 1, previous, observationId, snapshot: snapshotName(value),
      sha256: hash(raw), bytes: Buffer.byteLength(raw), capturedAt: value.capturedAt, block: value.block };
    const entry = indexBytes(record), name = `entry-${String(i + 1).padStart(4, '0')}.json`;
    await fs.writeFile(join(directory, name), entry, { mode: 0o600 });
    previous = hash(entry); entries.push(name); committed.set(observationId, record);
  }
  for (const [i, raw] of stages.entries()) await fs.writeFile(join(directory, stageName(i)), raw, { mode: 0o600 });
  return { parent, directory, output: join(parent, 'PRIVATE_copy'), values,
    state: { header, committed, snapshots, entries, stages: stages.map((_, i) => stageName(i)) } };
}

export async function tree(path) {
  const s = await fs.lstat(path, { bigint: true });
  return { mode: s.mode, ino: s.ino, size: s.size, mtime: s.mtimeNs, ctime: s.ctimeNs,
    bytes: s.isFile() ? await fs.readFile(path) : s.isSymbolicLink() ? await fs.readlink(path) : null,
    children: s.isDirectory() ? await Promise.all((await fs.readdir(path)).sort().map(async n => [n, await tree(join(path, n))])) : null };
}
export async function preserved(path, action) {
  const before = await tree(path), result = await action();
  assert.deepEqual(await tree(path), before);
  return result;
}
