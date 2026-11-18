import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, dataDir } from './db.js';
import { privatePreview } from './private-preview.js';

const root = join(dataDir, 'uploads-v2');
const pathFor = id => join(root, id, 'data');
const syncDir = async path => {
  const dir = await open(path, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
};

export async function storeUpload(accountId, name, mime, bytes) {
  const allowed = () => !!db.prepare('SELECT 1 FROM accounts a WHERE a.id=? AND NOT EXISTS (SELECT 1 FROM revoked_users WHERE user_id=a.owner_id)').get(accountId);
  if (!allowed()) throw new Error('Akun tidak tersedia');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await syncDir(dataDir);
  const id = randomUUID();
  const dir = join(root, id);
  await mkdir(dir, { mode: 0o700 });
  await syncDir(root);
  db.prepare('INSERT INTO upload_files(id,account_id,ready) VALUES (?,?,0)').run(id, accountId);
  const file = await open(pathFor(id), 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await syncDir(dir);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!allowed()) throw new Error('Akun tidak tersedia');
    db.prepare('INSERT INTO attachments VALUES (?,?,?,?)').run(id, accountId, name, mime);
    db.prepare('UPDATE upload_files SET ready=1 WHERE id=?').run(id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return id;
}

export async function recoverUploads() {
  if (privatePreview) return;
  for (const { id } of db.prepare('SELECT u.id FROM upload_files u JOIN accounts a ON a.id=u.account_id WHERE u.ready=0 AND NOT EXISTS (SELECT 1 FROM revoked_users r WHERE r.user_id=a.owner_id)').all()) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('ID unggahan tidak valid');
    const dir = join(root, id);
    try { await unlink(pathFor(id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await syncDir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    db.prepare('DELETE FROM upload_files WHERE id=? AND ready=0').run(id);
  }
}

export function uploadPath(id) {
  return db.prepare('SELECT 1 FROM upload_files WHERE id=? AND ready=1').get(id) ? pathFor(id) : join(dataDir, 'uploads', id);
}
