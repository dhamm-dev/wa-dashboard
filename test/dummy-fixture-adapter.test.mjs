import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { createDummyFixtureAdapter } from '../tools/dummy-fixture-adapter.mjs';

const home = '/home/dhexct528dec24';
const account = { name: 'dhexct528dec24', uid: 999, gid: 983 };
const fixture = () => `${home}/.dummy-db-${randomUUID()}.sqlite`;

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dummy-fixture-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handles = new Set();
  const scratchDirs = new Set();
  const scratchFiles = new Set();
  const map = p => p === home || p === '/home' || p === '/tmp' ? dir : p;
  const scratchPath = p => typeof p === 'string' && (p.includes('/dummy-sqlite-') || [...scratchDirs].some(fd => p.startsWith(`/proc/self/fd/${fd}/`)));
  const stat = (s, directory = false, root = false, tmp = false) => new Proxy(s, { get(target, key) {
    if (key === 'uid') return root ? 0 : 999;
    if (key === 'gid') return 983;
    if (key === 'mode' && tmp) return (target.mode & ~0o7777) | 0o1777;
    if (key === 'mode' && directory) return (target.mode & ~0o7777) | 0o700;
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const fake = { ...fs,
    lstatSync(p) { return stat(fs.lstatSync(map(p)), p === home || p === '/home', p === '/tmp' || scratchPath(p), p === '/tmp'); },
    openSync(p, flags, mode) {
      const fd = fs.openSync(map(p), flags, mode);
      if (p === home) handles.add(fd);
      if (p.includes('/dummy-sqlite-')) scratchDirs.add(fd);
      else if (scratchPath(p)) scratchFiles.add(fd);
      return fd;
    },
    fstatSync(fd) { return stat(fs.fstatSync(fd), handles.has(fd), scratchDirs.has(fd) || scratchFiles.has(fd)); },
    fchownSync() {},
    closeSync(fd) { handles.delete(fd); scratchDirs.delete(fd); scratchFiles.delete(fd); fs.closeSync(fd); },
  };
  return { dir, fake, adapter: createDummyFixtureAdapter({ fs: fake, getuid: () => 0 }) };
}

test('creates a closed synthetic SQLite fixture through the exclusive descriptor and hashes it', async t => {
  const { dir, adapter } = harness(t);
  const name = fixture();
  const result = await adapter({ kind: 'create-fixture', path: name, account, synthetic: true });
  assert.equal(result.sqlite, true);
  const bytes = fs.readFileSync(path.join(dir, path.basename(name)));
  const db = new DatabaseSync(path.join(dir, path.basename(name)), { readOnly: true });
  assert.equal(db.prepare('SELECT value FROM fixture').get().value, 'synthetic');
  db.close();
  assert.deepEqual(fs.readdirSync(dir), [path.basename(name)]);
  const hash = await adapter({ kind: 'hash', path: name, identity: result, synthetic: true });
  assert.equal(hash.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('rejects foreign paths, non-root creation, pre-existing links and unminted hashes', async t => {
  const { dir, fake, adapter } = harness(t);
  const name = fixture();
  const request = { kind: 'create-fixture', path: name, account, synthetic: true };
  const reject = promise => assert.rejects(promise, { code: 'OPERATION_UNCONFIRMED', message: 'Dummy DB operation unconfirmed' });
  await reject(adapter({ ...request, path: '/etc/passwd' }));
  await reject(createDummyFixtureAdapter({ fs: fake, getuid: () => 999 })(request));
  await reject(adapter({ kind: 'hash', path: name, identity: { dev: 1, ino: 1 }, synthetic: true }));
  fs.symlinkSync('/dev/null', path.join(dir, path.basename(name)));
  await reject(adapter(request));
});

test('rejects changed identity, hardlinks and changes during hashing', async t => {
  const { dir, fake, adapter } = harness(t);
  const name = fixture();
  const result = await adapter({ kind: 'create-fixture', path: name, account, synthetic: true });
  const request = { kind: 'hash', path: name, identity: result, synthetic: true };
  await assert.rejects(adapter({ ...request, identity: { ...result, ino: result.ino + 1 } }));
  const file = path.join(dir, path.basename(name));
  fs.linkSync(file, path.join(dir, 'extra-link'));
  await assert.rejects(adapter(request));
  fs.unlinkSync(path.join(dir, 'extra-link'));
  const originalRead = fake.readSync;
  fake.readSync = (...args) => { const n = originalRead(...args); if (n) fs.appendFileSync(file, 'x'); return n; };
  await assert.rejects(adapter(request));
});

test('fails before creation for unsafe home or unavailable SQLite backup', async t => {
  const { dir, fake } = harness(t);
  const name = fixture();
  const request = { kind: 'create-fixture', path: name, account, synthetic: true };
  const badHome = { ...fake, lstatSync(p) {
    const value = fake.lstatSync(p);
    return p === home ? new Proxy(value, { get(target, key) { return key === 'uid' ? 1000 : target[key]; } }) : value;
  } };
  await assert.rejects(createDummyFixtureAdapter({ fs: badHome, getuid: () => 0 })(request));
  await assert.rejects(createDummyFixtureAdapter({ fs: fake, getuid: () => 0, backup: false })(request));
  assert.equal(fs.existsSync(path.join(dir, path.basename(name))), false);
});

test('supports the Node 22 SQLite API without serialize', async t => {
  const { dir, fake } = harness(t);
  class Node22Database {
    constructor(name) { this.db = new DatabaseSync(name); }
    exec(sql) { this.db.exec(sql); }
    close() { this.db.close(); }
  }
  const adapter = createDummyFixtureAdapter({ fs: fake, getuid: () => 0, Database: Node22Database,
    backup: (db, destination) => backup(db.db, destination) });
  const name = fixture();
  const result = await adapter({ kind: 'create-fixture', path: name, account, synthetic: true });
  assert.equal(result.sqlite, true);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(name)]);
});

test('rejects a substituted backup inode or an unexpected sidecar', async t => {
  const { fake } = harness(t);
  const request = { kind: 'create-fixture', path: fixture(), account, synthetic: true };
  const replace = async (_db, destination) => {
    fs.unlinkSync(destination);
    fs.writeFileSync(destination, 'replacement', { flag: 'wx', mode: 0o600 });
  };
  await assert.rejects(createDummyFixtureAdapter({ fs: fake, getuid: () => 0, backup: replace })(request));
  const isolated = harness(t);
  const sidecar = async (db, destination) => {
    await backup(db, destination);
    fs.writeFileSync(`${destination}-journal`, 'synthetic', { flag: 'wx', mode: 0o600 });
  };
  const sidecarPath = fixture();
  await assert.rejects(createDummyFixtureAdapter({ fs: isolated.fake, getuid: () => 0, backup: sidecar })({ ...request, path: sidecarPath }));
  assert.deepEqual(fs.readdirSync(isolated.dir), [path.basename(sidecarPath)]);
});

test('sanitizes filesystem errors and rejects file ownership mismatch', async t => {
  const { fake } = harness(t);
  const name = fixture();
  const request = { kind: 'create-fixture', path: name, account, synthetic: true };
  const faulty = { ...fake, openSync() { throw new Error('private content'); } };
  await assert.rejects(createDummyFixtureAdapter({ fs: faulty, getuid: () => 0 })(request),
    { message: 'Dummy DB operation unconfirmed', code: 'OPERATION_UNCONFIRMED' });
  const wrongOwner = { ...fake, fstatSync(fd) {
    const value = fake.fstatSync(fd);
    return value.isFile() ? new Proxy(value, { get(target, key) { return key === 'gid' ? 1000 : target[key]; } }) : value;
  } };
  await assert.rejects(createDummyFixtureAdapter({ fs: wrongOwner, getuid: () => 0 })(request));
});
