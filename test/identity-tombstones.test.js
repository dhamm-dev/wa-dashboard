import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identityHash, isTombstoned } from '../src/identity-tombstones.js';
import { emailAuth } from '../src/email-auth.js';

test('migration backfills only known revoked identities and survives credential removal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-migration-'));
  const migrate = () => spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/db.js'"], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  try {
    assert.equal(migrate().status, 0);
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    db.exec(`INSERT INTO users VALUES ('old','profile@example.test','CaseSensitive','customer'),('email','email-auth:email',NULL,'customer'),('other','other@example.test',NULL,'customer');
      INSERT INTO email_credentials VALUES (' Mixed@Example.Test ','email',zeroblob(16),zeroblob(64));
      INSERT INTO revoked_users VALUES ('old','then'),('email','then');
      INSERT INTO revoked_google_subs VALUES ('orphan-sub');`);
    const result = migrate(); assert.equal(result.status, 0, result.stderr);
    assert.ok(isTombstoned(db, 'google', 'CaseSensitive'));
    assert.ok(isTombstoned(db, 'google', 'orphan-sub'));
    assert.ok(isTombstoned(db, 'email', 'mixed@example.test'));
    assert.ok(!isTombstoned(db, 'google', 'casesensitive'));
    assert.ok(!isTombstoned(db, 'email', 'profile@example.test'));
    assert.notEqual(identityHash('email', 'mixed@example.test'), identityHash('google', 'mixed@example.test'));
    db.exec("DELETE FROM email_credentials WHERE user_id='email'");
    assert.equal(migrate().status, 0);
    assert.ok(isTombstoned(db, 'email', 'MIXED@example.test'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM identity_tombstones').get().n, 3);
    assert.throws(() => db.exec('DELETE FROM identity_tombstones'));
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registration checks tombstones after password derivation', async () => {
  const previousPublic = process.env.DHEXBOT_PUBLIC_SIGNUP, previousPrivate = process.env.DHEXBOT_PRIVATE_PREVIEW;
  process.env.DHEXBOT_PUBLIC_SIGNUP = '1'; delete process.env.DHEXBOT_PRIVATE_PREVIEW;
  const db = new DatabaseSync(':memory:');
  try {
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,role TEXT); CREATE TABLE email_credentials(email TEXT PRIMARY KEY,user_id TEXT,salt BLOB,password_hash BLOB); CREATE TABLE revoked_users(user_id TEXT); CREATE TABLE identity_tombstones(identity_hash TEXT PRIMARY KEY)");
  const req = { ip: 'test', body: { email: 'race@example.test', password: 'long-password-123' }, is: () => true };
  let status, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  const pending = emailAuth({ db }).register(req, res);
  db.prepare('INSERT INTO identity_tombstones VALUES (?)').run(identityHash('email', 'race@example.test'));
  await pending;
  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'Autentikasi gagal' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  req.body.email = 'policy-race@example.test';
  const pendingPolicy = emailAuth({ db }).register(req, res);
  process.env.DHEXBOT_PRIVATE_PREVIEW = '1';
  await pendingPolicy;
  assert.equal(status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  } finally {
    if (previousPublic === undefined) delete process.env.DHEXBOT_PUBLIC_SIGNUP; else process.env.DHEXBOT_PUBLIC_SIGNUP = previousPublic;
    if (previousPrivate === undefined) delete process.env.DHEXBOT_PRIVATE_PREVIEW; else process.env.DHEXBOT_PRIVATE_PREVIEW = previousPrivate;
    db.close();
  }
});
