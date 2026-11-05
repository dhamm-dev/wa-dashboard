import { db } from './db.js';
import { send, missed } from './sender.js';
import { state } from './whatsapp.js';
import { randomUUID } from 'node:crypto';

const WEEK = 7 * 86400000;
let busy = false;

export async function tick({ startup = false, now = Date.now() } = {}) {
  if (busy) return;
  busy = true;
  try {
    const rows = db.prepare('SELECT id FROM schedules WHERE enabled=1 AND next_at IS NOT NULL AND next_at <= ?').all(new Date(now).toISOString());
    for (const { id } of rows) {
      while (true) {
        const row = db.prepare('SELECT * FROM schedules WHERE id=? AND enabled=1').get(id);
        if (!row?.next_at || Date.parse(row.next_at) > now) break;
        const due = Date.parse(row.next_at);
        const scheduled = new Date(due).toISOString();
        const next = row.repeat === 'weekly' ? new Date(due + WEEK).toISOString() : null;
        const skip = startup || now - due > 15000 || state(row.account_id).status !== 'connected';
        const historyId = randomUUID();
        db.exec('BEGIN IMMEDIATE');
        try {
          const changed = db.prepare('UPDATE schedules SET next_at=?, last_at=?, revision=revision+1 WHERE id=? AND enabled=1 AND next_at=? AND revision=?').run(next, scheduled, row.id, row.next_at, row.revision);
          if (!changed.changes) { db.exec('ROLLBACK'); break; }
          if (skip) missed(row, scheduled, startup || now - due > 15000 ? 'Server tidak aktif pada waktu jadwal' : 'WhatsApp tidak terhubung');
          else db.prepare('INSERT INTO history(id, account_id, jid, text, scheduled_at, created_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(historyId, row.account_id, row.jid, row.text, scheduled, new Date().toISOString(), 'pending', 'Pengiriman sedang diproses');
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        if (!skip) {
          await send(row.account_id, row.jid, row.text, row.attachment_id, scheduled, historyId);
        }
        if (!next) break;
      }
    }
  } finally { busy = false; }
}
