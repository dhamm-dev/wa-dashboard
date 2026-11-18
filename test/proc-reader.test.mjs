import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProcReader } from '../tools/proc-reader.mjs';
import { writerCensus } from '../tools/writer-census.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-reader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const translate = p => {
    assert.ok(p === '/proc' || p.startsWith('/proc/'));
    return path.join(root, p.slice(5));
  };
  const io = {
    readdir: p => fs.readdir(translate(p)),
    open: (p, ...args) => fs.open(translate(p), ...args),
    stat: (p, ...args) => fs.stat(translate(p), ...args)
  };
  const makeProcess = async (pid, comm = 'odd ) name (thing)') => {
    const dir = path.join(root, String(pid));
    await fs.mkdir(path.join(dir, 'fd'), { recursive: true });
    const fields = Array(19).fill('0');
    fields[18] = '12345678901234567890';
    await fs.writeFile(path.join(dir, 'stat'), `${pid} (${comm}) S ${fields.join(' ')}\n`);
    await fs.writeFile(path.join(dir, 'status'), 'Name:\tignored\nUid:\t1000\t1001\t1002\t1003\n');
  };
  return { root, io, makeProcess, reader: createProcReader({ fixture: { fs: io } }) };
}

test('reads stable synthetic process identities and descriptor inode metadata', async t => {
  const f = await setup(t);
  await f.makeProcess(12, 'strange ) S 1 ( and newline\nname');
  await fs.writeFile(path.join(f.root, 'target'), 'not inspected');
  await fs.symlink(path.join(f.root, 'target'), path.join(f.root, '12/fd/3'));
  await fs.writeFile(path.join(f.root, 'non-numeric'), 'ignored');
  const target = await fs.stat(path.join(f.root, 'target'), { bigint: true });
  assert.deepEqual(await f.reader.listProcesses(), [12]);
  assert.deepEqual(await f.reader.processInfo(12), { pid: 12, uid: 1000, startTime: 12345678901234567890n });
  assert.deepEqual(await f.reader.listFds(12), [3]);
  assert.deepEqual(await f.reader.statFd(12, 3), { dev: target.dev, ino: target.ino });
  assert.deepEqual(await writerCensus({ reader: f.reader, inventory: [{ dev: target.dev, ino: target.ino }], selfPid: 12, proveNonWriter: async () => false }), { complete: true, externalWriters: 1 });
});

test('rejects malformed names, unsafe arguments, stat and status data', async t => {
  const f = await setup(t);
  await f.makeProcess(1);
  for (const pid of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, '../1']) {
    await assert.rejects(f.reader.processInfo(pid), { message: 'Process inspection unavailable' });
  }
  for (const fd of [-1, '3', 1.1, Infinity]) await assert.rejects(f.reader.statFd(1, fd));
  await fs.mkdir(path.join(f.root, '01'));
  await assert.rejects(f.reader.listProcesses());
  await fs.rm(path.join(f.root, '01'), { recursive: true });
  await fs.writeFile(path.join(f.root, '1/fd/9007199254740992'), '');
  await assert.rejects(f.reader.listFds(1));
  await fs.writeFile(path.join(f.root, '1/stat'), '1 (bad) S 0\n');
  await assert.rejects(f.reader.processInfo(1));
  await f.makeProcess(1);
  const stat = await fs.readFile(path.join(f.root, '1/stat'), 'utf8');
  await fs.writeFile(path.join(f.root, '1/stat'), stat.replace(/^1 /, '2 '));
  await assert.rejects(f.reader.processInfo(1), { message: 'Process inspection unavailable' });
  await f.makeProcess(1);
  await fs.writeFile(path.join(f.root, '1/status'), 'Uid: 1000 1000 1000 1000\nUid: 0 0 0 0\n');
  await assert.rejects(f.reader.processInfo(1));
});

test('mock proc reader and census verify the expected holder without disclosing identity', async () => {
  const fields = Array(19).fill('0');
  fields[18] = '98765432123456789';
  const files = new Map([
    ['/proc/41831/stat', `41831 (self) S ${fields.join(' ')}\n`],
    ['/proc/52942/stat', `52942 (holder) S ${fields.join(' ')}\n`],
    ['/proc/41831/status', 'Uid: 1000 1000 1000 1000\n'],
    ['/proc/52942/status', 'Uid: 1001 1001 1001 1001\n']
  ]);
  const io = {
    readdir: async dir => ({ '/proc': ['41831', '52942'], '/proc/41831/fd': [], '/proc/52942/fd': ['0'] })[dir],
    open: async file => {
      const content = Buffer.from(files.get(file));
      let offset = 0;
      return {
        read: async (buffer, start, length) => {
          const bytesRead = content.copy(buffer, start, offset, offset + length);
          offset += bytesRead;
          return { bytesRead };
        },
        close: async () => {}
      };
    },
    stat: async file => {
      assert.equal(file, '/proc/52942/fd/0');
      return { dev: 12n, ino: 34n };
    }
  };
  const reader = createProcReader({ fixture: { fs: io } });
  const options = { reader, inventory: [{ dev: 12n, ino: 34n }], selfPid: 41831,
    expectedHolder: { pid: 52942, uid: 1001, startTime: 98765432123456789n }, proveNonWriter: async () => false };
  const calls = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...args) => calls.push(args);
  try {
    assert.deepEqual(await writerCensus(options), { complete: true, externalWriters: 1, expectedIsSoleHolder: true });
    assert.deepEqual(await writerCensus({ ...options, expectedHolder: { ...options.expectedHolder, uid: 1000 } }),
      { complete: true, externalWriters: 1, expectedIsSoleHolder: false });
    assert.deepEqual(calls, []);
  } finally {
    console.log = log;
    console.error = error;
  }
});

test('access failures, disappearance and budgets fail closed without leaking adapter errors', async t => {
  const f = await setup(t);
  await f.makeProcess(1);
  for (const code of ['EACCES', 'ENOENT']) {
    const io = { ...f.io, readdir: async () => { const e = new Error('secret /private/path'); e.code = code; throw e; } };
    const reader = createProcReader({ fixture: { fs: io } });
    await assert.rejects(reader.listProcesses(), e => e.message === 'Process inspection unavailable' && !e.code && !e.cause);
    assert.deepEqual(await writerCensus({ reader, inventory: [{ dev: 1, ino: 2 }], selfPid: 1, proveNonWriter: async () => false }), { complete: false, externalWriters: null });
  }
  await assert.rejects(f.reader.statFd(1, 4), { message: 'Process inspection unavailable' });
  const limited = createProcReader({ fixture: { fs: f.io }, limits: { maxOperations: 1 } });
  assert.deepEqual(await limited.listProcesses(), [1]);
  await assert.rejects(limited.listProcesses());
  const tiny = createProcReader({ fixture: { fs: f.io }, limits: { maxFileBytes: 8 } });
  await assert.rejects(tiny.processInfo(1));
});
