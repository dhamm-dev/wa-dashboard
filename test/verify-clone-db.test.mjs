import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { safeInventory } from '../tools/safe-inventory.mjs';
import { verifyCloneDb } from '../tools/verify-clone-db.mjs';
import { copyDbScratch } from '../tools/copy-db-scratch.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-db-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'clone');
  const destination = path.join(root, 'scratch');
  await fs.mkdir(source, { mode: 0o700 });
  return { root, source, destination };
}
const inventory = root => safeInventory({ root, callerGuardAndRescan: true });
const verify = options => verifyCloneDb({ isQuiescent: async () => true, expectedPaths: ['dashboard.sqlite'], ...options });
const rejects = promise => assert.rejects(promise, { code: 'EVERIFY', message: 'Verification failed; a private scratch copy may remain' });

function makeDb(file, invalid = false) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE accounts(id TEXT PRIMARY KEY);
    CREATE TABLE schedules(id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id));
    INSERT INTO accounts VALUES ('private');
    INSERT INTO schedules VALUES ('private', '${invalid ? 'missing' : 'private'}');`);
  db.close();
}

test('verifies an uncheckpointed WAL in a separate scratch without changing the clone', async t => {
  const { source, destination } = await fixture(t);
  const file = path.join(source, 'dashboard.sqlite');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE accounts(id TEXT PRIMARY KEY); CREATE TABLE schedules(id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id)); INSERT INTO accounts VALUES ('secret'); INSERT INTO schedules VALUES ('secret', 'secret');");
    process.kill(process.pid, 'SIGKILL');
  `, file], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL');
  const expectedPaths = ['dashboard.sqlite', 'dashboard.sqlite-wal', 'dashboard.sqlite-shm'];
  const before = await inventory(source);
  assert.deepEqual(before.slice(1).map(x => x.path).sort(), expectedPaths.sort());
  const result = await verify({ source, destination, expectedPaths });
  assert.deepEqual(result, { counts: { accounts: '1', schedules: '1' } });
  const scratchInventory = await inventory(destination);
  assert.notEqual(scratchInventory.find(x => x.path === 'dashboard.sqlite').inode,
    before.find(x => x.path === 'dashboard.sqlite').inode);
  assert.deepEqual(await inventory(source), before);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
  assert.equal((await fs.readFile(path.join(destination, 'dashboard.sqlite-wal'))).equals(await fs.readFile(`${file}-wal`)), true);
});

test('rejects corruption and foreign key violations, retaining private scratch and unchanged source', async t => {
  for (const invalid of ['corrupt', 'foreign-key']) {
    await t.test(invalid, async t => {
      const { source, destination } = await fixture(t);
      const file = path.join(source, 'dashboard.sqlite');
      if (invalid === 'corrupt') await fs.writeFile(file, 'not a database');
      else makeDb(file, true);
      const before = await inventory(source);
      await rejects(verify({ source, destination }));
      assert.deepEqual(await inventory(source), before);
      assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
      assert.deepEqual(await fs.readFile(path.join(destination, 'dashboard.sqlite')), await fs.readFile(file));
    });
  }
});

test('rejects unexpected entries, links, traversal and missing or lost guard', async t => {
  const { source, destination } = await fixture(t);
  makeDb(path.join(source, 'dashboard.sqlite'));
  await rejects(verifyCloneDb({ source, destination, expectedPaths: ['dashboard.sqlite'] }));
  await rejects(verify({ source, destination, expectedPaths: ['dashboard.sqlite', '../other'] }));
  await fs.symlink('dashboard.sqlite', path.join(source, 'link'));
  await rejects(verify({ source, destination, expectedPaths: ['dashboard.sqlite', 'link'] }));
  await fs.unlink(path.join(source, 'link'));
  await fs.writeFile(path.join(source, 'extra'), 'private');
  await rejects(verify({ source, destination }));
  await fs.unlink(path.join(source, 'extra'));
  let calls = 0;
  await rejects(verify({ source, destination, isQuiescent: async () => ++calls < 3 }));
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
});

test('validates the full clone but copies only database files', async t => {
  const { source, destination } = await fixture(t);
  makeDb(path.join(source, 'dashboard.sqlite'));
  await fs.mkdir(path.join(source, 'sessions'));
  await fs.writeFile(path.join(source, 'sessions', 'credential'), 'private');
  const before = await inventory(source);
  await rejects(verify({ source, destination }));
  const expectedPaths = ['dashboard.sqlite', 'sessions', 'sessions/credential'];
  assert.deepEqual(await verify({ source, destination, expectedPaths }), { counts: { accounts: '1', schedules: '1' } });
  assert.deepEqual(await fs.readdir(destination), ['dashboard.sqlite']);
  assert.equal((await fs.stat(path.join(destination, 'dashboard.sqlite'))).mode & 0o777, 0o600);
  assert.deepEqual(await inventory(source), before);
});

test('rejects a missing database, existing scratch, and symlinked database or destination parent', async t => {
  const { root, source, destination } = await fixture(t);
  await rejects(verify({ source, destination }));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  makeDb(path.join(outside, 'dashboard.sqlite'));
  await fs.symlink(path.join(outside, 'dashboard.sqlite'), path.join(source, 'dashboard.sqlite'));
  await rejects(verify({ source, destination }));
  await fs.unlink(path.join(source, 'dashboard.sqlite'));
  makeDb(path.join(source, 'dashboard.sqlite'));
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'sentinel'), 'untouched');
  await rejects(verify({ source, destination }));
  assert.equal(await fs.readFile(path.join(destination, 'sentinel'), 'utf8'), 'untouched');
  await fs.symlink(outside, path.join(root, 'parent-link'));
  await rejects(verify({ source, destination: path.join(root, 'parent-link', 'scratch') }));
  assert.deepEqual(await fs.readdir(outside), ['dashboard.sqlite']);
});

test('detects source metadata changes during verification', async t => {
  const { source, destination } = await fixture(t);
  const file = path.join(source, 'dashboard.sqlite');
  makeDb(file);
  let calls = 0;
  await rejects(verify({ source, destination, isQuiescent: async () => {
    if (++calls === 3) await fs.chmod(file, 0o400);
    return true;
  } }));
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
});

test('verification tolerates unrelated concurrent changes to an ancestor', async t => {
  const { root } = await fixture(t);
  const cases = [];
  for (let i = 0; i < 8; i++) {
    const parent = path.join(root, `case-${i}`);
    const source = path.join(parent, 'clone');
    await fs.mkdir(source, { recursive: true });
    makeDb(path.join(source, 'dashboard.sqlite'));
    cases.push({ source, destination: path.join(parent, 'scratch') });
  }
  let running = true;
  let changes = 0;
  const churn = (async () => {
    while (running) await fs.writeFile(path.join(root, `unrelated-${changes++}`), 'dummy');
  })();
  try {
    const results = await Promise.all(cases.map(options => verify(options)));
    assert.ok(changes > 0);
    for (const result of results) assert.deepEqual(result, { counts: { accounts: '1', schedules: '1' } });
  } finally {
    running = false;
    await churn;
  }
});

test('propagates forbidden identities through verification and scratch copy', async t => {
  const { root, source, destination } = await fixture(t);
  const file = path.join(source, 'dashboard.sqlite');
  makeDb(file);
  const forbidden = await fs.stat(file, { bigint: true });
  let opened = false;
  await rejects(verify({ source, destination, forbiddenInodes: [forbidden], onBeforeOpen: async candidate => {
    const stat = await fs.lstat(candidate, { bigint: true });
    if (stat.dev === forbidden.dev && stat.ino === forbidden.ino) opened = true;
  } }));
  assert.equal(opened, false);
  const destParent = path.join(root, 'dest-parent');
  await fs.mkdir(destParent);
  const dirStat = await fs.stat(destParent, { bigint: true });
  await rejects(verify({ source, destination: path.join(destParent, 'scratch'), forbiddenInodes: [dirStat] }));
  assert.deepEqual(await fs.readdir(destParent), []);
});

test('scratch copy checks source entries and destination ancestors before opening', async t => {
  const { root, source } = await fixture(t);
  const file = path.join(source, 'dashboard.sqlite');
  makeDb(file);
  const manifest = await inventory(source);
  const destParent = path.join(root, 'dest-parent');
  await fs.mkdir(destParent);
  for (const target of [file, source, destParent, '/']) {
    const { dev, ino } = await fs.stat(target, { bigint: true });
    let opened = false;
    await assert.rejects(copyDbScratch({ source, destination: path.join(destParent, `scratch-${ino}`), manifest,
      forbiddenInodes: [{ dev, ino }], onBeforeOpen: async candidate => {
        const stat = await fs.lstat(candidate, { bigint: true });
        if (stat.dev === dev && stat.ino === ino) opened = true;
      } }));
    assert.equal(opened, false, target);
  }
});
