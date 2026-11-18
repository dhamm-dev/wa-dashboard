import './instance-lock.js';
import { mkdirSync, lstatSync, openSync, closeSync, fsyncSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db, dataDir } from './db.js';
import { privatePreview } from './private-preview.js';

const root = join(dataDir, 'media-temp');
const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const syncDir = path => {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
let active;

export function initMediaTemp({ preservePrevious = false } = {}) {
  if (active) return active;
  mkdirSync(root, { mode: 0o700, recursive: true });
  const info = lstatSync(root);
  if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Direktori media sementara tidak privat');
  syncDir(dataDir);
  for (const { id } of db.prepare('SELECT id FROM media_temp_dirs').all()) {
    if (!validId(id)) throw new Error('ID direktori media sementara tidak valid');
    if (!preservePrevious && !privatePreview) {
      rmSync(join(root, id), { recursive: true, force: true });
      syncDir(root);
      db.prepare('DELETE FROM media_temp_dirs WHERE id=?').run(id);
    }
  }
  const id = randomUUID();
  const dir = join(root, id);
  mkdirSync(dir, { mode: 0o700 });
  syncDir(root);
  db.prepare('INSERT INTO media_temp_dirs(id) VALUES (?)').run(id);
  process.env.TMPDIR = dir;
  if (tmpdir() !== dir) throw new Error('Direktori media sementara tidak aktif');
  active = dir;
  return dir;
}
