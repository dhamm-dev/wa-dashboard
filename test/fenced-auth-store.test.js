import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proto, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { createFencedAuthStore } from '../src/fenced-auth-store.js';

async function directory(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'fenced-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('round-trips synthetic credentials and keys in both directions with Baileys', async (t) => {
  const dir = await directory(t);
  const stock = await useMultiFileAuthState(dir);
  stock.state.creds.synthetic = { bytes: Buffer.from([0, 1, 255]) };
  await stock.saveCreds();
  await stock.state.keys.set({
    session: { 'a/b:c': { bytes: Buffer.from([1, 2, 3]) } },
    'app-state-sync-key': { first: { keyData: Buffer.from([4, 5]), fingerprint: { rawId: 7 }, timestamp: 42 } }
  });
  const store = await createFencedAuthStore(dir);
  assert.deepEqual(store.state.creds.synthetic.bytes, Buffer.from([0, 1, 255]));
  assert.deepEqual((await store.state.keys.get('session', ['a/b:c', 'missing'])), {
    'a/b:c': { bytes: Buffer.from([1, 2, 3]) }, missing: null
  });
  const key = (await store.state.keys.get('app-state-sync-key', ['first'])).first;
  assert.ok(key instanceof proto.Message.AppStateSyncKeyData);
  assert.deepEqual(Buffer.from(key.keyData), Buffer.from([4, 5]));
  assert.ok((await fs.readdir(dir)).includes('session-a__b-c.json'));
  const creds = store.state.creds;
  creds.synthetic.bytes = Buffer.from([9, 8]);
  await store.saveCreds();
  assert.equal(store.state.creds, creds);
  await store.state.keys.set({
    session: { 'a/b:c': null, 'x/y:z': { bytes: Buffer.from([6]) } },
    'app-state-sync-key': { second: proto.Message.AppStateSyncKeyData.fromObject({ keyData: Buffer.from([7, 8]) }) }
  });
  const reopened = await useMultiFileAuthState(dir);
  assert.deepEqual(reopened.state.creds.synthetic.bytes, Buffer.from([9, 8]));
  assert.deepEqual(await reopened.state.keys.get('session', ['a/b:c', 'x/y:z']), {
    'a/b:c': null, 'x/y:z': { bytes: Buffer.from([6]) }
  });
  const reopenedKey = (await reopened.state.keys.get('app-state-sync-key', ['second'])).second;
  assert.ok(reopenedKey instanceof proto.Message.AppStateSyncKeyData);
  assert.deepEqual(Buffer.from(reopenedKey.keyData), Buffer.from([7, 8]));
  await store.fence();
});

test('fence drains an active syscall, stops remaining and queued operations, and rejects retries', async (t) => {
  const dir = await directory(t);
  const entered = deferred();
  const release = deferred();
  const writes = [];
  const store = await createFencedAuthStore(dir, { fs: {
    ...fs,
    writeFile: async (file, ...args) => {
      writes.push(file);
      entered.resolve();
      await release.promise;
      return fs.writeFile(file, ...args);
    }
  } });
  const active = store.state.keys.set({ session: { first: { n: 1 }, second: { n: 2 } } });
  const queued = store.saveCreds();
  const activeResult = assert.rejects(active, /fenced/);
  const queuedResult = assert.rejects(queued, /fenced/);
  await entered.promise;
  let drained = false;
  const fence = store.fence().then(() => { drained = true; });
  await assert.rejects(store.state.keys.get('session', ['first']), /fenced/);
  await assert.rejects(store.state.keys.set({ session: { retry: { n: 3 } } }), /fenced/);
  await assert.rejects(store.saveCreds(), /fenced/);
  assert.equal(drained, false);
  release.resolve();
  await Promise.all([activeResult, queuedResult, fence, store.fence()]);
  assert.equal(drained, true);
  assert.deepEqual(writes.map((file) => file.slice(dir.length + 1)), ['session-first.json']);
  assert.deepEqual(await fs.readdir(dir), ['session-first.json']);
});

test('a failed operation does not break serialization or let delayed retries pass a fence', async (t) => {
  const dir = await directory(t);
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const store = await createFencedAuthStore(dir, { fs: {
    ...fs,
    writeFile: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      throw new Error('write failed');
    }
  } });
  const first = store.saveCreds();
  const failure = assert.rejects(first, /write failed/);
  const next = store.saveCreds();
  const blocked = assert.rejects(next, /fenced/);
  await entered.promise;
  const retry = first.catch(() => store.saveCreds());
  const retryBlocked = assert.rejects(retry, /fenced/);
  const fence = store.fence();
  release.resolve();
  await Promise.all([failure, blocked, retryBlocked, fence]);
  assert.equal(calls, 1);
});

test('serialization continues after an error before fencing', async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const store = await createFencedAuthStore(dir, { fs: {
    ...fs,
    writeFile: async (...args) => {
      if (++calls === 1) throw new Error('write failed');
      return fs.writeFile(...args);
    }
  } });
  const first = store.saveCreds();
  const second = store.saveCreds();
  await assert.rejects(first, /write failed/);
  await second;
  assert.equal(calls, 2);
  await store.fence();
});

test('corrupt credentials and key files fail closed', async (t) => {
  const dir = await directory(t);
  await fs.writeFile(join(dir, 'creds.json'), '{invalid');
  await assert.rejects(createFencedAuthStore(dir), SyntaxError);
  assert.equal(await fs.readFile(join(dir, 'creds.json'), 'utf8'), '{invalid');

  await fs.unlink(join(dir, 'creds.json'));
  const store = await createFencedAuthStore(dir);
  await fs.writeFile(join(dir, 'session-bad.json'), '{invalid');
  await assert.rejects(store.state.keys.get('session', ['bad']), SyntaxError);
  assert.deepEqual(await store.state.keys.get('session', ['missing']), { missing: null });
  await store.fence();
  await assert.rejects(store.state.keys.get('session', ['bad']), /fenced/);
});

test('read permission errors propagate during initialization and key access', async (t) => {
  const dir = await directory(t);
  const denied = Object.assign(new Error('read denied'), { code: 'EACCES' });
  const deniedFs = { ...fs, readFile: async () => { throw denied; } };
  await assert.rejects(createFencedAuthStore(dir, { fs: deniedFs }), (error) => error === denied);

  const store = await createFencedAuthStore(dir, { fs: {
    ...fs,
    readFile: async (file, ...args) => {
      if (file.endsWith('session-denied.json')) throw denied;
      return fs.readFile(file, ...args);
    }
  } });
  await assert.rejects(store.state.keys.get('session', ['denied']), (error) => error === denied);
  await store.fence();
  await assert.rejects(store.state.keys.get('session', ['denied']), /fenced/);
});

test('delete ignores missing files but propagates other errors while fence drains', async (t) => {
  const dir = await directory(t);
  const entered = deferred();
  const release = deferred();
  const denied = Object.assign(new Error('delete denied'), { code: 'EACCES' });
  const calls = [];
  const store = await createFencedAuthStore(dir, { fs: {
    ...fs,
    unlink: async (file) => {
      calls.push(file.slice(dir.length + 1));
      if (file.endsWith('session-denied.json')) {
        entered.resolve();
        await release.promise;
        throw denied;
      }
      return fs.unlink(file);
    }
  } });
  await store.state.keys.set({ session: { missing: null } });
  const operation = store.state.keys.set({ session: { denied: null, later: null } });
  const failed = assert.rejects(operation, (error) => error === denied);
  await entered.promise;
  let drained = false;
  const fence = store.fence().then(() => { drained = true; });
  await assert.rejects(store.state.keys.set({ session: { retry: null } }), /fenced/);
  assert.equal(drained, false);
  release.resolve();
  await Promise.all([failed, fence]);
  assert.equal(drained, true);
  assert.deepEqual(calls, ['session-missing.json', 'session-denied.json']);
});
