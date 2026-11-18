import { fork } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { safeClone } from './safe-clone.mjs';

const failure = () => Object.assign(new Error('Isolated clone failed; a private partial destination may remain'), { code: 'EISOLATEDCLONE' });
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && value !== '/' && !value.includes('\0') && path.normalize(value) === value;
const within = (file, dir) => file === dir || file.startsWith(`${dir}/`);

async function prepareLock(file) {
  const parts = file.split('/').filter(Boolean);
  let current = '';
  for (const part of parts.slice(0, -1)) {
    current += `/${part}`;
    const s = await fs.lstat(current, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw failure();
  }
  const dir = await fs.lstat(path.dirname(file), { bigint: true });
  if (dir.uid !== BigInt(process.getuid()) || (dir.mode & 0o077n) !== 0n) throw failure();
  try {
    const fd = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await fd.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw failure();
  }
  const s = await fs.lstat(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.uid !== BigInt(process.getuid()) || (s.mode & 0o077n) !== 0n) throw failure();
  const stat = await fs.stat(file, { bigint: true });
  if (s.dev !== stat.dev || s.ino !== stat.ino) throw failure();
  return { dev: stat.dev, ino: stat.ino };
}

function waitForParent(kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(failure()); }, 30000);
    const onMessage = message => {
      if (message?.type !== 'continue' || message.kind !== kind) return;
      cleanup();
      message.ok ? resolve() : reject(failure());
    };
    const onDisconnect = () => { cleanup(); reject(failure()); };
    const cleanup = () => { clearTimeout(timer); process.off('message', onMessage); process.off('disconnect', onDisconnect); };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send({ type: 'checkpoint', kind });
  });
}

async function childRun(options) {
  const { source, destination, lockFile, bounds, chunkCheckpoints, closeUnrelatedFd } = options;
  if (process.platform !== 'linux' || ![source, destination, lockFile].every(absolute) ||
      within(lockFile, source) || within(lockFile, destination)) throw failure();
  const lockInode = await prepareLock(lockFile);
  const unrelated = closeUnrelatedFd ? await fs.open('/dev/null', 'r') : null;
  let db;
  try {
    db = new DatabaseSync(lockFile, { timeout: 0 });
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    if (unrelated) await unrelated.close();
    await waitForParent('locked');
    const result = await safeClone({ source, destination, ...bounds,
      isQuiescent: () => true, forbiddenInodes: [lockInode],
      onChunk: chunkCheckpoints ? () => waitForParent('chunk') : undefined });
    db.exec('COMMIT');
    return result;
  } finally {
    if (db) db.close();
    if (unrelated) await unrelated.close().catch(() => {});
  }
}

// Prototype: only cooperating children share this gate. Caller must independently
// establish quiescence. Same-UID lstat/open replacement races are not prevented.
export function startIsolatedClone({ source, destination, lockFile, callerGuardsQuiescence, bounds = {}, onLocked, onChunk, closeUnrelatedFd = false } = {}) {
  if (callerGuardsQuiescence !== true || ![source, destination, lockFile].every(absolute) ||
      !bounds || typeof bounds !== 'object' || Array.isArray(bounds) ||
      Object.keys(bounds).some(k => !['maxDepth', 'maxFiles', 'maxEntries', 'maxBytes'].includes(k)) ||
      (onLocked !== undefined && typeof onLocked !== 'function') ||
      (onChunk !== undefined && typeof onChunk !== 'function') || typeof closeUnrelatedFd !== 'boolean') throw failure();
  const child = fork(fileURLToPath(import.meta.url), ['--isolated-clone-child'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let response;
  const result = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message?.type === 'result') response = message.result;
      if (message?.type === 'checkpoint' && ['locked', 'chunk'].includes(message.kind)) {
        const callback = message.kind === 'locked' ? onLocked : onChunk;
        Promise.resolve().then(() => callback?.()).then(
          () => { if (child.connected) child.send({ type: 'continue', kind: message.kind, ok: true }); },
          () => { if (child.connected) child.send({ type: 'continue', kind: message.kind, ok: false }); });
      }
    });
    child.on('error', () => {});
    child.on('close', (code, signal) => {
      if (code === 0 && signal === null && response && typeof response === 'object') resolve(response);
      else reject(failure());
    });
    child.send({ source, destination, lockFile, bounds, chunkCheckpoints: Boolean(onChunk), closeUnrelatedFd });
  });
  return { child, result };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--isolated-clone-child' && process.send) {
  process.once('message', async options => {
    try { process.send({ type: 'result', result: await childRun(options) }); }
    catch { process.exitCode = 1; }
    finally { process.disconnect(); }
  });
}
