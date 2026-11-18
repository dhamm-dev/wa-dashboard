import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const anchored = (dir, name) => `/proc/self/fd/${dir.fd}/${name}`;
const unsafe = () => Object.assign(new Error('Unsafe filesystem object or traversal'), { code: 'EUNSAFE' });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink;

async function mountId(handle) {
  const info = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const match = /^mnt_id:\s*(\d+)\s*$/m.exec(info);
  if (!match) throw unsafe();
  return match[1];
}

async function openChecked(parent, name, directory, mount) {
  const target = anchored(parent, name);
  let before;
  try { before = await fs.lstat(target, { bigint: true }); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n) throw unsafe();
  const handle = await fs.open(target, directory ? dirFlags : fileFlags);
  try {
    const actual = await handle.stat({ bigint: true });
    const after = await fs.lstat(target, { bigint: true });
    if (!same(before, actual) || !same(actual, after) || (mount && await mountId(handle) !== mount)) throw unsafe();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertLinked(parent, name, handle) {
  const actual = await handle.stat({ bigint: true });
  const entry = await fs.lstat(anchored(parent, name), { bigint: true });
  if (!same(actual, entry) || (actual.isFile() && actual.nlink !== 1n)) throw unsafe();
}

async function openDataDir(dataDir) {
  if (process.platform !== 'linux' || typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0')) throw unsafe();
  const parts = dataDir.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw unsafe();
  let current = await fs.open('/', dirFlags);
  try {
    await mountId(current);
    for (const part of parts) {
      const next = await openChecked(current, part, true);
      if (!next) throw Object.assign(new Error('DATA_DIR does not exist'), { code: 'ENOENT' });
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

async function removeFile(parent, name, mount, afterUnlink) {
  const file = await openChecked(parent, name, false, mount);
  if (!file) { await parent.sync(); return; }
  try {
    await assertLinked(parent, name, file);
    await fs.unlink(anchored(parent, name));
    if (afterUnlink) await afterUnlink();
    await parent.sync();
  } finally { await file.close(); }
}

async function removeDirectory(parent, name, kind, mount, afterUnlink) {
  const dir = await openChecked(parent, name, true, mount);
  if (!dir) { await parent.sync(); return; }
  try {
    const entries = await fs.readdir(`/proc/self/fd/${dir.fd}`);
    for (const entry of entries) {
      if (kind === 'sessions' ? !entry.endsWith('.json') || entry === '.json' : entry !== 'data') throw unsafe();
      const file = await openChecked(dir, entry, false, mount);
      if (!file) throw unsafe();
      await file.close();
    }
    await assertLinked(parent, name, dir);
    for (const entry of entries) await removeFile(dir, entry, mount, afterUnlink);
    await dir.sync();
    await assertLinked(parent, name, dir);
    await fs.rmdir(anchored(parent, name));
    await parent.sync();
  } finally { await dir.close(); }
}

export async function cleanupFiles({ dataDir, artifacts, afterUnlink } = {}) {
  if (!Array.isArray(artifacts) || (afterUnlink !== undefined && typeof afterUnlink !== 'function')) throw new TypeError('Invalid cleanup arguments');
  for (const artifact of artifacts) {
    if (!artifact || !['sessions', 'uploads', 'uploads-v2'].includes(artifact.kind) || typeof artifact.id !== 'string' || !uuid.test(artifact.id)) throw new TypeError('Invalid cleanup artifact');
  }
  const root = await openDataDir(dataDir);
  try {
    const mount = await mountId(root);
    for (const { kind, id } of artifacts) {
      const parent = await openChecked(root, kind, true, mount);
      if (!parent) { await root.sync(); continue; }
      try {
        await assertLinked(root, kind, parent);
        if (kind === 'uploads') await removeFile(parent, id, mount, afterUnlink);
        else await removeDirectory(parent, id, kind, mount, afterUnlink);
      } finally { await parent.close(); }
    }
  } finally { await root.close(); }
}
