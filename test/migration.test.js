import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('legacy schedules retain active times and ambiguous null times become inactive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-migration-'));
  const legacy = new DatabaseSync(join(dir, 'dashboard.sqlite'));
  legacy.exec(`CREATE TABLE schedules(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, jid TEXT NOT NULL, text TEXT NOT NULL, attachment_id TEXT, repeat TEXT NOT NULL, next_at TEXT, created_at TEXT NOT NULL);
    INSERT INTO schedules VALUES ('a','account','62812345678@s.whatsapp.net','x',NULL,'weekly','2030-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO schedules VALUES ('b','account','62812345678@s.whatsapp.net','x',NULL,'once',NULL,'2026-01-01T00:00:00.000Z');`);
  legacy.close();
  process.env.DATA_DIR = dir;
  const { db } = await import('../src/db.js');
  assert.deepEqual({ ...db.prepare('SELECT enabled,next_at,revision,last_at FROM schedules WHERE id=?').get('a') }, { enabled: 1, next_at: '2030-01-01T00:00:00.000Z', revision: 0, last_at: null });
  assert.deepEqual({ ...db.prepare('SELECT enabled,next_at,revision,last_at FROM schedules WHERE id=?').get('b') }, { enabled: 0, next_at: null, revision: 0, last_at: null });
  db.close(); rmSync(dir, { recursive: true, force: true });
});
