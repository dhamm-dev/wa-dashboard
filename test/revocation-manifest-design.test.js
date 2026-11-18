import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('design fixture seals an atomic inventory and preserves an ordered journal across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-design-'));
  const path = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(readFileSync(new URL('./fixtures/revocation-manifest-design.sql', import.meta.url), 'utf8'));
    db.exec("BEGIN IMMEDIATE; INSERT INTO manifest VALUES ('u','now'); INSERT INTO manifest_item VALUES ('u','account','a','a'); ROLLBACK;");
    assert.equal(db.prepare('SELECT count(*) n FROM manifest').get().n, 0);
    db.exec("BEGIN IMMEDIATE; INSERT INTO manifest VALUES ('u','now'); INSERT INTO manifest_item VALUES ('u','account','a','a');");
    assert.throws(() => db.prepare('INSERT INTO manifest_seal VALUES (?,?,?)').run('u', 2, 'a'.repeat(64)));
    db.prepare('INSERT INTO manifest_seal VALUES (?,?,?)').run('u', 1, 'a'.repeat(64));
    db.exec('COMMIT');
    assert.throws(() => db.exec("INSERT INTO manifest_item VALUES ('u','upload_v2','b','a')"));
    assert.throws(() => db.exec("UPDATE manifest_item SET id='b'"));
    assert.throws(() => db.exec('DELETE FROM manifest_seal'));
    assert.throws(() => db.exec("INSERT INTO cleanup_journal(user_id,stage) VALUES ('u','complete')"));
    db.exec("INSERT INTO cleanup_journal(user_id,stage) VALUES ('u','files_complete')");
    assert.throws(() => db.exec('DELETE FROM cleanup_journal'));
    db.close();
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON');
    assert.equal(db.prepare('SELECT count(*) n FROM manifest_item').get().n, 1);
    assert.equal(db.prepare('SELECT stage FROM cleanup_journal').get().stage, 'files_complete');
    db.exec("INSERT INTO cleanup_journal(user_id,stage) VALUES ('u','database_complete'), ('u','complete')");
    assert.equal(db.prepare('SELECT count(*) n FROM cleanup_journal').get().n, 3);
  } finally {
    if (db) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
