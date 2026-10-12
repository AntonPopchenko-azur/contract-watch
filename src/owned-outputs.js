import { open, mkdir, realpath, lstat, link, unlink, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';

const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const stat = path => lstat(path, { bigint: true });

// A bounded in-memory journal (at most 32 outputs). Never enumerate/delete a
// directory tree. Paths must be in trusted directories: lstat + unlink is not
// an atomic conditional unlink and cannot defend against hostile concurrent swaps.
export class OwnedOutputs {
  constructor(signal) {
    this.signal = signal;
    this.files = [];
    this.directories = [];
    this.handles = new Set();
    this.uncertain = false;
  }
  check() { if (this.signal.aborted) fail('CAPTURE_CANCELLED'); }
  async parent(path) {
    const lexical = dirname(resolve(path));
    const expected = this.directories.find(entry => entry.path === lexical);
    if (expected) await this.verify(expected);
    const parent = await realpath(lexical);
    const identity = await stat(parent);
    if (!identity.isDirectory()) fail('FILE_WRITE');
    const owned = this.directories.find(entry => entry.path === parent);
    if (this.directories.length && !expected && !owned) fail('FILE_WRITE');
    if (owned && !same(identity, owned.identity)) fail('FILE_WRITE');
    return { path: parent, identity };
  }
  async verify(entry) {
    const identity = await stat(entry.path);
    if (!same(identity, entry.identity)) fail('FILE_WRITE');
    return identity;
  }
  async mkdir(path) {
    this.check();
    let created = false;
    try {
      const parent = await this.parent(path);
      const target = join(parent.path, basename(path));
      this.check();
      await this.verify(parent);
      await mkdir(target, { mode: 0o700 });
      created = true;
      const identity = await stat(target);
      if (!identity.isDirectory()) fail('FILE_WRITE');
      this.directories.push({ path: target, identity, parent });
      created = false;
      this.check();
      return target;
    } catch (error) {
      if (created) this.uncertain = true;
      this.check();
      fail(error.code === 'EEXIST' ? 'BATCH_EXISTS' : 'BATCH_DIRECTORY');
    }
  }
  async remove(entry) {
    if (entry.removed) return;
    await this.verify(entry.parent);
    let current;
    try { current = await stat(entry.path); }
    catch (error) {
      if (error.code === 'ENOENT') { entry.removed = true; return; }
      throw error;
    }
    if (!same(current, entry.identity) || !current.isFile() ||
        current.size !== entry.identity.size || current.mtimeNs !== entry.identity.mtimeNs) fail('FILE_WRITE');
    await unlink(entry.path);
    entry.removed = true;
  }
  async save(path, serialized) {
    this.check();
    if (path.endsWith('/')) fail('FILE_WRITE');
    let file, owner, temporary, untracked = false;
    try {
      const parent = await this.parent(path);
      const target = join(parent.path, basename(path));
      const temp = join(parent.path, `.${basename(path)}.${randomUUID()}.tmp`);
      this.check();
      await this.verify(parent);
      file = await open(temp, 'wx', 0o600);
      this.handles.add(file);
      owner = file;
      untracked = true;
      temporary = { path: temp, identity: await file.stat({ bigint: true }), parent };
      this.files.push(temporary);
      untracked = false;
      this.check();
      await file.writeFile(serialized, { encoding: 'utf8', signal: this.signal });
      this.check();
      await file.sync();
      this.check();
      temporary.identity = await file.stat({ bigint: true });
      await this.verify(parent);
      await this.verify(temporary);
      this.check();
      // Retain a read handle to pin the inode while preserving the old ordering:
      // a write-handle close failure must fail this target before publication.
      const pin = await open(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
      this.handles.add(pin);
      if (!same(await pin.stat({ bigint: true }), temporary.identity)) fail('FILE_WRITE');
      owner = pin;
      await file.close();
      this.handles.delete(file);
      await this.verify(parent);
      await this.verify(temporary);
      this.check();
      // Register only after the no-overwrite link succeeds, even if an interrupt
      // arrived during that syscall. Rollback waits until all writers settle.
      await link(temp, target);
      this.files.push({ path: target, identity: temporary.identity, parent });
      this.check();
    } catch (error) {
      this.check();
      fail(error.code === 'EEXIST' ? 'FILE_EXISTS' : 'FILE_WRITE');
    } finally {
      if (untracked) this.uncertain = true;
      if (temporary) {
        try {
          // A cancelled/failed write can have produced bytes. Use the still-open
          // owned handle, never a replacement path, to identify its final state.
          temporary.identity = await owner.stat({ bigint: true });
          await this.remove(temporary);
        } catch { /* Retain the journal entry for cancellation cleanup. */ }
      }
      // Keep handles until all work drains, pinning inodes while files are owned.
    }
  }
  async close() {
    for (const file of this.handles) {
      if (file.fd === -1) { this.handles.delete(file); continue; }
      try { await file.close(); this.handles.delete(file); }
      catch {
        if (file.fd === -1) this.handles.delete(file);
        else this.uncertain = true;
      }
    }
    return this.handles.size === 0;
  }
  async rollback() {
    let clean = !this.uncertain;
    for (const file of [...this.files].reverse()) {
      try { await this.remove(file); } catch { clean = false; }
    }
    for (const directory of [...this.directories].reverse()) {
      try {
        await this.verify(directory.parent);
        await this.verify(directory);
        // ENOTEMPTY preserves user-added files; never recursively remove them.
        await rmdir(directory.path);
      } catch { clean = false; }
    }
    await this.close();
    return clean && !this.uncertain;
  }
}
