import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const anchor = (handle, name) => `/proc/self/fd/${handle.fd}/${name}`;
const unsafe = () => Object.assign(new Error('Inventory failed'), { code: 'EINVENTORY' });
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
  .every(key => a[key] === b[key]);
const sameAncestor = (a, b) => a.isDirectory() && b.isDirectory() &&
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;

export function inodeGuard(forbiddenInodes, onBeforeOpen) {
  if (forbiddenInodes === undefined) forbiddenInodes = [];
  if (!Array.isArray(forbiddenInodes) || forbiddenInodes.length > 10000 ||
      (onBeforeOpen !== undefined && typeof onBeforeOpen !== 'function')) throw unsafe();
  const keys = new Set();
  for (const entry of forbiddenInodes) {
    if (!entry || typeof entry !== 'object') throw unsafe();
    const { dev, ino } = entry;
    if (typeof dev !== 'bigint' || typeof ino !== 'bigint' ||
        dev < 0n || ino < 0n || dev > 0xffffffffffffffffn || ino > 0xffffffffffffffffn) throw unsafe();
    keys.add(`${dev}:${ino}`);
  }
  const check = stat => { if (keys.has(`${stat.dev}:${stat.ino}`)) throw unsafe(); };
  return {
    check,
    inodes: Object.freeze([...keys].map(key => {
      const [dev, ino] = key.split(':').map(BigInt);
      return Object.freeze({ dev, ino });
    })),
    async before(target, stat, compare = same) {
      check(stat);
      if (onBeforeOpen) {
        await onBeforeOpen(target);
        const after = await fs.lstat(target, { bigint: true });
        check(after);
        if (!compare(stat, after)) throw unsafe();
      }
    },
    async absent(target) {
      try { check(await fs.lstat(target, { bigint: true })); throw unsafe(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (onBeforeOpen) {
        await onBeforeOpen(target);
        try { check(await fs.lstat(target, { bigint: true })); throw unsafe(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  };
}

async function mountId(handle) {
  const info = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const match = /^mnt_id:\s*(\d+)\s*$/m.exec(info);
  if (!match) throw unsafe();
  return match[1];
}

async function openEntry(parent, name, directory, mount, guard, compare = same) {
  const target = anchor(parent, name);
  const before = await fs.lstat(target, { bigint: true });
  if (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n) throw unsafe();
  await guard.before(target, before, compare);
  const handle = await fs.open(target, directory ? dirFlags : fileFlags);
  try {
    const actual = await handle.stat({ bigint: true });
    guard.check(actual);
    const after = await fs.lstat(target, { bigint: true });
    if (!compare(before, actual) || !compare(actual, after) || (mount && await mountId(handle) !== mount)) throw unsafe();
    return { handle, stat: actual };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyPathEntry(parent, name, handle, initial, compare, guard) {
  const target = anchor(parent, name);
  const actual = await handle.stat({ bigint: true });
  const linked = await fs.lstat(target, { bigint: true });
  if (!compare(initial, actual) || !compare(actual, linked)) throw unsafe();
  await guard.before(target, linked, compare);
  const reopened = await fs.open(target, dirFlags);
  try {
    const reopenedStat = await reopened.stat({ bigint: true });
    guard.check(reopenedStat);
    const after = await fs.lstat(target, { bigint: true });
    if (!compare(actual, reopenedStat) || !compare(reopenedStat, after) ||
        await mountId(handle) !== await mountId(reopened)) throw unsafe();
  } finally { await reopened.close(); }
}

async function verify(parent, name, handle, initial) {
  const actual = await handle.stat({ bigint: true });
  const linked = await fs.lstat(anchor(parent, name), { bigint: true });
  if (!same(initial, actual) || !same(actual, linked)) throw unsafe();
}

function metadata(relative, type, stat) {
  return { path: relative, type, mode: Number(stat.mode & 0o7777n), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), device: stat.dev.toString(), inode: stat.ino.toString() };
}

export async function safeInventory(options = {}) {
  try {
    const { root, callerGuardAndRescan, maxDepth = 32, maxFiles = 10000,
      maxEntries = 20000, maxBytes = 1024 * 1024 * 1024, onChunk, forbiddenInodes, onBeforeOpen } = options;
    const guard = inodeGuard(forbiddenInodes, onBeforeOpen);
    if (process.platform !== 'linux' || callerGuardAndRescan !== true || typeof root !== 'string' ||
      !path.isAbsolute(root) || root.includes('\0') || (onChunk !== undefined && typeof onChunk !== 'function')) throw unsafe();
    for (const [value, ceiling] of [[maxDepth, 128], [maxFiles, 1000000], [maxEntries, 1000000], [maxBytes, Number.MAX_SAFE_INTEGER]]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > ceiling) throw unsafe();
    }
    const parts = root.split('/').filter(Boolean);
    if (parts.length > 128 || parts.some(part => part === '.' || part === '..')) throw unsafe();
    const ancestors = [];
    const rootStat = await fs.lstat('/', { bigint: true });
    await guard.before('/', rootStat, sameAncestor);
    const base = await fs.open('/', dirFlags);
    let current = base;
    try {
      const openedRoot = await base.stat({ bigint: true });
      guard.check(openedRoot);
      if (!sameAncestor(rootStat, openedRoot) || !sameAncestor(openedRoot, await fs.lstat('/', { bigint: true }))) throw unsafe();
      await mountId(base);
      for (const [index, part] of parts.entries()) {
        const entry = await openEntry(current, part, true, undefined, guard, index === parts.length - 1 ? same : sameAncestor);
        ancestors.push({ parent: current, name: part, ...entry });
        current = entry.handle;
      }
      const mount = await mountId(current);
      const manifest = [];
      let files = 0;
      let entries = 0;
      let bytes = 0n;

      async function walk(dir, relative, depth, initial) {
        manifest.push(metadata(relative, 'dir', initial));
        const listing = await fs.opendir(`/proc/self/fd/${dir.fd}`, { encoding: 'buffer' });
        for await (const item of listing) {
          if (++entries > maxEntries || depth + 1 > maxDepth) throw unsafe();
          const raw = item.name;
          const name = raw.toString('utf8');
          if (!Buffer.from(name).equals(raw) || name.includes('/') || name === '.' || name === '..') throw unsafe();
          const childPath = relative ? `${relative}/${name}` : name;
          const probe = await fs.lstat(anchor(dir, name), { bigint: true });
          const directory = probe.isDirectory();
          if (!directory && (!probe.isFile() || probe.nlink !== 1n)) throw unsafe();
          const child = await openEntry(dir, name, directory, mount, guard);
          try {
            if (!same(probe, child.stat)) throw unsafe();
            if (directory) {
              await walk(child.handle, childPath, depth + 1, child.stat);
            } else {
              if (++files > maxFiles || bytes + child.stat.size > BigInt(maxBytes)) throw unsafe();
              const hash = createHash('sha256');
              const buffer = Buffer.allocUnsafe(64 * 1024);
              let readTotal = 0n;
              for (;;) {
                const { bytesRead } = await child.handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                readTotal += BigInt(bytesRead);
                if (bytes + readTotal > BigInt(maxBytes) || readTotal > child.stat.size) throw unsafe();
                hash.update(buffer.subarray(0, bytesRead));
                if (onChunk) await onChunk();
              }
              if (readTotal !== child.stat.size) throw unsafe();
              bytes += readTotal;
              await verify(dir, name, child.handle, child.stat);
              manifest.push({ ...metadata(childPath, 'regular', child.stat), sha256: hash.digest('hex') });
            }
            await verify(dir, name, child.handle, child.stat);
          } finally { await child.handle.close(); }
        }
        if (!same(initial, await dir.stat({ bigint: true }))) throw unsafe();
      }

      await walk(current, '', 0, await current.stat({ bigint: true }));
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const entry = ancestors[i];
        await verifyPathEntry(entry.parent, entry.name, entry.handle, entry.stat, i === ancestors.length - 1 ? same : sameAncestor, guard);
      }
      manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      return manifest;
    } finally {
      for (const entry of ancestors.reverse()) await entry.handle.close();
      await base.close();
    }
  } catch {
    throw unsafe();
  }
}
