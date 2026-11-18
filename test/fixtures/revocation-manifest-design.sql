PRAGMA foreign_keys=ON;
CREATE TABLE manifest (
  user_id TEXT PRIMARY KEY NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE TABLE manifest_item (
  user_id TEXT NOT NULL REFERENCES manifest(user_id),
  kind TEXT NOT NULL CHECK(kind IN ('account','upload_v2','upload_legacy')),
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY(user_id,kind,id)
);
CREATE TABLE manifest_seal (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES manifest(user_id),
  item_count INTEGER NOT NULL CHECK(item_count >= 0),
  digest TEXT NOT NULL CHECK(length(digest)=64)
);
CREATE TABLE cleanup_journal (
  seq INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES manifest_seal(user_id),
  stage TEXT NOT NULL CHECK(stage IN ('files_complete','database_complete','complete')),
  UNIQUE(user_id,stage)
);
CREATE TRIGGER manifest_no_update BEFORE UPDATE ON manifest BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER manifest_no_delete BEFORE DELETE ON manifest BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER item_no_update BEFORE UPDATE ON manifest_item BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER item_no_delete BEFORE DELETE ON manifest_item BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER item_no_insert_after_seal BEFORE INSERT ON manifest_item WHEN EXISTS (SELECT 1 FROM manifest_seal WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'sealed'); END;
CREATE TRIGGER seal_count BEFORE INSERT ON manifest_seal WHEN NEW.item_count != (SELECT count(*) FROM manifest_item WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'count mismatch'); END;
CREATE TRIGGER seal_no_update BEFORE UPDATE ON manifest_seal BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER seal_no_delete BEFORE DELETE ON manifest_seal BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER journal_no_update BEFORE UPDATE ON cleanup_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON cleanup_journal BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER journal_order BEFORE INSERT ON cleanup_journal WHEN
  (NEW.stage='database_complete' AND NOT EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=NEW.user_id AND stage='files_complete')) OR
  (NEW.stage='complete' AND NOT EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=NEW.user_id AND stage='database_complete'))
  BEGIN SELECT RAISE(ABORT,'stage order'); END;
