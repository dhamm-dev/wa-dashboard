import { createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stages = ['ready', 'files_deleted', 'complete'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const order = (a, b) => compare(a.kind, b.kind) || compare(a.id, b.id) || compare(a.account_id, b.account_id);
const hash = (userId, requestedAt, items) => createHash('sha256').update(JSON.stringify([1, userId, requestedAt, items.map(i => [i.kind, i.id, i.account_id, i.ready])])).digest('hex');
const validId = id => typeof id === 'string' && uuid.test(id);

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function readManifest(db, userId) {
  const manifest = db.prepare('SELECT m.user_id,m.requested_at,m.version,s.item_count,s.digest,r.requested_at AS revoked_at FROM cleanup_manifests m JOIN cleanup_seals s ON s.user_id=m.user_id JOIN revoked_users r ON r.user_id=m.user_id WHERE m.user_id=?').get(userId);
  if (!manifest || manifest.version !== 1 || manifest.requested_at !== manifest.revoked_at) throw new Error('Invalid cleanup manifest context');
  const items = db.prepare('SELECT kind,id,account_id,ready FROM cleanup_items WHERE user_id=?').all(userId).sort(order);
  if (items.length !== manifest.item_count || hash(userId, manifest.requested_at, items) !== manifest.digest) throw new Error('Invalid cleanup manifest digest');
  const entries = db.prepare('SELECT stage FROM cleanup_journal WHERE user_id=?').all(userId).map(row => row.stage);
  const stage = stages.filter(s => entries.includes(s));
  if (!stage.length || stage.length !== entries.length || stage.some((s, i) => s !== stages[i])) throw new Error('Invalid cleanup journal');
  return { userId, requestedAt: manifest.requested_at, version: 1, digest: manifest.digest, items, stage: stage.at(-1) };
}

function build(db, userId) {
  const revoked = db.prepare('SELECT r.requested_at,u.role FROM revoked_users r JOIN users u ON u.id=r.user_id WHERE r.user_id=?').get(userId);
  if (!revoked || revoked.role !== 'customer' || typeof userId !== 'string' || !userId || typeof revoked.requested_at !== 'string' || !revoked.requested_at) throw new Error('Invalid revocation context');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid database foreign keys');
  const accounts = db.prepare('SELECT id FROM accounts WHERE owner_id=?').all(userId);
  const uploads = db.prepare('SELECT u.id,u.account_id,u.ready FROM upload_files u JOIN accounts a ON a.id=u.account_id WHERE a.owner_id=?').all(userId);
  const attachments = db.prepare('SELECT t.id,t.account_id FROM attachments t JOIN accounts a ON a.id=t.account_id WHERE a.owner_id=?').all(userId);
  const conflict = db.prepare(`SELECT 1 FROM attachments t JOIN upload_files u ON u.id=t.id JOIN accounts ta ON ta.id=t.account_id JOIN accounts ua ON ua.id=u.account_id WHERE (ta.owner_id=? OR ua.owner_id=?) AND (t.account_id!=u.account_id OR u.ready!=1) LIMIT 1`).get(userId, userId);
  const scheduleConflict = db.prepare(`SELECT 1 FROM schedules s JOIN attachments t ON t.id=s.attachment_id JOIN accounts sa ON sa.id=s.account_id JOIN accounts ta ON ta.id=t.account_id WHERE (sa.owner_id=? OR ta.owner_id=?) AND s.account_id!=t.account_id LIMIT 1`).get(userId, userId);
  if (conflict || scheduleConflict) throw new Error('Inconsistent cleanup ownership');
  const items = [
    ...accounts.map(a => ({ kind: 'account', id: a.id, account_id: a.id, ready: null })),
    ...attachments.map(a => ({ kind: 'attachment', id: a.id, account_id: a.account_id, ready: null })),
    ...uploads.map(u => ({ kind: 'upload', id: u.id, account_id: u.account_id, ready: u.ready }))
  ].sort(order);
  if (items.some(i => !validId(i.id) || !validId(i.account_id) || (i.kind === 'upload' && i.ready !== 0 && i.ready !== 1))) throw new Error('Invalid cleanup item');
  db.prepare('INSERT INTO cleanup_manifests VALUES (?,?,1)').run(userId, revoked.requested_at);
  const insert = db.prepare('INSERT INTO cleanup_items VALUES (?,?,?,?,?)');
  for (const i of items) insert.run(userId, i.kind, i.id, i.account_id, i.ready);
  db.prepare('INSERT INTO cleanup_seals VALUES (?,?,?)').run(userId, items.length, hash(userId, revoked.requested_at, items));
  db.prepare("INSERT INTO cleanup_journal VALUES (?,'ready')").run(userId);
  return readManifest(db, userId);
}

export function inventoryRevocations(db) {
  const users = db.prepare('SELECT user_id FROM revoked_users ORDER BY user_id').all();
  for (const { user_id } of users) transaction(db, () => {
    if (db.prepare('SELECT 1 FROM cleanup_manifests WHERE user_id=?').get(user_id)) readManifest(db, user_id);
    else build(db, user_id);
  });
}

export function getCleanupManifest(db, userId) { return readManifest(db, userId); }

export function advanceCleanup(db, userId, expected, next) {
  if (stages.indexOf(expected) < 0 || stages.indexOf(next) !== stages.indexOf(expected) + 1) throw new Error('Invalid cleanup transition');
  return transaction(db, () => {
    const manifest = readManifest(db, userId);
    if (manifest.stage !== expected) throw new Error('Cleanup stage changed');
    const result = db.prepare('INSERT INTO cleanup_journal(user_id,stage) SELECT ?,? WHERE EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=? AND stage=?) AND NOT EXISTS (SELECT 1 FROM cleanup_journal WHERE user_id=? AND stage=?)').run(userId, next, userId, expected, userId, next);
    if (result.changes !== 1) throw new Error('Cleanup stage changed');
    return readManifest(db, userId);
  });
}
