import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inventoryRevocations, getCleanupManifest, advanceCleanup } from '../src/cleanup-journal.js';

const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/db.js'"], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  db.exec("INSERT INTO users VALUES ('one','one@example.test',NULL,'customer'),('two','two@example.test',NULL,'customer')");
  const account = db.prepare("INSERT INTO accounts(id,name,owner_id) VALUES (?,'name',?)");
  account.run(ids[0], 'one'); account.run(ids[1], 'one'); account.run(ids[2], 'two');
  const attachment = db.prepare("INSERT INTO attachments VALUES (?,?,'private','private')");
  attachment.run(ids[3], ids[0]); attachment.run(ids[4], ids[0]); attachment.run(ids[7], ids[2]);
  const upload = db.prepare('INSERT INTO upload_files VALUES (?,?,?)');
  upload.run(ids[4], ids[0], 1); upload.run(ids[5], ids[1], 0); upload.run(ids[7], ids[2], 1);
  db.exec("INSERT INTO revoked_users VALUES ('one','2026-01-01T00:00:00.000Z')");
  return db;
}

test('startup seals complete inventory, restarts retain it, and transitions use CAS', t => {
  const db = fixture(t);
  assert.equal(db.prepare('SELECT count(*) n FROM cleanup_manifests').get().n, 0);
  db.prepare('INSERT INTO upload_files VALUES (?,?,0)').run(ids[6], ids[0]);
  inventoryRevocations(db);
  const first = getCleanupManifest(db, 'one');
  assert.equal(first.stage, 'ready');
  assert.equal(first.items.length, 7);
  assert.ok(first.items.some(i => i.kind === 'upload' && i.id === ids[6] && i.ready === 0));
  assert.ok(first.items.some(i => i.kind === 'attachment' && i.id === ids[3]));
  assert.ok(!JSON.stringify(first).includes(ids[7]));
  inventoryRevocations(db);
  assert.deepEqual(getCleanupManifest(db, 'one'), first);
  assert.throws(() => advanceCleanup(db, 'one', 'ready', 'complete'));
  assert.equal(advanceCleanup(db, 'one', 'ready', 'files_deleted').stage, 'files_deleted');
  assert.throws(() => advanceCleanup(db, 'one', 'ready', 'files_deleted'));
  inventoryRevocations(db);
  assert.equal(advanceCleanup(db, 'one', 'files_deleted', 'complete').stage, 'complete');
  assert.equal(getCleanupManifest(db, 'one').digest, first.digest);
});

test('ownership conflicts and invalid identifiers roll back without a partial seal', t => {
  const db = fixture(t);
  db.prepare('UPDATE upload_files SET account_id=? WHERE id=?').run(ids[2], ids[4]);
  assert.throws(() => inventoryRevocations(db), /ownership/);
  assert.equal(db.prepare('SELECT count(*) n FROM cleanup_manifests').get().n, 0);
  db.prepare('UPDATE upload_files SET account_id=? WHERE id=?').run(ids[0], ids[4]);
  db.prepare("INSERT INTO upload_files VALUES ('../invalid',?,0)").run(ids[0]);
  assert.throws(() => inventoryRevocations(db), /item/);
  db.prepare("DELETE FROM upload_files WHERE id='../invalid'").run();
  db.exec("CREATE TRIGGER fail_seal BEFORE INSERT ON cleanup_seals BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
  assert.throws(() => inventoryRevocations(db), /simulated crash/);
  assert.equal(db.prepare('SELECT count(*) n FROM cleanup_items').get().n, 0);
  db.exec('DROP TRIGGER fail_seal');
  inventoryRevocations(db);
  assert.equal(getCleanupManifest(db, 'one').stage, 'ready');
});

test('sealed rows and ordered journal reject tampering including replace', t => {
  const db = fixture(t); inventoryRevocations(db);
  for (const sql of [
    "UPDATE cleanup_items SET id='bad'", "DELETE FROM cleanup_items", "INSERT INTO cleanup_items VALUES ('one','account','x','x',NULL)",
    "INSERT OR REPLACE INTO cleanup_manifests VALUES ('one','changed',1)", "UPDATE cleanup_seals SET digest='x'", "DELETE FROM cleanup_seals",
    "INSERT OR REPLACE INTO cleanup_journal VALUES ('one','ready')", "INSERT INTO cleanup_journal VALUES ('one','complete')", "DELETE FROM cleanup_journal"
  ]) assert.throws(() => db.exec(sql), sql);
  assert.equal(getCleanupManifest(db, 'one').stage, 'ready');
});

test('cross-owner schedule references and broken foreign keys block sealing', t => {
  const db = fixture(t);
  db.prepare("INSERT INTO schedules(id,account_id,jid,text,attachment_id,repeat,created_at) VALUES ('s',?,'j','t',?,'none','now')").run(ids[2], ids[3]);
  assert.throws(() => inventoryRevocations(db), /ownership/);
  db.exec("DELETE FROM schedules WHERE id='s'; PRAGMA foreign_keys=OFF");
  db.prepare('INSERT INTO upload_files VALUES (?,?,0)').run(ids[6], 'missing');
  db.exec('PRAGMA foreign_keys=ON');
  assert.throws(() => inventoryRevocations(db), /foreign keys/);
  assert.equal(db.prepare('SELECT count(*) n FROM cleanup_manifests').get().n, 0);
});

test('reopening after a committed transition preserves the original snapshot', t => {
  const db = fixture(t);
  const path = db.prepare('PRAGMA database_list').get().file;
  inventoryRevocations(db);
  const before = getCleanupManifest(db, 'one');
  advanceCleanup(db, 'one', 'ready', 'files_deleted');
  const reopened = new DatabaseSync(path);
  try {
    reopened.exec('PRAGMA foreign_keys=ON');
    inventoryRevocations(reopened);
    const after = getCleanupManifest(reopened, 'one');
    assert.equal(after.stage, 'files_deleted');
    assert.equal(after.digest, before.digest);
    assert.deepEqual(after.items, before.items);
  } finally { reopened.close(); }
});
