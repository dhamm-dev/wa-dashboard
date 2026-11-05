import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const requestedDataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(requestedDataDir, { recursive: true, mode: 0o700 });
export const dataDir = realpathSync(requestedDataDir);
const publicDir = realpathSync(fileURLToPath(new URL('../public/', import.meta.url)));
const publicRelative = relative(publicDir, dataDir);
if (!publicRelative || (!publicRelative.startsWith('..' + '/') && publicRelative !== '..' && !isAbsolute(publicRelative))) throw new Error('DATA_DIR tidak boleh berada di direktori publik');
export const db = new DatabaseSync(resolve(dataDir, 'dashboard.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, jid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY, name TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, mime TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), jid TEXT NOT NULL, text TEXT NOT NULL, attachment_id TEXT REFERENCES attachments(id), repeat TEXT NOT NULL, next_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), jid TEXT NOT NULL, text TEXT NOT NULL, scheduled_at TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');`);

db.exec(`CREATE TABLE IF NOT EXISTS history_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  history_id TEXT NOT NULL UNIQUE REFERENCES history(id)
);`);

const columns = db.prepare('PRAGMA table_info(schedules)').all().map(column => column.name);
db.exec('BEGIN IMMEDIATE');
try {
  if (!columns.includes('enabled')) {
    db.exec('ALTER TABLE schedules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
    db.exec('UPDATE schedules SET enabled=0 WHERE next_at IS NULL');
  }
  if (!columns.includes('revision')) db.exec('ALTER TABLE schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('last_at')) db.exec('ALTER TABLE schedules ADD COLUMN last_at TEXT');
  db.exec('COMMIT');
} catch (err) { db.exec('ROLLBACK'); throw err; }
