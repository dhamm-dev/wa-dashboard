import { open, lstat } from 'node:fs/promises';

const limit = 4 * 1024 * 1024;

function deviceParts(dev) {
  return {
    major: ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n),
    minor: (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n),
  };
}

export async function holdsExclusiveFlock(lockPath) {
  if (process.platform !== 'linux' || typeof lockPath !== 'string' || !lockPath.startsWith('/')) return false;
  let handle;
  try {
    const before = await lstat(lockPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        before.uid !== BigInt(process.geteuid()) || (before.mode & 0o077n) !== 0n) return false;
    handle = await open('/proc/locks', 'r');
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) return false;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const device = deviceParts(before.dev);
    const found = Buffer.concat(chunks).toString('utf8').split('\n').some(line => {
      const match = /^\s*\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([\da-f]+):([\da-f]+):(\d+)\s+0\s+EOF\s*$/i.exec(line);
      return match && Number(match[1]) === process.pid && BigInt(`0x${match[2]}`) === device.major &&
        BigInt(`0x${match[3]}`) === device.minor && BigInt(match[4]) === before.ino;
    });
    const after = await lstat(lockPath, { bigint: true });
    return Boolean(found && after.isFile() && after.dev === before.dev && after.ino === before.ino &&
      after.uid === before.uid && after.mode === before.mode && after.nlink === 1n);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
