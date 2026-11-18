import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writerCensus } from '../tools/writer-census.mjs';

const unknown = { complete: false, externalWriters: null };
const target = { dev: 12, ino: 34n };

function fixture() {
  const processes = new Map([
    [1, { uid: 1000, startTime: 10, fds: new Map([[0, { dev: 1, ino: 2 }]]) }],
    [2, { uid: 1001, startTime: 20, fds: new Map([[3, { dev: 12n, ino: 34 }], [4, { dev: 12, ino: 34 }]]) }]
  ]);
  const reader = {
    listProcesses: async () => [...processes.keys()],
    processInfo: async pid => processes.has(pid) ? { ...processes.get(pid), pid } : undefined,
    listFds: async pid => [...processes.get(pid).fds.keys()],
    statFd: async (pid, fd) => processes.get(pid).fds.get(fd)
  };
  return { processes, reader, inventory: [target], selfPid: 1, proveNonWriter: async () => false };
}

test('counts processes holding an inode, including hardlinked and read-only descriptors', async () => {
  const f = fixture();
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 1 });
  f.processes.set(3, { uid: 1001, startTime: 30n, fds: new Map([[9, target]]) });
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 2 });
});

test('expected holder is verified in both passes without returning its identity', async () => {
  const f = fixture();
  f.expectedHolder = { pid: 2n, uid: 1001n, startTime: 20n };
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 1, expectedIsSoleHolder: true });
  f.processes.set(3, { uid: 1001, startTime: 30, fds: new Map([[0, target]]) });
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 2, expectedIsSoleHolder: false });
  f.processes.delete(3);
  f.processes.get(2).fds.clear();
  f.processes.get(1).fds.set(0, target);
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 1, expectedIsSoleHolder: false });
});

test('legacy readers may omit pid and include additional process information', async () => {
  const f = fixture();
  const info = f.reader.processInfo;
  f.reader.processInfo = async pid => {
    const { pid: ignored, ...rest } = await info(pid);
    return { ...rest, extra: 'ignored' };
  };
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 1 });
  assert.deepEqual(await writerCensus({ ...f, expectedHolder: { pid: 2, uid: 1001, startTime: 20 } }),
    { ...unknown, expectedIsSoleHolder: false });
});

test('expected identity, presence and exclusions are checked independently', async () => {
  for (const kind of ['uid', 'startTime', 'reused', 'exited', 'missing-pid', 'wrong-pid', 'excluded']) {
    const f = fixture();
    f.expectedHolder = { pid: 2, uid: 1001, startTime: 20 };
    if (kind === 'uid') f.expectedHolder.uid++;
    if (kind === 'startTime') f.expectedHolder.startTime++;
    if (kind === 'reused') f.processes.get(2).startTime++;
    if (kind === 'exited') f.processes.delete(2);
    if (kind === 'excluded') { f.controllerPids = [2]; f.proveNonWriter = async () => true; }
    if (kind === 'missing-pid' || kind === 'wrong-pid') {
      const info = f.reader.processInfo;
      f.reader.processInfo = async pid => pid === 2 ? { ...(await info(pid)), pid: kind === 'wrong-pid' ? 3 : undefined } : info(pid);
    }
    assert.equal((await writerCensus(f)).expectedIsSoleHolder, false, kind);
  }
  const f = fixture();
  f.expectedHolder = { pid: 1, uid: 1000, startTime: 10 };
  f.skipSelfIfProven = true;
  f.proveNonWriter = async () => true;
  assert.deepEqual(await writerCensus(f), { ...unknown, expectedIsSoleHolder: false });
});

test('expected holder races and unavailable observations fail closed', async () => {
  for (const kind of ['dropped-fd', 'between-passes', 'churn', 'reuse', 'unavailable']) {
    const f = fixture();
    f.expectedHolder = { pid: 2, uid: 1001, startTime: 20 };
    if (kind === 'dropped-fd') {
      const list = f.reader.listFds;
      let calls = 0;
      f.reader.listFds = async pid => pid === 2 && ++calls === 2 ? [] : list(pid);
    }
    if (kind === 'between-passes' || kind === 'churn') {
      const list = f.reader.listProcesses;
      let calls = 0;
      f.reader.listProcesses = async () => {
        if (++calls === 3) {
          if (kind === 'between-passes') f.processes.get(2).fds.clear();
          else f.processes.set(3, { uid: 1, startTime: 3, fds: new Map() });
        }
        return list();
      };
    }
    if (kind === 'reuse') {
      const info = f.reader.processInfo;
      let calls = 0;
      f.reader.processInfo = async pid => pid === 2 && ++calls === 2 ? { ...(await info(pid)), startTime: 21 } : info(pid);
    }
    if (kind === 'unavailable') f.reader.statFd = async () => { throw new Error('/secret identity'); };
    assert.deepEqual(await writerCensus(f), { ...unknown, expectedIsSoleHolder: false }, kind);
  }
});

test('expected holder input and census bounds fail closed', async () => {
  const f = fixture();
  for (const expectedHolder of [null, {}, { pid: 0, uid: 1, startTime: 1 },
    { pid: 9007199254740992n, uid: 1, startTime: 1 }, { pid: 2, uid: -1, startTime: 1 },
    { pid: 2, uid: 1.5, startTime: 1 }, { pid: 2, uid: 1, startTime: -1n },
    { pid: 2, uid: 1, startTime: 1, path: '/secret' }]) {
    assert.deepEqual(await writerCensus({ ...f, expectedHolder }), { ...unknown, expectedIsSoleHolder: false });
  }
  for (const limits of [{ maxProcesses: 100001 }, { maxFdsPerProcess: 100001 },
    { maxOperations: 1000001 }, { timeoutMs: 60001 }, { maxProcesses: 1 },
    { maxFdsPerProcess: 1 }, { maxOperations: 2 }]) {
    assert.deepEqual(await writerCensus({ ...f, expectedHolder: { pid: 2, uid: 1001, startTime: 20 }, limits }), { ...unknown, expectedIsSoleHolder: false });
  }
});

test('only self or allowlisted controllers with affirmative proof can be excluded', async () => {
  const f = fixture();
  f.processes.get(1).fds.set(5, target);
  f.proveNonWriter = async () => true;
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 1 });
  f.controllerPids = [2];
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 0 });
  f.proveNonWriter = async () => false;
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 2 });
});

test('unknown uid, access denial, and vanished descriptors fail closed without leaking errors', async () => {
  for (const failure of ['uid', 'denied', 'exit']) {
    const f = fixture();
    let lists = 0;
    const list = f.reader.listProcesses;
    f.reader.listProcesses = async () => { lists++; return list(); };
    if (failure === 'uid') delete f.processes.get(2).uid;
    if (failure === 'denied') f.reader.listFds = async () => { throw new Error('secret /private/path token'); };
    if (failure === 'exit') f.reader.statFd = async () => { const e = new Error('secret'); e.code = 'ENOENT'; throw e; };
    const result = await writerCensus(f);
    assert.deepEqual(result, unknown);
    assert.ok(lists >= 2);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('process set, PID reuse, descriptor set and inode changes fail closed', async () => {
  for (const kind of ['process', 'pid', 'fd', 'inode']) {
    const f = fixture();
    if (kind === 'process') {
      let calls = 0;
      const original = f.reader.listProcesses;
      f.reader.listProcesses = async () => ++calls === 2 ? [1] : original();
    }
    if (kind === 'pid') {
      let calls = 0;
      const original = f.reader.processInfo;
      f.reader.processInfo = async pid => ({ ...(await original(pid)), startTime: ++calls });
    }
    if (kind === 'fd') {
      let calls = 0;
      const original = f.reader.listFds;
      f.reader.listFds = async pid => ++calls === 2 ? [99] : original(pid);
    }
    if (kind === 'inode') {
      let calls = 0;
      f.reader.statFd = async () => ({ dev: 12, ino: ++calls });
    }
    assert.deepEqual(await writerCensus(f), unknown, kind);
  }
});

test('budgets, invalid inventory, unresolved proof and missing processes fail closed', async () => {
  const f = fixture();
  assert.deepEqual(await writerCensus({ ...f, limits: { maxOperations: 2 } }), unknown);
  assert.deepEqual(await writerCensus({ ...f, inventory: [{ ...target, path: '/secret' }] }), unknown);
  assert.deepEqual(await writerCensus({ ...f, inventory: [] }), unknown);
  assert.deepEqual(await writerCensus({ ...f, selfPid: 99 }), unknown);
  assert.deepEqual(await writerCensus({ ...f, controllerPids: [2], proveNonWriter: () => new Promise(() => {}), limits: { timeoutMs: 10 } }), unknown);
});

test('self scanner transient descriptors require an explicit trusted proof to skip', async () => {
  for (const failure of ['list', 'stat']) {
    const f = fixture();
    const list = f.reader.listFds;
    const stat = f.reader.statFd;
    let selfLists = 0;
    f.reader.listFds = async pid => {
      if (pid === 1) {
        selfLists++;
        if (failure === 'list') throw Object.assign(new Error(), { code: 'ENOENT' });
        return [99];
      }
      return list(pid);
    };
    f.reader.statFd = async (pid, fd) => {
      if (pid === 1) throw Object.assign(new Error(), { code: 'ENOENT' });
      return stat(pid, fd);
    };
    f.proveNonWriter = async () => true;
    assert.deepEqual(await writerCensus(f), unknown, failure);
    selfLists = 0;
    assert.deepEqual(await writerCensus({ ...f, skipSelfIfProven: true }), { complete: true, externalWriters: 1 }, failure);
    assert.equal(selfLists, 0);
    assert.deepEqual(await writerCensus({ ...f, skipSelfIfProven: true, proveNonWriter: async () => false }), unknown);
  }
});

test('self proof and identity must remain valid throughout both passes', async () => {
  for (const failure of ['proof-end', 'proof-second', 'identity-end', 'identity-second', 'missing']) {
    const f = fixture();
    let proofs = 0;
    let identities = 0;
    f.skipSelfIfProven = true;
    f.proveNonWriter = async () => ++proofs !== (failure === 'proof-end' ? 2 : failure === 'proof-second' ? 3 : 0);
    const info = f.reader.processInfo;
    f.reader.processInfo = async pid => {
      const result = await info(pid);
      if (pid !== 1) return result;
      identities++;
      if (failure === 'missing' && identities === 2) return undefined;
      return { ...result, startTime: result.startTime + (identities >= (failure === 'identity-end' ? 2 : failure === 'identity-second' ? 3 : Infinity) ? 1 : 0) };
    };
    assert.deepEqual(await writerCensus(f), unknown, failure);
  }
});

test('skipping self still scans controllers and fails on other disappearing descriptors', async () => {
  const f = fixture();
  f.skipSelfIfProven = true;
  f.controllerPids = [2];
  const proofs = [];
  f.proveNonWriter = async pid => { proofs.push(pid); return true; };
  assert.deepEqual(await writerCensus(f), { complete: true, externalWriters: 0 });
  assert.equal(proofs.filter(pid => pid === 1).length, 4);
  assert.equal(proofs.filter(pid => pid === 2).length, 2);
  f.reader.statFd = async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); };
  assert.deepEqual(await writerCensus(f), unknown);
});
