import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, dataDir } from './db.js';
import { socketFor } from './whatsapp.js';

export async function send(accountId, jid, text, attachmentId, scheduledAt = null, reservedId = null) {
  const id = reservedId || randomUUID();
  const now = new Date().toISOString();
  if (!reservedId) db.prepare('INSERT INTO history(id, account_id, jid, text, scheduled_at, created_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, accountId, jid, text, scheduledAt, now, 'pending', 'Pengiriman sedang diproses');
  try {
    const socket = socketFor(accountId);
    if (jid.endsWith('@g.us') && !(await socket.groupFetchAllParticipating())[jid]) throw new Error('Grup tidak ditemukan pada akun ini');
    let content = { text };
    if (attachmentId) {
      const file = db.prepare('SELECT * FROM attachments WHERE id=? AND account_id=?').get(attachmentId, accountId);
      if (!file) throw new Error('Lampiran tidak ditemukan pada akun ini');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(file.id)) throw new Error('ID lampiran tidak valid');
      const bytes = await readFile(join(dataDir, 'uploads', file.id));
      content = file.mime.startsWith('image/') ? { image: bytes, caption: text } : { document: bytes, mimetype: file.mime, fileName: file.name, caption: text };
    }
    await socket.sendMessage(jid, content);
    finalize(id, 'success', '');
    return { id, status: 'success' };
  } catch (err) {
    finalize(id, 'failed', String(err.message || 'Gagal mengirim').slice(0, 300));
    return { id, status: 'failed', detail: String(err.message || 'Gagal mengirim') };
  }
}

export function missed(row, when, reason) {
  const id = randomUUID();
  db.prepare('INSERT INTO history(id, account_id, jid, text, scheduled_at, created_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, row.account_id, row.jid, row.text, when, new Date().toISOString(), 'missed', reason);
  db.prepare('INSERT INTO history_events(history_id) VALUES (?)').run(id);
}

export function finalize(id, status, detail) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare("UPDATE history SET status=?, detail=? WHERE id=? AND status='pending'").run(status, detail, id);
    if (result.changes) db.prepare('INSERT INTO history_events(history_id) SELECT id FROM history WHERE id=? AND scheduled_at IS NOT NULL').run(id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function recoverPending() {
  const rows = db.prepare("SELECT id FROM history WHERE status='pending'").all();
  for (const row of rows) finalize(row.id, 'failed', 'Proses berhenti sebelum pengiriman selesai. Hasil tidak pasti, tidak dicoba ulang.');
}
