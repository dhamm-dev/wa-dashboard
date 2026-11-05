import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pending delivery is finalized once and crash recovery never retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-events-'));
  process.env.DATA_DIR = dir;
  const { db } = await import('../src/db.js');
  const { finalize, recoverPending } = await import('../src/sender.js');
  try {
    db.prepare('INSERT INTO accounts VALUES (?,?)').run('a', 'A');
    const insert = db.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)');
    insert.run('one', 'a', '62812345678@s.whatsapp.net', 'x', '2026-01-01', '2026-01-01', 'pending', 'diproses');
    insert.run('two', 'a', '62812345678@s.whatsapp.net', 'x', '2026-01-01', '2026-01-01', 'pending', 'diproses');
    assert.equal(db.prepare('SELECT count(*) n FROM history_events').get().n, 0);
    finalize('one', 'success', '');
    finalize('one', 'failed', 'duplicate');
    recoverPending(); recoverPending();
    const rows = db.prepare('SELECT h.id, h.status, h.detail FROM history_events e JOIN history h ON h.id=e.history_id ORDER BY e.seq').all();
    assert.deepEqual(rows.map(r => [r.id, r.status]), [['one', 'success'], ['two', 'failed']]);
    assert.match(rows[1].detail, /tidak pasti.*tidak dicoba ulang/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
