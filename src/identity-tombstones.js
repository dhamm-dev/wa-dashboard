import { createHash } from 'node:crypto';

export const normalizeEmail = email => email.trim().toLowerCase();
export function identityHash(type, value) {
  if (!['google', 'email'].includes(type) || typeof value !== 'string' || !value) throw new Error('Invalid identity');
  const canonical = type === 'email' ? normalizeEmail(value) : value;
  if (!canonical) throw new Error('Invalid identity');
  return createHash('sha256').update(`dhexbot:identity-tombstone:v1:${type}\0`, 'utf8').update(canonical, 'utf8').digest('hex');
}
export function isTombstoned(db, type, value) {
  return !!db.prepare('SELECT 1 FROM identity_tombstones WHERE identity_hash=?').get(identityHash(type, value));
}
export function captureUserIdentities(db, userId) {
  const user = db.prepare('SELECT google_sub FROM users WHERE id=?').get(userId);
  const insert = db.prepare('INSERT OR IGNORE INTO identity_tombstones(identity_hash) VALUES (?)');
  if (user?.google_sub) insert.run(identityHash('google', user.google_sub));
  for (const row of db.prepare('SELECT email FROM email_credentials WHERE user_id=?').all(userId)) insert.run(identityHash('email', row.email));
}
