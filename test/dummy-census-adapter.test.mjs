import test from 'node:test';
import assert from 'node:assert/strict';
import { createDummyCensusAdapter } from '../tools/dummy-census-adapter.mjs';
import { writerCensus } from '../tools/writer-census.mjs';
import { createProcReader } from '../tools/proc-reader.mjs';

const path = '/home/dhexct528dec24/.dummy-db-12345678-1234-4234-8234-123456789abc.sqlite';
const identity = { dev: 12, ino: 34 };
const request = { path, identity, synthetic: true };
const active = () => ({ verified: true, active: true, pid: 101, uid: 999, startTime: 42n, fd0: { ...identity } });
const stopped = () => ({ verified: true, active: false, pid: 0 });
const file = () => ({ ...identity, uid: 999, gid: 983, mode: 0o600, nlink: 1, regular: true, symlink: false });
const unconfirmed = error => error.code === 'OPERATION_UNCONFIRMED' && error.message === 'Dummy DB operation unconfirmed';

function setup({ observations = [active(), active()], stats = [file(), file()], result = { complete: true, externalWriters: 1, expectedIsSoleHolder: true }, scan, guard = () => true } = {}) {
  const calls = [];
  const adapter = createDummyCensusAdapter({ fixturePath: path, identity, reader: {},
    observeTarget: async () => observations.shift(),
    statFixture: async name => { assert.equal(name, path); return stats.shift(); },
    proveNoSelfTargetIo: guard, censusImpl: async options => { calls.push(options); return scan ? scan(options) : result; },
  });
  return { adapter, calls };
}

test('returns only the confirmed expected holder and limits self exclusion to the guard', async () => {
  const { adapter, calls } = setup();
  assert.deepEqual(await adapter(request), { synthetic: true, path, ...identity, complete: true, pids: [101] });
  assert.deepEqual(calls[0].expectedHolder, { pid: 101, uid: 999, startTime: 42n });
  assert.deepEqual(calls[0].inventory, [identity]);
  assert.equal(calls[0].skipSelfIfProven, true);
  assert.equal(await calls[0].proveNonWriter(process.pid), true);
  assert.equal(await calls[0].proveNonWriter(process.pid + 1), false);
});

test('returns empty only when both target observations are stopped and count is zero', async () => {
  const { adapter, calls } = setup({ observations: [stopped(), stopped()], result: { complete: true, externalWriters: 0 } });
  assert.deepEqual(await adapter(request), { synthetic: true, path, ...identity, complete: true, pids: [] });
  assert.equal(Object.hasOwn(calls[0], 'expectedHolder'), false);
});

test('rejects changed process, stale fd0, changed file and ambiguous census', async t => {
  const cases = [
    { observations: [active(), { ...active(), pid: 102 }] },
    { observations: [active(), { ...active(), startTime: 43n }] },
    { observations: [active(), { ...active(), uid: 998 }] },
    { observations: [active(), { ...active(), fd0: { dev: 12, ino: 35 } }] },
    { observations: [active(), stopped()] },
    { stats: [file(), { ...file(), ino: 35 }] },
    { stats: [file(), { ...file(), symlink: true }] },
    { result: { complete: false, externalWriters: 1, expectedIsSoleHolder: true } },
    { result: { complete: true, externalWriters: 2, expectedIsSoleHolder: true } },
    { result: { complete: true, externalWriters: 1, expectedIsSoleHolder: false } },
    { observations: [stopped(), stopped()], result: { complete: true, externalWriters: 1 } },
    { observations: [{ ...stopped(), verified: false }] },
  ];
  for (const [index, item] of cases.entries()) await t.test(String(index), async () => {
    await assert.rejects(setup(item).adapter(request), unconfirmed);
  });
});

test('rejects injected paths and identities before calling observers', async () => {
  let calls = 0;
  const options = { fixturePath: path, identity, reader: {}, observeTarget: () => { calls++; },
    statFixture: () => { calls++; }, censusImpl: () => { calls++; }, proveNoSelfTargetIo: () => true };
  assert.throws(() => createDummyCensusAdapter({ ...options, fixturePath: '/etc/passwd' }), unconfirmed);
  const adapter = createDummyCensusAdapter(options);
  for (const input of [{ ...request, path: '/etc/passwd' }, { ...request, identity: { ...identity, ino: 35 } },
    { ...request, synthetic: false }]) await assert.rejects(adapter(input), unconfirmed);
  assert.equal(calls, 0);
});

test('sanitizes observer and scanner errors', async () => {
  const sensitive = 'private path and pid';
  assert.throws(() => createDummyCensusAdapter({ get fixturePath() { throw Error(sensitive); } }), unconfirmed);
  await assert.rejects(setup({ scan: () => { throw Error(sensitive); } }).adapter(request), unconfirmed);
  const adapter = createDummyCensusAdapter({ fixturePath: path, identity, reader: {}, censusImpl() {},
    proveNoSelfTargetIo: () => true, observeTarget() {}, statFixture() { throw Error(sensitive); } });
  await assert.rejects(adapter(request), unconfirmed);
});

test('requires an affirmative guard before and after the census', async () => {
  assert.throws(() => createDummyCensusAdapter({ fixturePath: path, identity, reader: {},
    censusImpl() {}, observeTarget() {}, statFixture() {} }), unconfirmed);
  for (const guard of [() => false, (() => { let count = 0; return () => ++count === 1; })(),
    () => { throw Error('private path and pid'); }]) {
    await assert.rejects(setup({ guard }).adapter(request), unconfirmed);
  }
});

test('real census and mock proc reader skip self but fail on other disappearing descriptors', async () => {
  const targetPid = process.pid === 101 ? 102 : 101;
  const fields = Array(19).fill('0');
  fields[18] = '42';
  const files = new Map([
    [`/proc/${process.pid}/stat`, `${process.pid} (scanner) S ${fields.join(' ')}\n`],
    [`/proc/${process.pid}/status`, 'Uid: 0 0 0 0\n'],
    [`/proc/${targetPid}/stat`, `${targetPid} (target) S ${fields.join(' ')}\n`],
    [`/proc/${targetPid}/status`, 'Uid: 999 999 999 999\n'],
  ]);
  let disappear = false;
  let guardCalls = 0;
  const io = {
    async readdir(dir) {
      if (dir === '/proc') return [String(process.pid), String(targetPid)];
      if (dir === `/proc/${process.pid}/fd`) throw Error('self descriptor must not be enumerated');
      if (dir === `/proc/${targetPid}/fd`) return ['0'];
      throw Error('private path');
    },
    async open(name) {
      if (!files.has(name)) throw Error('private path');
      const content = Buffer.from(files.get(name));
      let offset = 0;
      return { async read(buffer, start, length) {
        const bytesRead = content.copy(buffer, start, offset, offset + length);
        offset += bytesRead;
        return { bytesRead };
      }, async close() {} };
    },
    async stat(name) {
      if (name !== `/proc/${targetPid}/fd/0` || disappear) throw Error('private fd');
      return { dev: 12n, ino: 34n };
    },
  };
  const makeAdapter = guard => createDummyCensusAdapter({ fixturePath: path, identity,
    reader: createProcReader({ fixture: { fs: io } }), censusImpl: writerCensus,
    statFixture: async () => file(), observeTarget: async () => ({ ...active(), pid: targetPid }),
    proveNoSelfTargetIo: guard });
  assert.deepEqual((await makeAdapter(() => { guardCalls++; return true; })(request)).pids, [targetPid]);
  assert.equal(guardCalls, 6);
  let checks = 0;
  await assert.rejects(makeAdapter(() => ++checks < 4)(request), unconfirmed);
  disappear = true;
  await assert.rejects(makeAdapter(() => true)(request), unconfirmed);
});
