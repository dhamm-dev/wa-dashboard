import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inodeGuard } from './safe-inventory.mjs';

const dirs = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const files = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd, name) => `/proc/self/fd/${fd.fd}/${name}`;
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const matches = (s, m) => s.ino.toString() === m.inode && s.size.toString() === m.size &&
  s.mtimeNs.toString() === m.mtimeNs && Number(s.mode & 0o7777n) === m.mode;
const fail = () => { throw new Error('Scratch copy failed'); };

async function mountId(fd) {
  const info = await fs.readFile(`/proc/self/fdinfo/${fd.fd}`, 'utf8');
  const match = /^mnt_id:\s*(\d+)\s*$/m.exec(info);
  if (!match) fail();
  return match[1];
}

async function openChecked(parent, name, directory, mount, guard, compare = same) {
  const before = await fs.lstat(at(parent, name), { bigint: true });
  if (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n) fail();
  await guard.before(at(parent, name), before);
  const fd = await fs.open(at(parent, name), directory ? dirs : files);
  try {
    const stat = await fd.stat({ bigint: true });
    guard.check(stat);
    if (!compare(before, stat) || !compare(stat, await fs.lstat(at(parent, name), { bigint: true })) ||
        (mount && await mountId(fd) !== mount)) fail();
    return { fd, stat };
  } catch (error) { await fd.close(); throw error; }
}

export async function copyDbScratch({ source, destination, manifest, forbiddenInodes, onBeforeOpen }) {
  const handles = [];
  try {
    const guard = inodeGuard(forbiddenInodes, onBeforeOpen);
    for (const value of [source, destination]) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') ||
          path.normalize(value) !== value || value === '/' || value.split('/').length > 130) fail();
    }
    if (process.platform !== 'linux' || await fs.realpath(source) !== source ||
        destination === source || destination.startsWith(`${source}/`)) fail();
    const rootStat = await fs.lstat('/', { bigint: true });
    await guard.before('/', rootStat);
    const root = await fs.open('/', dirs); handles.push(root);
    const openedRoot = await root.stat({ bigint: true });
    guard.check(openedRoot);
    if (!identity(rootStat, openedRoot) || !identity(openedRoot, await fs.lstat('/', { bigint: true }))) fail();
    const links = [];
    async function resolve(directory, reject) {
      let parent = root;
      const parts = directory.split('/').filter(Boolean);
      for (const [index, name] of parts.entries()) {
        const entry = await openChecked(parent, name, true, undefined, guard,
          directory === source && index === parts.length - 1 ? same : identity);
        handles.push(entry.fd);
        links.push({ parent, name, ...entry });
        if (reject && identity(entry.stat, reject)) fail();
        parent = entry.fd;
      }
      return parent;
    }
    const src = await resolve(source);
    const srcStat = await src.stat({ bigint: true });
    if (!matches(srcStat, manifest[0])) fail();
    const mount = await mountId(src);
    const parent = await resolve(path.dirname(destination), srcStat);
    const name = path.basename(destination);
    await fs.mkdir(at(parent, name), { mode: 0o700 });
    const target = await openChecked(parent, name, true, undefined, guard); handles.push(target.fd);
    await target.fd.chmod(0o700);
    const targetMount = await mountId(target.fd);
    const selected = manifest.filter(item => ['dashboard.sqlite', 'dashboard.sqlite-wal', 'dashboard.sqlite-shm'].includes(item.path));
    for (const item of selected) {
      if (item.type !== 'regular') fail();
      const entry = await openChecked(src, item.path, false, mount, guard);
      try {
        if (!matches(entry.stat, item)) fail();
        await guard.absent(at(target.fd, item.path));
        const dest = await fs.open(at(target.fd, item.path), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          guard.check(await dest.stat({ bigint: true }));
          await dest.chmod(0o600);
          const hash = createHash('sha256');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let total = 0;
          for (;;) {
            const { bytesRead } = await entry.fd.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            total += bytesRead;
            if (BigInt(total) > entry.stat.size) fail();
            hash.update(buffer.subarray(0, bytesRead));
            for (let written = 0; written < bytesRead;) {
              const result = await dest.write(buffer, written, bytesRead - written, null);
              if (!result.bytesWritten) fail();
              written += result.bytesWritten;
            }
          }
          if (BigInt(total) !== entry.stat.size || hash.digest('hex') !== item.sha256) fail();
          const stat = await dest.stat({ bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(total) || await mountId(dest) !== targetMount) fail();
          const copiedHash = createHash('sha256');
          let offset = 0;
          for (;;) {
            const { bytesRead } = await dest.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) break;
            offset += bytesRead;
            if (offset > total) fail();
            copiedHash.update(buffer.subarray(0, bytesRead));
          }
          if (offset !== total || copiedHash.digest('hex') !== item.sha256 ||
              !same(stat, await dest.stat({ bigint: true })) || !same(stat, await fs.lstat(at(target.fd, item.path), { bigint: true }))) fail();
          await dest.sync();
        } finally { await dest.close(); }
        if (!same(entry.stat, await entry.fd.stat({ bigint: true })) ||
            !same(entry.stat, await fs.lstat(at(src, item.path), { bigint: true }))) fail();
      } finally { await entry.fd.close(); }
    }
    await target.fd.sync();
    await parent.sync();
    const verify = async () => {
      for (const link of [...links, { parent, name, ...target }]) {
        if (!identity(link.stat, await link.fd.stat({ bigint: true })) ||
            !identity(link.stat, await fs.lstat(at(link.parent, link.name), { bigint: true }))) fail();
      }
    };
    await verify();
    return { dbPath: at(target.fd, 'dashboard.sqlite'), verify, close: async () => {
      for (const handle of handles.reverse()) await handle.close().catch(() => {});
    } };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
    throw error;
  }
}
