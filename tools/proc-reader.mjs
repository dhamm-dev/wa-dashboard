import * as fs from 'node:fs/promises';
import path from 'node:path';

const fail = () => { throw new Error('Process inspection unavailable'); };
const validNumber = (n, positive = false) => Number.isSafeInteger(n) && n >= (positive ? 1 : 0);
const decimal = (s, positive = false) => {
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]*)$/.test(s)) fail();
  const n = Number(s);
  if (!validNumber(n, positive)) fail();
  return n;
};

export function createProcReader({ fixture, limits = {} } = {}) {
  const { maxProcesses = 4096, maxFdsPerProcess = 4096, maxOperations = 100000, maxFileBytes = 65536 } = limits;
  if (![maxProcesses, maxFdsPerProcess, maxOperations, maxFileBytes].every(n => validNumber(n, true)) ||
      maxProcesses > 100000 || maxFdsPerProcess > 100000 || maxOperations > 1000000 || maxFileBytes > 1048576 ||
      (fixture !== undefined && (!fixture || !fixture.fs))) fail();
  const io = fixture ? fixture.fs : fs;
  const root = '/proc';
  let operations = 0;
  const guarded = fn => async (...args) => {
    try {
      if (++operations > maxOperations || (!fixture && (process.platform !== 'linux' || process.geteuid?.() !== 0))) fail();
      return await fn(...args);
    } catch {
      return fail();
    }
  };
  const pidPath = pid => {
    if (!validNumber(pid, true)) fail();
    return path.join(root, String(pid));
  };
  const list = async (dir, maximum, positive) => {
    const entries = await io.readdir(dir);
    if (!Array.isArray(entries)) fail();
    const numbers = [];
    for (const entry of entries) {
      if (typeof entry !== 'string') fail();
      if (!/^[0-9]+$/.test(entry)) continue;
      numbers.push(decimal(entry, positive));
      if (numbers.length > maximum) fail();
    }
    numbers.sort((a, b) => a - b);
    if (numbers.some((n, i) => i && n === numbers[i - 1])) fail();
    return numbers;
  };
  const readBounded = async file => {
    const handle = await io.open(file, 'r');
    try {
      const buffer = Buffer.alloc(maxFileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - length) fail();
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxFileBytes) fail();
      return buffer.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  };
  return {
    listProcesses: guarded(() => list(root, maxProcesses, true)),
    processInfo: guarded(async pid => {
      const dir = pidPath(pid);
      const stat = await readBounded(path.join(dir, 'stat'));
      const match = /^(\d+) \(([\s\S]*)\) ([A-Za-z]) ([\s\S]*)\n?$/.exec(stat);
      if (!match) fail();
      const statPid = decimal(match[1], true);
      if (statPid !== pid) fail();
      const fields = match[4].trim().split(/\s+/);
      if (fields.length < 19 || !/^[0-9]+$/.test(fields[18])) fail();
      const startTime = BigInt(fields[18]);
      const status = await readBounded(path.join(dir, 'status'));
      const uidLines = status.split('\n').filter(line => line.startsWith('Uid:'));
      if (uidLines.length !== 1) fail();
      const uidMatch = /^Uid:\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s*$/.exec(uidLines[0]);
      if (!uidMatch) fail();
      const uid = decimal(uidMatch[1]);
      return { pid: statPid, uid, startTime };
    }),
    listFds: guarded(pid => list(path.join(pidPath(pid), 'fd'), maxFdsPerProcess, false)),
    statFd: guarded(async (pid, fd) => {
      const dir = pidPath(pid);
      if (!validNumber(fd)) fail();
      const result = await io.stat(path.join(dir, 'fd', String(fd)), { bigint: true });
      if (typeof result.dev !== 'bigint' || result.dev < 0n || typeof result.ino !== 'bigint' || result.ino < 0n) fail();
      return { dev: result.dev, ino: result.ino };
    })
  };
}
