import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { safeInventory, inodeGuard } from './safe-inventory.mjs';

const dirs = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const files = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd, name) => `/proc/self/fd/${fd.fd}/${name}`;
const failure = () => Object.assign(new Error('Clone failed; a private partial clone may remain'), { code: 'ECLONE' });
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const matches = (s, m) => (m.device === undefined || s.dev.toString() === m.device) &&
  s.ino.toString() === m.inode && s.size.toString() === m.size &&
  s.mtimeNs.toString() === m.mtimeNs && Number(s.mode & 0o7777n) === m.mode;

async function mountId(fd) {
  const info = await fs.readFile(`/proc/self/fdinfo/${fd.fd}`, 'utf8');
  const match = /^mnt_id:\s*(\d+)\s*$/m.exec(info);
  if (!match) throw failure();
  return match[1];
}

async function openChecked(parent, name, directory, mount, guard, compare = same) {
  const before = await fs.lstat(at(parent, name), { bigint: true });
  if (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n) throw failure();
  await guard.before(at(parent, name), before, compare);
  const fd = await fs.open(at(parent, name), directory ? dirs : files);
  try {
    const stat = await fd.stat({ bigint: true });
    guard.check(stat);
    if (!compare(before, stat) || !compare(stat, await fs.lstat(at(parent, name), { bigint: true })) ||
        (mount && await mountId(fd) !== mount)) throw failure();
    if (compare === identity) {
      const reopened = await fs.open(at(parent, name), dirs);
      try {
        const current = await reopened.stat({ bigint: true });
        guard.check(current);
        if (!identity(stat, current) || !identity(current, await fs.lstat(at(parent, name), { bigint: true })) ||
            await mountId(fd) !== await mountId(reopened)) throw failure();
      } finally { await reopened.close(); }
    }
    return { fd, stat };
  } catch (error) { await fd.close(); throw error; }
}

async function verify(parent, name, entry) {
  if (!same(entry.stat, await entry.fd.stat({ bigint: true })) ||
      !same(entry.stat, await fs.lstat(at(parent, name), { bigint: true }))) throw failure();
}

// Linux only. The caller must maintain quiescence throughout; this is not an atomic snapshot
// or a guarantee against an adversarial process running under the same UID. On failure,
// any private partial destination is deliberately retained for the caller to inspect.
export async function safeClone(options = {}) {
  const handles = [];
  try {
    const { source, destination, isQuiescent, maxDepth, maxFiles, maxEntries, maxBytes, onChunk, forbiddenInodes, onBeforeOpen } = options;
    const guard = inodeGuard(forbiddenInodes, onBeforeOpen);
    if (process.platform !== 'linux' || typeof isQuiescent !== 'function' ||
        (onChunk !== undefined && typeof onChunk !== 'function')) throw failure();
    for (const value of [source, destination]) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
          path.normalize(value) !== value || value === '/' || value.split('/').length > 130) throw failure();
    }
    if (await fs.realpath(source) !== source || destination === source || destination.startsWith(`${source}/`)) throw failure();
    if (await isQuiescent() !== true) throw failure();
    const scanOptions = { callerGuardAndRescan: true, maxDepth, maxFiles, maxEntries, maxBytes, forbiddenInodes: guard.inodes, onBeforeOpen };
    const before = await safeInventory({ root: source, ...scanOptions });
    const rootStat = await fs.lstat('/', { bigint: true });
    await guard.before('/', rootStat, identity);
    const root = await fs.open('/', dirs); handles.push(root);
    const openedRoot = await root.stat({ bigint: true });
    guard.check(openedRoot);
    if (!identity(rootStat, openedRoot) || !identity(openedRoot, await fs.lstat('/', { bigint: true }))) throw failure();
    const links = [];
    async function resolve(directory, rejectIdentity) {
      let parent = root;
      const parts = directory.split('/').filter(Boolean);
      for (const [index, name] of parts.entries()) {
        const compare = !rejectIdentity && index === parts.length - 1 ? same : identity;
        const entry = await openChecked(parent, name, true, undefined, guard, compare);
        handles.push(entry.fd);
        links.push({ parent, name, ...entry });
        if (rejectIdentity && identity(entry.stat, rejectIdentity)) throw failure();
        parent = entry.fd;
      }
      return parent;
    }
    const src = await resolve(source);
    const srcStat = await src.stat({ bigint: true });
    if (!matches(srcStat, before[0])) throw failure();
    const mount = await mountId(src);
    const parent = await resolve(path.dirname(destination), srcStat);
    const name = path.basename(destination);
    await fs.mkdir(at(parent, name), { mode: 0o700 });
    const target = await openChecked(parent, name, true, undefined, guard); handles.push(target.fd);
    await target.fd.chmod(0o700);
    const targetMount = await mountId(target.fd);
    const children = new Map();
    for (const item of before.slice(1)) {
      const index = item.path.lastIndexOf('/');
      const dir = index < 0 ? '' : item.path.slice(0, index);
      if (!children.has(dir)) children.set(dir, []);
      children.get(dir).push(item);
    }
    async function copyDir(srcDir, dstDir, relative) {
      for (const item of children.get(relative) || []) {
        const basename = item.path.slice(relative ? relative.length + 1 : 0);
        const entry = await openChecked(srcDir, basename, item.type === 'dir', mount, guard);
        try {
          if (!matches(entry.stat, item)) throw failure();
          if (item.type === 'dir') {
            await fs.mkdir(at(dstDir, basename), { mode: 0o700 });
            const dest = await openChecked(dstDir, basename, true, targetMount, guard);
            try { await dest.fd.chmod(0o700); await copyDir(entry.fd, dest.fd, item.path); await dest.fd.sync(); }
            finally { await dest.fd.close(); }
          } else {
            await guard.absent(at(dstDir, basename));
            const dest = await fs.open(at(dstDir, basename), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, item.mode & 0o700);
            try {
              guard.check(await dest.stat({ bigint: true }));
              await dest.chmod(item.mode & 0o700);
              const hash = createHash('sha256');
              const buffer = Buffer.allocUnsafe(64 * 1024);
              let total = 0n;
              for (;;) {
                const { bytesRead } = await entry.fd.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                total += BigInt(bytesRead);
                if (total > entry.stat.size) throw failure();
                hash.update(buffer.subarray(0, bytesRead));
                let written = 0;
                while (written < bytesRead) {
                  const result = await dest.write(buffer, written, bytesRead - written, null);
                  if (!result.bytesWritten) throw failure();
                  written += result.bytesWritten;
                }
                if (onChunk) await onChunk();
              }
              if (total !== entry.stat.size || hash.digest('hex') !== item.sha256) throw failure();
              const destStat = await dest.stat({ bigint: true });
              if (!destStat.isFile() || destStat.nlink !== 1n || destStat.size !== total ||
                  await mountId(dest) !== targetMount) throw failure();
              const destHash = createHash('sha256');
              let offset = 0;
              for (;;) {
                const { bytesRead } = await dest.read(buffer, 0, buffer.length, offset);
                if (!bytesRead) break;
                offset += bytesRead;
                if (BigInt(offset) > total) throw failure();
                destHash.update(buffer.subarray(0, bytesRead));
              }
              if (BigInt(offset) !== total || destHash.digest('hex') !== item.sha256 ||
                  !same(destStat, await dest.stat({ bigint: true })) ||
                  !same(destStat, await fs.lstat(at(dstDir, basename), { bigint: true }))) throw failure();
              await dest.sync();
            } finally { await dest.close(); }
          }
          await verify(srcDir, basename, entry);
        } finally { await entry.fd.close(); }
      }
      const actual = await fs.readdir(`/proc/self/fd/${dstDir.fd}`, { encoding: 'buffer' });
      const expected = (children.get(relative) || []).map(item => item.path.slice(relative ? relative.length + 1 : 0)).sort();
      const names = actual.map(raw => {
        const name = raw.toString('utf8');
        if (!Buffer.from(name).equals(raw)) throw failure();
        return name;
      }).sort();
      if (JSON.stringify(names) !== JSON.stringify(expected)) throw failure();
      await dstDir.sync();
    }
    await copyDir(src, target.fd, '');
    const after = await safeInventory({ root: source, ...scanOptions });
    if (JSON.stringify(before) !== JSON.stringify(after)) throw failure();
    await parent.sync();
    if (await isQuiescent() !== true) throw failure();
    for (const link of [...links, { parent, name, ...target }]) {
      if (!identity(link.stat, await link.fd.stat({ bigint: true })) ||
          !identity(link.stat, await fs.lstat(at(link.parent, link.name), { bigint: true }))) throw failure();
      const reopened = await fs.open(at(link.parent, link.name), dirs);
      try {
        const current = await reopened.stat({ bigint: true });
        guard.check(current);
        if (!identity(link.stat, current) || !identity(current, await fs.lstat(at(link.parent, link.name), { bigint: true })) ||
            await mountId(link.fd) !== await mountId(reopened)) throw failure();
      } finally { await reopened.close(); }
    }
    return { files: before.filter(item => item.type === 'regular').length, entries: before.length - 1 };
  } catch { throw failure(); }
  finally { for (const handle of handles.reverse()) await handle.close().catch(() => {}); }
}
