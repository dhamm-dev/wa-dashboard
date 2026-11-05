import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wa-worker-'));
process.env.DATA_DIR = dir;
const { db } = await import('../src/db.js');
const { tick } = await import('../src/worker.js');

test('startup records missed occurrences and keeps weekly schedule moving', async () => {
  db.prepare('INSERT INTO accounts VALUES (?,?)').run('account', 'Test');
  db.prepare('INSERT INTO schedules(id,account_id,jid,text,attachment_id,repeat,next_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('schedule', 'account', '62812345678@s.whatsapp.net', 'Pesan', null, 'weekly', '2026-11-05T02:30:00.000Z', '2026-11-01T00:00:00.000Z');
  await tick({ startup: true, now: Date.parse('2026-11-12T02:31:00Z') });
  assert.equal(db.prepare('SELECT next_at FROM schedules WHERE id=?').get('schedule').next_at, '2026-11-19T02:30:00.000Z');
  assert.deepEqual(db.prepare('SELECT status FROM history ORDER BY scheduled_at').all().map(r => r.status), ['missed', 'missed']);
  await tick({ now: Date.parse('2026-11-19T02:30:00Z') });
  assert.equal(db.prepare('SELECT next_at FROM schedules WHERE id=?').get('schedule').next_at, '2026-11-26T02:30:00.000Z');
  assert.equal(db.prepare('SELECT count(*) AS n FROM history WHERE status=?').get('missed').n, 3);
  db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run('schedule');
  await tick({ now: Date.parse('2026-12-03T02:30:00Z') });
  assert.equal(db.prepare('SELECT count(*) AS n FROM history').get().n, 3);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
