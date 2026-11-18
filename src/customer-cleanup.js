import { randomUUID } from 'node:crypto';
import { getCleanupManifest, advanceCleanup } from './cleanup-journal.js';
import { cleanupFiles } from './cleanup-files.js';
import { captureUserIdentities, isTombstoned } from './identity-tombstones.js';
import { privatePreview } from './private-preview.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sorted = rows => rows.map(row => JSON.stringify([row.kind, row.id, row.account_id, row.ready])).sort();

function validate(db, userId, manifest, mediaTempId) {
  if (!db.prepare('PRAGMA foreign_keys').get().foreign_keys || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid database foreign keys');
  const temp = db.prepare('SELECT id FROM media_temp_dirs').all();
  if (!uuid.test(mediaTempId) || temp.length !== 1 || temp[0].id !== mediaTempId) throw new Error('Media temp recovery not cleared');
  const user = db.prepare('SELECT id,email,google_sub,role FROM users WHERE id=?').get(userId);
  if (!user || user.role !== 'customer') throw new Error('Invalid cleanup user');
  const accounts = db.prepare('SELECT id FROM accounts WHERE owner_id=?').all(userId);
  const attachments = db.prepare('SELECT t.id,t.account_id FROM attachments t JOIN accounts a ON a.id=t.account_id WHERE a.owner_id=?').all(userId);
  const uploads = db.prepare('SELECT u.id,u.account_id,u.ready FROM upload_files u JOIN accounts a ON a.id=u.account_id WHERE a.owner_id=?').all(userId);
  const current = [...accounts.map(a => ({ kind: 'account', id: a.id, account_id: a.id, ready: null })), ...attachments.map(a => ({ kind: 'attachment', ...a, ready: null })), ...uploads.map(u => ({ kind: 'upload', ...u }))];
  if (current.some(i => !uuid.test(i.id) || !uuid.test(i.account_id) || (i.kind === 'upload' && i.ready !== 0 && i.ready !== 1)) || JSON.stringify(sorted(current)) !== JSON.stringify(sorted(manifest.items))) throw new Error('Cleanup inventory changed');
  const conflict = db.prepare(`SELECT 1 FROM attachments t JOIN upload_files u ON u.id=t.id JOIN accounts ta ON ta.id=t.account_id JOIN accounts ua ON ua.id=u.account_id WHERE (ta.owner_id=? OR ua.owner_id=?) AND (t.account_id!=u.account_id OR u.ready!=1) LIMIT 1`).get(userId, userId);
  const cross = db.prepare(`SELECT 1 FROM schedules s JOIN attachments t ON t.id=s.attachment_id JOIN accounts sa ON sa.id=s.account_id JOIN accounts ta ON ta.id=t.account_id WHERE (sa.owner_id=? OR ta.owner_id=?) AND s.account_id!=t.account_id LIMIT 1`).get(userId, userId);
  if (conflict || cross) throw new Error('Inconsistent cleanup ownership');
  return { user, accounts, attachments, uploads };
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function cleanupRevokedCustomer(db, dataDir, userId, options = {}) {
  if (privatePreview) throw new Error('Customer cleanup unavailable during private preview');
  const { assertExclusive, mediaTempId, afterUnlink, onStage } = options;
  if (typeof assertExclusive !== 'function' || await assertExclusive() !== true) throw new Error('Exclusive post-restart cleanup proof required');
  if (onStage !== undefined && typeof onStage !== 'function') throw new TypeError('Invalid stage hook');
  let manifest = getCleanupManifest(db, userId);
  if (manifest.stage === 'complete') {
    const temp = db.prepare('SELECT id FROM media_temp_dirs').all();
    if (!uuid.test(mediaTempId) || temp.length !== 1 || temp[0].id !== mediaTempId) throw new Error('Media temp recovery not cleared');
    return manifest;
  }
  if (manifest.stage === 'ready') {
    const { accounts, attachments, uploads } = validate(db, userId, manifest, mediaTempId);
    const uploadIds = new Set(uploads.map(u => u.id));
    const artifacts = [...accounts.map(a => ({ kind: 'sessions', id: a.id })), ...attachments.filter(a => !uploadIds.has(a.id)).map(a => ({ kind: 'uploads', id: a.id })), ...uploads.map(u => ({ kind: 'uploads-v2', id: u.id }))];
    await cleanupFiles({ dataDir, artifacts, afterUnlink });
    validate(db, userId, getCleanupManifest(db, userId), mediaTempId);
    manifest = advanceCleanup(db, userId, 'ready', 'files_deleted');
    if (onStage) await onStage('files_deleted');
  }
  transaction(db, () => {
    manifest = getCleanupManifest(db, userId);
    if (manifest.stage !== 'files_deleted') throw new Error('Cleanup stage changed');
    const { user } = validate(db, userId, manifest, mediaTempId);
    captureUserIdentities(db, userId);
    if (user.google_sub && !isTombstoned(db, 'google', user.google_sub)) throw new Error('Missing identity tombstone');
    for (const row of db.prepare('SELECT email FROM email_credentials WHERE user_id=?').all(userId)) if (!isTombstoned(db, 'email', row.email)) throw new Error('Missing identity tombstone');
    const accounts = 'SELECT id FROM accounts WHERE owner_id=?';
    db.prepare(`DELETE FROM history_events WHERE history_id IN (SELECT id FROM history WHERE account_id IN (${accounts}))`).run(userId);
    for (const table of ['history', 'schedules', 'contacts', 'bot_config', 'bot_keys', 'bot_message_reservations', 'bot_welcomes', 'bot_config_generation', 'attachments', 'upload_files']) db.prepare(`DELETE FROM ${table} WHERE account_id IN (${accounts})`).run(userId);
    db.prepare('DELETE FROM accounts WHERE owner_id=?').run(userId);
    db.prepare('DELETE FROM templates WHERE owner_id=?').run(userId);
    db.prepare('DELETE FROM email_credentials WHERE user_id=?').run(userId);
    if (db.prepare('UPDATE users SET email=?,google_sub=NULL WHERE id=? AND role=\'customer\'').run(`deleted:${randomUUID()}`, userId).changes !== 1) throw new Error('Cleanup user missing');
    if (db.prepare("INSERT INTO cleanup_journal(user_id,stage) VALUES (?,'complete')").run(userId).changes !== 1) throw new Error('Cleanup stage changed');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid database foreign keys');
    manifest = getCleanupManifest(db, userId);
  });
  if (onStage) await onStage('complete');
  return manifest;
}
