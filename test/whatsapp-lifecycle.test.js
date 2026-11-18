import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await fs.mkdtemp(join(tmpdir(), 'wa-lifecycle-'));
process.env.DATA_DIR = dir;
const { createWhatsAppManager } = await import('../src/whatsapp.js');
const { createFencedAuthStore } = await import('../src/fenced-auth-store.js');
const { DisconnectReason } = await import('@whiskeysockets/baileys');
const id = '11111111-1111-4111-8111-111111111111';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = () => new Promise(resolve => setImmediate(resolve));
const sockets = () => {
  const all = [];
  return { all, makeSocket: ({ auth }) => {
    const socket = { ev: new EventEmitter(), auth, ends: 0, async end() { this.ends++; }, async groupFetchAllParticipating() { return {}; } };
    all.push(socket);
    return socket;
  } };
};
test.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test('fence during mkdir or auth initialization waits and prevents a socket', async () => {
  for (const phase of ['mkdir', 'store']) {
    const entered = defer(), release = defer(), made = sockets();
    let storeFences = 0;
    const manager = createWhatsAppManager({ root: dir, ...made,
      makeDir: async () => { if (phase === 'mkdir') { entered.resolve(); await release.promise; } },
      createStore: async () => {
        if (phase === 'store') { entered.resolve(); await release.promise; }
        return { state: {}, saveCreds: async () => {}, fence: async () => { storeFences++; } };
      }
    });
    const start = manager.connect(id);
    await entered.promise;
    let finished = false;
    const fence = manager.fenceAccount(id).then(() => { finished = true; });
    await assert.rejects(manager.connect(id), /tidak tersedia/);
    await wait();
    assert.equal(finished, false);
    release.resolve();
    await Promise.all([start, fence]);
    assert.equal(made.all.length, 0);
    assert.equal(storeFences > 0, phase === 'store');
  }
});

test('fence drains real store IO, rejects later crypto IO and ignores stale events', async () => {
  const entered = defer(), release = defer(), made = sockets();
  const calls = [];
  const manager = createWhatsAppManager({ root: dir, ...made, createStore: folder => createFencedAuthStore(folder, { fs: {
    ...fs, writeFile: async (file, ...args) => { calls.push(file); entered.resolve(); await release.promise; return fs.writeFile(file, ...args); }
  } }) });
  await manager.connect(id);
  const socket = made.all[0];
  socket.ev.emit('connection.update', { connection: 'open' });
  socket.ev.emit('creds.update', {});
  await entered.promise;
  let finished = false;
  const fence = manager.fenceAccount(id).then(() => { finished = true; });
  socket.ev.emit('creds.update', {});
  socket.ev.emit('connection.update', { connection: 'open' });
  await assert.rejects(socket.auth.keys.set({ session: { late: { n: 1 } } }), /fenced/);
  await wait();
  assert.equal(finished, false);
  release.resolve();
  await fence;
  assert.equal(calls.length, 1);
  assert.equal(socket.ends, 1);
  assert.equal(manager.state(id).status, 'disconnected');
  assert.throws(() => manager.socketFor(id), /tidak terhubung/);
  await assert.rejects(socket.auth.keys.get('session', ['late']), /fenced/);
});

test('reconnect retires prior generation and a fence suppresses its retry', async () => {
  const made = sockets(), stores = [];
  const manager = createWhatsAppManager({ root: dir, ...made, retryDelay: 5, createStore: async () => {
    const store = { state: {}, fences: 0, saveCreds: async () => {}, async fence() { this.fences++; } };
    stores.push(store); return store;
  } });
  await manager.connect(id);
  const old = made.all[0];
  old.ev.emit('connection.update', { connection: 'close' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(made.all.length, 2);
  assert.equal(old.ends, 1);
  assert.ok(stores[0].fences);
  old.ev.emit('connection.update', { connection: 'open' });
  assert.equal(manager.state(id).status, 'connecting');
  made.all[1].ev.emit('connection.update', { connection: 'close' });
  await manager.fenceAccount(id);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(made.all.length, 2);
  assert.equal(made.all[1].ends, 1);
});

test('repair waits for removal and fence prevents restart during removal', async () => {
  const made = sockets(), entered = defer(), release = defer();
  const manager = createWhatsAppManager({ root: dir, ...made,
    createStore: async () => ({ state: {}, saveCreds: async () => {}, fence: async () => {} }),
    removeDir: async () => { entered.resolve(); await release.promise; }
  });
  await manager.connect(id);
  made.all[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  const repair = manager.repair(id);
  await entered.promise;
  await assert.rejects(manager.connect(id), /tidak tersedia/);
  let finished = false;
  const fence = manager.fenceAccount(id).then(() => { finished = true; });
  await wait();
  assert.equal(finished, false);
  release.resolve();
  await Promise.all([repair, fence]);
  assert.equal(made.all.length, 1);
  await assert.rejects(manager.connect(id), /tidak tersedia/);
});

test('successful repair fences and ends the old generation before removal and reconnect', async () => {
  const made = sockets(), order = [];
  const manager = createWhatsAppManager({ root: dir, ...made,
    createStore: async () => ({ state: {}, saveCreds: async () => {}, fence: async () => { order.push('fence'); } }),
    removeDir: async () => { assert.equal(made.all[0].ends, 1); order.push('remove'); }
  });
  await manager.connect(id);
  made.all[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await manager.repair(id);
  assert.equal(made.all.length, 2);
  assert.ok(order.indexOf('fence') < order.indexOf('remove'));
  await manager.fenceAccount(id);
});

test('failed repair and initialization fail closed', async () => {
  const made = sockets();
  const manager = createWhatsAppManager({ root: dir, ...made,
    createStore: async () => ({ state: {}, saveCreds: async () => {}, fence: async () => {} }),
    removeDir: async () => { throw new Error('remove failed'); }
  });
  await manager.connect(id);
  made.all[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await assert.rejects(manager.repair(id), /remove failed/);
  await assert.rejects(manager.connect(id), /tidak tersedia/);
  const failed = createWhatsAppManager({ root: dir, ...made, createStore: async () => { throw new Error('corrupt auth'); } });
  await assert.rejects(failed.connect(id), /corrupt auth/);
  await assert.rejects(failed.connect(id), /tidak tersedia/);
});

test('late QR and group responses do not restore access after a fence', async () => {
  const made = sockets(), qr = defer(), groups = defer();
  const manager = createWhatsAppManager({ root: dir, ...made, toQR: () => qr.promise,
    createStore: async () => ({ state: {}, saveCreds: async () => {}, fence: async () => {} }) });
  await manager.connect(id);
  const socket = made.all[0];
  socket.groupFetchAllParticipating = () => groups.promise;
  socket.ev.emit('connection.update', { qr: 'fake' });
  socket.ev.emit('connection.update', { connection: 'open' });
  const request = manager.groups(id);
  const rejected = assert.rejects(request, /tidak terhubung/);
  await wait();
  await manager.fenceAccount(id);
  qr.resolve('data:fake');
  groups.resolve({ group: { id: 'group', subject: 'test' } });
  await rejected;
  await wait();
  assert.deepEqual(manager.state(id), { status: 'disconnected', qr: null });
});

test('credential write failure is handled and blocks the account', async () => {
  const made = sockets(), errors = [];
  const manager = createWhatsAppManager({ root: dir, ...made, onError: error => errors.push(error), createStore: async () => ({
    state: {}, saveCreds: async () => { throw new Error('write failure'); }, fence: async () => {}
  }) });
  await manager.connect(id);
  made.all[0].ev.emit('creds.update', {});
  await wait(); await wait();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'Gagal menyimpan kredensial WhatsApp');
  assert.doesNotMatch(errors[0].message, /write failure/);
  await assert.rejects(manager.connect(id), /tidak tersedia/);
  assert.equal(made.all[0].ends, 1);
});
