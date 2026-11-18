import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inventoryRevocations, getCleanupManifest } from '../src/cleanup-journal.js';
import { cleanupRevokedCustomer } from '../src/customer-cleanup.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(t) {
  const dir = mkdtempSync(join(fileURLToPath(new URL('./fixtures/customer-cleanup/', import.meta.url)), 'run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/db.js'"], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  t.after(() => db.close());
  db.exec("INSERT INTO users VALUES ('one','one@example.test','google-one','customer'),('two','two@example.test',NULL,'customer')");
  const account = db.prepare("INSERT INTO accounts(id,name,owner_id) VALUES (?,'name',?)");
  account.run(id(1), 'one'); account.run(id(2), 'two');
  const attachment = db.prepare("INSERT INTO attachments VALUES (?,?,'name','mime')");
  attachment.run(id(3), id(1)); attachment.run(id(4), id(1)); attachment.run(id(7), id(2));
  db.prepare('INSERT INTO upload_files VALUES (?,?,1)').run(id(4), id(1));
  db.prepare('INSERT INTO media_temp_dirs VALUES (?)').run(id(9));
  db.exec("INSERT INTO email_credentials VALUES ('one@example.test','one',zeroblob(16),zeroblob(64)); INSERT INTO revoked_users VALUES ('one','now'); INSERT INTO templates(id,name,text,owner_id) VALUES ('t1','n','x','one'),('t2','n','x','two')");
  inventoryRevocations(db);
  for (const path of ['sessions', 'uploads', 'uploads-v2', `sessions/${id(1)}`, `uploads-v2/${id(4)}`]) mkdirSync(join(dir, path));
  for (const path of [`sessions/${id(1)}/creds.json`, `uploads/${id(3)}`, `uploads/${id(4)}`, `uploads/${id(8)}`, `uploads-v2/${id(4)}/data`]) writeFileSync(join(dir, path), 'synthetic');
  const options = { assertExclusive: () => true, mediaTempId: id(9) };
  return { db, dir, options, run: extra => cleanupRevokedCustomer(db, dir, 'one', { ...options, ...extra }) };
}

test('crash and restart preserve ambiguous and foreign data and scrub the target', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ afterUnlink: () => { throw Error('crash'); } }), /crash/);
  assert.equal(getCleanupManifest(f.db, 'one').stage, 'ready');
  await assert.rejects(f.run({ onStage: stage => { if (stage === 'files_deleted') throw Error('boundary'); } }), /boundary/);
  assert.equal(getCleanupManifest(f.db, 'one').stage, 'files_deleted');
  f.db.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT,'db crash'); END");
  await assert.rejects(f.run(), /db crash/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM email_credentials WHERE user_id='one'").get().n, 1);
  assert.equal(getCleanupManifest(f.db, 'one').stage, 'files_deleted');
  f.db.exec('DROP TRIGGER fail_cleanup');
  assert.equal((await f.run()).stage, 'complete');
  assert.equal((await f.run()).stage, 'complete');
  assert.match(f.db.prepare("SELECT email FROM users WHERE id='one'").get().email, /^deleted:/);
  assert.equal(f.db.prepare("SELECT google_sub FROM users WHERE id='one'").get().google_sub, null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM identity_tombstones').get().n, 2);
  assert.equal(f.db.prepare("SELECT count(*) n FROM accounts WHERE owner_id='two'").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM templates WHERE owner_id='two'").get().n, 1);
  assert.ok(existsSync(join(f.dir, 'uploads', id(4))));
  assert.ok(existsSync(join(f.dir, 'uploads', id(8))));
  assert.ok(!existsSync(join(f.dir, 'uploads', id(3))));
});

test('proof, stale temp journal, and changed ownership block cleanup', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ assertExclusive: () => false }), /proof/);
  f.db.prepare('INSERT INTO media_temp_dirs VALUES (?)').run(id(10));
  await assert.rejects(f.run(), /Media temp/);
  f.db.prepare('DELETE FROM media_temp_dirs WHERE id=?').run(id(10));
  f.db.prepare('UPDATE attachments SET account_id=? WHERE id=?').run(id(2), id(3));
  await assert.rejects(f.run(), /inventory|ownership/);
  assert.ok(existsSync(join(f.dir, 'uploads', id(3))));
});

for (const kind of ['symlink', 'hardlink']) test(`${kind} fails closed`, async t => {
  const f = fixture(t);
  const target = join(f.dir, 'uploads', id(3));
  rmSync(target);
  if (kind === 'symlink') symlinkSync(join(f.dir, 'uploads', id(8)), target);
  else linkSync(join(f.dir, 'uploads', id(8)), target);
  await assert.rejects(f.run());
  assert.equal(getCleanupManifest(f.db, 'one').stage, 'ready');
  assert.ok(existsSync(join(f.dir, 'uploads', id(8))));
});
