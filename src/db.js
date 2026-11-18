import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { dataDir } from './data-dir.js';
import { captureUserIdentities, identityHash } from './identity-tombstones.js';

export { dataDir };
export const db = new DatabaseSync(resolve(dataDir, 'dashboard.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, jid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY, name TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL, mime TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS upload_files(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), ready INTEGER NOT NULL CHECK(ready IN (0,1)));
CREATE TABLE IF NOT EXISTS media_temp_dirs(id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), jid TEXT NOT NULL, text TEXT NOT NULL, attachment_id TEXT REFERENCES attachments(id), repeat TEXT NOT NULL, next_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), jid TEXT NOT NULL, text TEXT NOT NULL, scheduled_at TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');`);

db.exec(`CREATE TABLE IF NOT EXISTS history_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  history_id TEXT NOT NULL UNIQUE REFERENCES history(id)
);`);

const columns = db.prepare('PRAGMA table_info(schedules)').all().map(column => column.name);
db.exec('BEGIN IMMEDIATE');
try {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    google_sub TEXT UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('admin','customer'))
  );
  INSERT OR IGNORE INTO users(id,email,role) VALUES ('legacy-admin','idhamk654@gmail.com','admin');
  CREATE TABLE IF NOT EXISTS email_credentials (
    email TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    salt BLOB NOT NULL CHECK(length(salt)=16),
    password_hash BLOB NOT NULL CHECK(length(password_hash)=64)
  );
  CREATE TABLE IF NOT EXISTS revoked_google_subs (google_sub TEXT PRIMARY KEY NOT NULL CHECK(length(google_sub)>0));
  CREATE TABLE IF NOT EXISTS revoked_users (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
    requested_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS identity_tombstones (identity_hash TEXT PRIMARY KEY NOT NULL CHECK(length(identity_hash)=64));
  CREATE TRIGGER IF NOT EXISTS identity_tombstones_no_update BEFORE UPDATE ON identity_tombstones BEGIN SELECT RAISE(ABORT, 'tombstone is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS identity_tombstones_no_delete BEFORE DELETE ON identity_tombstones BEGIN SELECT RAISE(ABORT, 'tombstone is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS revoked_users_no_update BEFORE UPDATE ON revoked_users BEGIN SELECT RAISE(ABORT, 'revocation is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS revoked_users_no_delete BEFORE DELETE ON revoked_users BEGIN SELECT RAISE(ABORT, 'revocation is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS revoked_account_insert BEFORE INSERT ON accounts WHEN EXISTS (SELECT 1 FROM revoked_users WHERE user_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT, 'owner revoked'); END;
  CREATE TRIGGER IF NOT EXISTS revoked_account_update BEFORE UPDATE OF owner_id ON accounts WHEN EXISTS (SELECT 1 FROM revoked_users WHERE user_id=OLD.owner_id OR user_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT, 'owner revoked'); END;
  CREATE TABLE IF NOT EXISTS cleanup_manifests (user_id TEXT PRIMARY KEY NOT NULL REFERENCES revoked_users(user_id), requested_at TEXT NOT NULL, version INTEGER NOT NULL CHECK(version=1));
  CREATE TABLE IF NOT EXISTS cleanup_items (user_id TEXT NOT NULL REFERENCES cleanup_manifests(user_id), kind TEXT NOT NULL CHECK(kind IN ('account','attachment','upload')), id TEXT NOT NULL, account_id TEXT NOT NULL, ready INTEGER, CHECK((kind='upload' AND ready IN (0,1)) OR (kind!='upload' AND ready IS NULL)), PRIMARY KEY(user_id,kind,id));
  CREATE TABLE IF NOT EXISTS cleanup_seals (user_id TEXT PRIMARY KEY NOT NULL REFERENCES cleanup_manifests(user_id), item_count INTEGER NOT NULL CHECK(item_count>=0), digest TEXT NOT NULL CHECK(length(digest)=64));
  CREATE TABLE IF NOT EXISTS cleanup_journal (user_id TEXT NOT NULL REFERENCES cleanup_seals(user_id), stage TEXT NOT NULL CHECK(stage IN ('ready','files_deleted','complete')), PRIMARY KEY(user_id,stage));
  CREATE TRIGGER IF NOT EXISTS cleanup_manifest_no_update BEFORE UPDATE ON cleanup_manifests BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_manifest_no_delete BEFORE DELETE ON cleanup_manifests BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_manifest_no_replace BEFORE INSERT ON cleanup_manifests WHEN EXISTS (SELECT 1 FROM cleanup_manifests WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_item_no_update BEFORE UPDATE ON cleanup_items BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_item_no_delete BEFORE DELETE ON cleanup_items BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_item_no_insert BEFORE INSERT ON cleanup_items WHEN EXISTS (SELECT 1 FROM cleanup_seals WHERE user_id=NEW.user_id) OR EXISTS (SELECT 1 FROM cleanup_items WHERE user_id=NEW.user_id AND kind=NEW.kind AND id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_seal_insert BEFORE INSERT ON cleanup_seals WHEN EXISTS (SELECT 1 FROM cleanup_seals WHERE user_id=NEW.user_id) OR NEW.item_count != (SELECT count(*) FROM cleanup_items WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'invalid seal'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_seal_no_update BEFORE UPDATE ON cleanup_seals BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_seal_no_delete BEFORE DELETE ON cleanup_seals BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_journal_insert BEFORE INSERT ON cleanup_journal WHEN EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=NEW.user_id AND stage=NEW.stage) OR (NEW.stage='ready' AND EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=NEW.user_id)) OR (NEW.stage='files_deleted' AND NOT EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=NEW.user_id AND stage='ready')) OR (NEW.stage='complete' AND NOT EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=NEW.user_id AND stage='files_deleted')) BEGIN SELECT RAISE(ABORT,'invalid stage'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_journal_no_update BEFORE UPDATE ON cleanup_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TRIGGER IF NOT EXISTS cleanup_journal_no_delete BEFORE DELETE ON cleanup_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
  CREATE TABLE IF NOT EXISTS google_login_challenges (nonce TEXT PRIMARY KEY, session_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('login','link')), expires INTEGER NOT NULL);`);
  for (const row of db.prepare('SELECT user_id FROM revoked_users').all()) captureUserIdentities(db, row.user_id);
  const insertTombstone = db.prepare('INSERT OR IGNORE INTO identity_tombstones(identity_hash) VALUES (?)');
  for (const row of db.prepare('SELECT google_sub FROM revoked_google_subs').all()) insertTombstone.run(identityHash('google', row.google_sub));
  const admin = db.prepare('SELECT id, email, role FROM users WHERE id=?').get('legacy-admin');
  if (!admin || admin.email !== 'idhamk654@gmail.com' || admin.role !== 'admin') throw new Error('Identitas admin migrasi tidak valid');
  const accountColumns = db.prepare('PRAGMA table_info(accounts)').all().map(column => column.name);
  if (!accountColumns.includes('owner_id')) {
    db.exec('ALTER TABLE accounts ADD COLUMN owner_id TEXT REFERENCES users(id)');
    db.exec("UPDATE accounts SET owner_id='legacy-admin'");
  }
  if (!accountColumns.includes('role')) db.exec("ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'ordinary' CHECK(role IN ('ordinary','bot'))");
  db.exec(`CREATE TABLE IF NOT EXISTS bot_config (
    account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id),
    model TEXT NOT NULL DEFAULT '', instruction TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    admin_phones TEXT NOT NULL DEFAULT '[]', commands TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS bot_keys (
    id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
    ciphertext BLOB NOT NULL, priority INTEGER NOT NULL CHECK(priority >= 0),
    UNIQUE(account_id,priority)
  );
  CREATE TABLE IF NOT EXISTS bot_config_generation (
    account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id), generation INTEGER NOT NULL DEFAULT 0
  );
  CREATE TRIGGER IF NOT EXISTS bot_generation_account AFTER UPDATE OF role,owner_id ON accounts
  WHEN OLD.role IS NOT NEW.role OR OLD.owner_id IS NOT NEW.owner_id BEGIN
    INSERT INTO bot_config_generation(account_id,generation) VALUES (NEW.id,1)
    ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_key_insert AFTER INSERT ON bot_keys BEGIN
    INSERT INTO bot_config_generation(account_id,generation) VALUES (NEW.account_id,1)
    ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_key_update AFTER UPDATE ON bot_keys BEGIN
    INSERT INTO bot_config_generation(account_id,generation) VALUES (OLD.account_id,1)
    ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
    INSERT INTO bot_config_generation(account_id,generation)
    SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id
    ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_key_delete AFTER DELETE ON bot_keys BEGIN
    INSERT INTO bot_config_generation(account_id,generation) VALUES (OLD.account_id,1)
    ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_config_insert AFTER INSERT ON bot_config BEGIN
    INSERT INTO bot_config_generation VALUES (NEW.account_id,1) ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_config_update AFTER UPDATE ON bot_config BEGIN
    INSERT INTO bot_config_generation VALUES (OLD.account_id,1) ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
    INSERT INTO bot_config_generation SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_config_delete AFTER DELETE ON bot_config BEGIN
    INSERT INTO bot_config_generation VALUES (OLD.account_id,1) ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_user AFTER UPDATE OF role,google_sub ON users BEGIN
    INSERT INTO bot_config_generation SELECT id,1 FROM accounts WHERE owner_id=NEW.id AND role='bot' ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_revoke AFTER INSERT ON revoked_google_subs BEGIN
    INSERT INTO bot_config_generation SELECT a.id,1 FROM accounts a JOIN users u ON u.id=a.owner_id WHERE u.google_sub=NEW.google_sub AND a.role='bot' ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TRIGGER IF NOT EXISTS bot_generation_unrevoke AFTER DELETE ON revoked_google_subs BEGIN
    INSERT INTO bot_config_generation SELECT a.id,1 FROM accounts a JOIN users u ON u.id=a.owner_id WHERE u.google_sub=OLD.google_sub AND a.role='bot' ON CONFLICT(account_id) DO UPDATE SET generation=generation+1;
  END;
  CREATE TABLE IF NOT EXISTS bot_message_reservations (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, chat_jid TEXT NOT NULL,
    sender_jid TEXT NOT NULL, message_id TEXT NOT NULL, reserved_at INTEGER NOT NULL,
    PRIMARY KEY(account_id,chat_jid,sender_jid,message_id)
  );
  CREATE INDEX IF NOT EXISTS bot_message_retention ON bot_message_reservations(reserved_at);
  CREATE TABLE IF NOT EXISTS bot_welcomes (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, sender_jid TEXT NOT NULL,
    reserved_at INTEGER NOT NULL, PRIMARY KEY(account_id,sender_jid)
  );`);
  const templateColumns = db.prepare('PRAGMA table_info(templates)').all().map(column => column.name);
  if (!templateColumns.includes('owner_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN owner_id TEXT REFERENCES users(id)');
    db.exec("UPDATE templates SET owner_id='legacy-admin'");
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS accounts_owner_insert BEFORE INSERT ON accounts WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'owner required'); END;
    CREATE TRIGGER IF NOT EXISTS accounts_owner_update BEFORE UPDATE OF owner_id ON accounts WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'owner required'); END;
    CREATE TRIGGER IF NOT EXISTS accounts_bot_insert BEFORE INSERT ON accounts WHEN NEW.role='bot' AND NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.owner_id AND role='admin') BEGIN SELECT RAISE(ABORT, 'bot requires admin owner'); END;
    CREATE TRIGGER IF NOT EXISTS accounts_bot_update BEFORE UPDATE OF owner_id,role ON accounts WHEN NEW.role='bot' AND NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.owner_id AND role='admin') BEGIN SELECT RAISE(ABORT, 'bot requires admin owner'); END;
    CREATE TRIGGER IF NOT EXISTS users_bot_update BEFORE UPDATE OF role ON users WHEN NEW.role!='admin' AND EXISTS (SELECT 1 FROM accounts WHERE owner_id=NEW.id AND role='bot') BEGIN SELECT RAISE(ABORT, 'bot requires admin owner'); END;
    CREATE TRIGGER IF NOT EXISTS templates_owner_insert BEFORE INSERT ON templates WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'owner required'); END;
    CREATE TRIGGER IF NOT EXISTS templates_owner_update BEFORE UPDATE OF owner_id ON templates WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT, 'owner required'); END;`);
  if (!columns.includes('enabled')) {
    db.exec('ALTER TABLE schedules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
    db.exec('UPDATE schedules SET enabled=0 WHERE next_at IS NULL');
  }
  if (!columns.includes('revision')) db.exec('ALTER TABLE schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('last_at')) db.exec('ALTER TABLE schedules ADD COLUMN last_at TEXT');
  db.exec('COMMIT');
} catch (err) { db.exec('ROLLBACK'); throw err; }
