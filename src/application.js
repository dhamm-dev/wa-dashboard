import { privatePreview } from './private-preview.js';
import './instance-lock.js';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { connect, fenceAccount, groups, pairingCode, repair, state, whatsappContacts } from './whatsapp.js';
import { send, recoverPending } from './sender.js';
import { tick } from './worker.js';
import { wibToIso } from './schedule.js';
import { validateAttachment } from './attachment.js';
import { verifyGoogleToken } from './google-auth.js';
import { androidGoogleAuth } from './android-google-auth.js';
import { storeUpload, recoverUploads } from './upload-store.js';
import { initMediaTemp } from './media-temp.js';
import { emailAuth } from './email-auth.js';
import { botConfigRouter } from './bot-config.js';
import { captureUserIdentities, isTombstoned } from './identity-tombstones.js';
import { inventoryRevocations } from './cleanup-journal.js';
import { publicSignupEnabled } from './signup-policy.js';

const password = process.env.ADMIN_PASSWORD;
const secret = process.env.SESSION_SECRET;
if (!password || !secret || secret.length < 32) throw new Error('ADMIN_PASSWORD wajib diisi dan SESSION_SECRET minimal 32 karakter wajib diatur');
const passwordHash = scryptSync(password, 'wa-dashboard-admin', 64);
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.get(['/api/schedules', '/api/history'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api/accounts/:id/pairing-code', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '32kb' }));
app.use(session({ secret, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 12 * 3600000 } }));
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const email = emailAuth({ db });
app.get('/api/auth/options', (req, res) => res.set('Cache-Control', 'no-store').json({ publicSignup: publicSignupEnabled() }));
app.post('/api/email/register', asyncRoute(email.register));
app.post('/api/email/login', asyncRoute(email.login));
const validText = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const account = (req, id) => {
  const row = db.prepare("SELECT * FROM accounts WHERE id=? AND owner_id=? AND (?='admin' OR role='ordinary')").get(id, req.user.id, req.user.role);
  if (!row) throw new Error('Akun tidak ditemukan');
  return row;
};
const destination = value => {
  if (typeof value !== 'string' || !/^(?:[1-9]\d{5,19}@s\.whatsapp\.net|\d{5,25}(?:-\d{1,25})?@g\.us)$/.test(value)) throw new Error('Tujuan tidak valid');
  return value;
};
const attachmentFor = (id, accountId) => {
  if (id && !db.prepare('SELECT id FROM attachments WHERE id=? AND account_id=?').get(id, accountId)) throw new Error('Lampiran tidak ditemukan pada akun ini');
  return id || null;
};
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const previous = attempts.get(ip) || { count: 0, until: 0 };
  if (previous.until > Date.now()) return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  const supplied = typeof req.body.password === 'string' ? req.body.password : '';
  const ok = timingSafeEqual(scryptSync(supplied, 'wa-dashboard-admin', 64), passwordHash);
  if (!ok) {
    previous.count++;
    if (previous.count >= 5) { previous.count = 0; previous.until = Date.now() + 15 * 60000; }
    attempts.set(ip, previous);
    return res.status(401).json({ error: 'Kata sandi salah' });
  }
  const eligible = () => db.prepare("SELECT id,role FROM users WHERE id='legacy-admin' AND role='admin' AND NOT EXISTS (SELECT 1 FROM revoked_users WHERE user_id=users.id) AND (google_sub IS NULL OR NOT EXISTS (SELECT 1 FROM revoked_google_subs WHERE google_sub=users.google_sub))").get();
  if (!eligible()) return res.status(401).json({ error: 'Autentikasi gagal' });
  attempts.delete(ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Gagal memulai sesi' });
    const user = eligible();
    if (!user) return res.status(401).json({ error: 'Autentikasi gagal' });
    req.session.authenticated = true;
    req.session.userId = 'legacy-admin';
    res.json({ ok: true, eventCursor: eventCursor(user.id, user.role) });
  });
});
const androidGoogle = androidGoogleAuth({ db, clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri: process.env.GOOGLE_ANDROID_REDIRECT_URI });
const androidGoogleHttps = (req, res, next) => req.secure && process.env.COOKIE_SECURE === 'true' ? next() : res.status(403).set('Cache-Control', 'no-store').json({ error: 'HTTPS diperlukan' });
app.post('/api/google/android/start', androidGoogleHttps, androidGoogle.start);
app.get('/api/google/android/callback', androidGoogleHttps, asyncRoute(androidGoogle.callback));
app.post('/api/google/android/poll', androidGoogleHttps, androidGoogle.poll);
app.post('/api/google/challenge', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Login Google tidak tersedia' });
  if (req.get('X-Dashboard-Request') !== '1') return res.status(403).json({ error: 'Permintaan ditolak' });
  const purpose = req.body?.purpose;
  if (!['login', 'link'].includes(purpose)) return res.status(400).json({ error: 'Permintaan tidak valid' });
  if (purpose === 'link' && (!req.session.authenticated || req.session.userId !== 'legacy-admin')) return res.status(403).json({ error: 'Permintaan ditolak' });
  const nonce = randomBytes(32).toString('base64url');
  req.session.googleChallenge = true;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Gagal memulai sesi' });
    db.prepare('DELETE FROM google_login_challenges WHERE expires<? OR session_id=?').run(Date.now(), req.sessionID);
    db.prepare('INSERT INTO google_login_challenges VALUES (?,?,?,?)').run(nonce, req.sessionID, purpose, Date.now() + 300000);
    res.set('Cache-Control', 'no-store').json({ nonce, clientId: process.env.GOOGLE_CLIENT_ID });
  });
});
app.post('/api/google/login', asyncRoute(async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Login Google tidak tersedia' });
  if (req.get('X-Dashboard-Request') !== '1') return res.status(403).json({ error: 'Permintaan ditolak' });
  const nonce = req.body?.nonce;
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return res.status(401).json({ error: 'Login gagal' });
  const challenge = db.prepare('DELETE FROM google_login_challenges WHERE nonce=? AND session_id=? RETURNING purpose,expires').get(nonce, req.sessionID);
  if (!challenge || challenge.expires <= Date.now() || (challenge.purpose === 'link' && (!req.session.authenticated || req.session.userId !== 'legacy-admin'))) return res.status(401).json({ error: 'Login gagal' });
  let claims;
  try { claims = await verifyGoogleToken(req.body?.credential, { audience: process.env.GOOGLE_CLIENT_ID, nonce }); }
  catch { return res.status(401).json({ error: 'Login gagal' }); }
  let user;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (isTombstoned(db, 'google', claims.sub) || db.prepare('SELECT 1 FROM revoked_google_subs WHERE google_sub=?').get(claims.sub)) throw new Error('Akses tidak tersedia');
    user = db.prepare('SELECT id,role FROM users WHERE google_sub=?').get(claims.sub);
    if (user && db.prepare('SELECT 1 FROM revoked_users WHERE user_id=?').get(user.id)) throw new Error('Akses tidak tersedia');
    if (challenge.purpose === 'link') {
      const admin = db.prepare("SELECT google_sub,email FROM users WHERE id='legacy-admin' AND role='admin'").get();
      if (!admin || claims.email_verified !== true || claims.email !== admin.email || (admin.google_sub && admin.google_sub !== claims.sub) || (user && user.id !== 'legacy-admin')) throw new Error('Akses tidak tersedia');
      db.prepare("UPDATE users SET google_sub=? WHERE id='legacy-admin' AND google_sub IS NULL").run(claims.sub);
      user = { id: 'legacy-admin', role: 'admin' };
    } else if (!user) {
      if (!publicSignupEnabled()) throw new Error('Akses tidak tersedia');
      if (claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 254 || !claims.email.includes('@')) throw new Error('Akses tidak tersedia');
      user = { id: randomUUID(), role: 'customer' };
      db.prepare('INSERT INTO users(id,email,google_sub,role) VALUES (?,?,?,?)').run(user.id, claims.email, claims.sub, user.role);
    }
    db.exec('COMMIT');
  } catch {
    db.exec('ROLLBACK');
    return res.status(403).json({ error: 'Akses tidak tersedia' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Gagal memulai sesi' });
    if (isTombstoned(db, 'google', claims.sub) || db.prepare('SELECT 1 FROM revoked_users WHERE user_id=?').get(user.id)) return res.status(403).json({ error: 'Akses tidak tersedia' });
    req.session.authenticated = true;
    req.session.userId = user.id;
    res.set('Cache-Control', 'no-store').json({ ok: true, eventCursor: eventCursor(user.id, user.role) });
  });
}));
app.use('/api', (req, res, next) => {
  if (!req.session.authenticated) return res.status(401).json({ error: 'Silakan masuk' });
  req.user = db.prepare('SELECT id,role FROM users WHERE id=? AND NOT EXISTS (SELECT 1 FROM revoked_users WHERE user_id=users.id) AND (google_sub IS NULL OR NOT EXISTS (SELECT 1 FROM revoked_google_subs WHERE revoked_google_subs.google_sub=users.google_sub))').get(req.session.userId || '');
  if (!req.user) return res.status(401).json({ error: 'Silakan masuk' });
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Dashboard-Request') !== '1') return res.status(403).json({ error: 'Permintaan ditolak' });
  next();
});
const eventCursor = (userId, role) => db.prepare("SELECT coalesce(max(e.seq),0) AS cursor FROM history_events e JOIN history h ON h.id=e.history_id JOIN accounts a ON a.id=h.account_id WHERE a.owner_id=? AND (?='admin' OR a.role='ordinary')").get(userId, role).cursor;
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, role: req.user.role, eventCursor: eventCursor(req.user.id, req.user.role) }));
app.post('/api/admin/users/:id/revoke', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Permintaan ditolak' });
  if (privatePreview) return res.status(503).json({ error: 'Pencabutan dan pembersihan data pelanggan tidak tersedia selama private preview' });
  db.exec('BEGIN IMMEDIATE');
  let ids;
  try {
    const user = db.prepare("SELECT id,google_sub FROM users WHERE id=? AND role='customer'").get(req.params.id);
    if (!user) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'Pengguna tidak ditemukan' }); }
    db.prepare('INSERT OR IGNORE INTO revoked_users VALUES (?,?)').run(user.id, new Date().toISOString());
    captureUserIdentities(db, user.id);
    if (user.google_sub) db.prepare('INSERT OR IGNORE INTO revoked_google_subs VALUES (?)').run(user.google_sub);
    ids = db.prepare('SELECT id FROM accounts WHERE owner_id=?').all(user.id).map(row => row.id);
    db.prepare('UPDATE schedules SET enabled=0,revision=revision+1 WHERE enabled=1 AND account_id IN (SELECT id FROM accounts WHERE owner_id=?)').run(user.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  for (const id of ids) {
    try { fenceAccount(id).catch(() => console.error('Gagal menutup sesi WhatsApp yang dicabut')); }
    catch { console.error('Gagal menutup sesi WhatsApp yang dicabut'); }
  }
  res.status(202).json({ status: 'access_revoked_cleanup_not_implemented' });
});
app.get('/api/admin/users/:id/revoke', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Permintaan ditolak' });
  const row = db.prepare('SELECT requested_at FROM revoked_users WHERE user_id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Status tidak ditemukan' });
  res.json({ status: 'access_revoked_cleanup_not_implemented', requestedAt: row.requested_at });
});
app.use('/api/accounts/:id/bot-config', botConfigRouter({ db }));
app.get('/api/accounts', (req, res) => res.set('Cache-Control', 'no-store').json(db.prepare("SELECT * FROM accounts WHERE owner_id=? AND (?='admin' OR role='ordinary') ORDER BY name").all(req.user.id, req.user.role).map(a => ({ ...a, ...state(a.id) }))));
app.post('/api/accounts', asyncRoute(async (req, res) => {
  if (!validText(req.body.name, 80)) throw new Error('Nama akun wajib diisi');
  const id = randomUUID();
  if (req.body.role !== undefined && !['ordinary', 'bot'].includes(req.body.role)) throw new Error('Role akun tidak valid');
  const role = req.body.role || 'ordinary';
  if (role === 'bot' && req.user.role !== 'admin') return res.status(403).json({ error: 'Permintaan ditolak' });
  db.prepare('INSERT INTO accounts(id,name,owner_id,role) VALUES (?,?,?,?)').run(id, req.body.name.trim(), req.user.id, role);
  connect(id).catch(console.error);
  res.status(201).json({ id });
}));
app.put('/api/accounts/:id/role', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Permintaan ditolak' });
  const { expectedRole, role } = req.body || {};
  if (!['ordinary', 'bot'].includes(expectedRole) || !['ordinary', 'bot'].includes(role) || expectedRole === role) return res.status(400).json({ error: 'Role akun tidak valid' });
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT role FROM accounts WHERE id=? AND owner_id=?').get(req.params.id, req.user.id);
    if (!row) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'Akun tidak ditemukan' }); }
    if (row.role !== expectedRole) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Role akun berubah. Perbarui daftar lalu coba lagi.' }); }
    let pausedSchedules = 0;
    if (role === 'bot') pausedSchedules = db.prepare('UPDATE schedules SET enabled=0, revision=revision+1 WHERE account_id=? AND enabled=1').run(req.params.id).changes;
    db.prepare('UPDATE accounts SET role=? WHERE id=? AND owner_id=? AND role=?').run(role, req.params.id, req.user.id, expectedRole);
    db.exec('COMMIT');
    res.json({ ok: true, role, pausedSchedules });
  } catch (error) { db.exec('ROLLBACK'); throw error; }
});
app.post('/api/accounts/:id/connect', asyncRoute(async (req, res) => { account(req, req.params.id); await connect(req.params.id); res.json({ ok: true }); }));
app.post('/api/accounts/:id/repair', asyncRoute(async (req, res) => { account(req, req.params.id); await repair(req.params.id); res.json({ ok: true }); }));
const pairingUsers = new Map();
app.post('/api/accounts/:id/pairing-code', asyncRoute(async (req, res) => {
  try { account(req, req.params.id); } catch { return res.status(404).json({ error: 'Akun tidak ditemukan' }); }
  const phone = req.body?.phone;
  if (typeof phone !== 'string' || !/^[1-9][0-9]{5,14}$/.test(phone)) return res.status(400).json({ error: 'Nomor telepon tidak valid' });
  const now = Date.now();
  for (const [id, limit] of pairingUsers) if (limit.until <= now) pairingUsers.delete(id);
  const limit = pairingUsers.get(req.user.id);
  if (limit?.count >= 5 || (!limit && pairingUsers.size >= 10000)) return res.status(429).json({ error: 'Terlalu banyak permintaan kode pairing' });
  if (limit) limit.count++; else pairingUsers.set(req.user.id, { count: 1, until: now + 600000 });
  try { res.json({ code: await pairingCode(req.params.id, phone) }); }
  catch (error) {
    const message = ['Nomor telepon tidak valid', 'Akun belum siap untuk kode pairing', 'Terlalu banyak permintaan kode pairing'].includes(error.message) ? error.message : 'Kode pairing tidak tersedia';
    res.status(message.startsWith('Terlalu') ? 429 : 409).json({ error: message });
  }
}));
app.get('/api/accounts/:id/groups', asyncRoute(async (req, res) => { account(req, req.params.id); res.set('Cache-Control', 'no-store').json(await groups(req.params.id)); }));
app.get('/api/accounts/:id/whatsapp-contacts', (req, res) => { account(req, req.params.id); res.set('Cache-Control', 'no-store').json(whatsappContacts(req.params.id)); });
app.get('/api/contacts', (req, res) => { account(req, req.query.accountId); res.set('Cache-Control', 'no-store').json(db.prepare('SELECT * FROM contacts WHERE account_id=? ORDER BY name').all(req.query.accountId)); });
app.post('/api/contacts', (req, res) => {
  account(req, req.body.accountId);
  if (!validText(req.body.name, 100)) throw new Error('Nama kontak wajib diisi');
  const jid = destination(req.body.jid);
  if (!jid.endsWith('@s.whatsapp.net')) throw new Error('Kontak harus berupa nomor WhatsApp');
  db.prepare('INSERT INTO contacts VALUES (?,?,?,?)').run(randomUUID(), req.body.accountId, req.body.name.trim(), jid);
  res.status(201).json({ ok: true });
});
app.delete('/api/contacts/:id', (req, res) => { db.prepare("DELETE FROM contacts WHERE id=? AND account_id IN (SELECT id FROM accounts WHERE owner_id=? AND (?='admin' OR role='ordinary'))").run(req.params.id, req.user.id, req.user.role); res.json({ ok: true }); });
app.get('/api/templates', (req, res) => res.json(db.prepare('SELECT * FROM templates WHERE owner_id=? ORDER BY name').all(req.user.id)));
app.post('/api/templates', (req, res) => {
  if (!validText(req.body.name, 100) || !validText(req.body.text)) throw new Error('Nama dan isi template wajib diisi');
  db.prepare('INSERT INTO templates(id,name,text,owner_id) VALUES (?,?,?,?)').run(randomUUID(), req.body.name.trim(), req.body.text, req.user.id);
  res.status(201).json({ ok: true });
});
app.delete('/api/templates/:id', (req, res) => { db.prepare('DELETE FROM templates WHERE id=? AND owner_id=?').run(req.params.id, req.user.id); res.json({ ok: true }); });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.post('/api/attachments', upload.single('file'), asyncRoute(async (req, res) => {
  account(req, req.body.accountId);
  const f = req.file;
  if (!f) throw new Error('Pilih lampiran');
  const { name, mime } = validateAttachment(f);
  const id = await storeUpload(req.body.accountId, name, mime, f.buffer);
  res.status(201).json({ id, name });
}));
app.post('/api/messages', asyncRoute(async (req, res) => {
  const { accountId, text = '', attachmentId, repeat, at } = req.body;
  const messageAccount = account(req, accountId);
  const jid = destination(req.body.jid);
  if (typeof text !== 'string' || text.length > 4000 || (!text.trim() && !attachmentId)) throw new Error('Isi pesan atau lampiran wajib diisi');
  const attachment = attachmentFor(attachmentId, accountId);
  if (!repeat || repeat === 'now') return res.json(await send(accountId, jid, text, attachment));
  if (messageAccount.role === 'bot') return res.status(409).json({ error: 'Jadwal tidak tersedia untuk akun bot' });
  if (!['once', 'weekly'].includes(repeat)) throw new Error('Pengulangan tidak valid');
  const time = wibToIso(at);
  if (Date.parse(time) <= Date.now() + 15000) throw new Error('Pilih waktu setidaknya 15 detik dari sekarang');
  db.prepare('INSERT INTO schedules(id,account_id,jid,text,attachment_id,repeat,next_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), accountId, jid, text, attachment, repeat, time, new Date().toISOString());
  res.status(201).json({ status: 'scheduled' });
}));
app.get('/api/schedules', (req, res) => {
  const conditions = ["account_id IN (SELECT id FROM accounts WHERE owner_id=? AND (?='admin' OR role='ordinary'))"]; const params = [req.user.id, req.user.role];
  if (req.query.accountId) { conditions.push('account_id=?'); params.push(req.query.accountId); }
  if (req.query.destination) { conditions.push('instr(jid, ?) > 0'); params.push(String(req.query.destination).slice(0, 100)); }
  if (req.query.status) {
    const status = { active: 'enabled=1 AND next_at IS NOT NULL', inactive: 'enabled=0', completed: 'enabled=1 AND next_at IS NULL' }[req.query.status];
    if (!status) throw new Error('Status jadwal tidak valid');
    conditions.push(`(${status})`);
  }
  if (req.query.from) { conditions.push('coalesce(next_at,last_at)>=?'); params.push(wibToIso(`${req.query.from}T00:00`)); }
  if (req.query.to) { conditions.push('coalesce(next_at,last_at)<?'); params.push(new Date(Date.parse(wibToIso(`${req.query.to}T00:00`)) + 86400000).toISOString()); }
  res.json(db.prepare(`SELECT * FROM schedules ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY coalesce(next_at,last_at,created_at) LIMIT 500`).all(...params));
});
const scheduleFor = (req, res) => {
  const row = db.prepare("SELECT * FROM schedules WHERE id=? AND account_id IN (SELECT id FROM accounts WHERE owner_id=? AND (?='admin' OR role='ordinary'))").get(req.params.id, req.user.id, req.user.role);
  if (!row) { res.status(404).json({ error: 'Jadwal tidak ditemukan' }); return null; }
  if (!Number.isSafeInteger(req.body?.revision) || req.body.revision !== row.revision) { res.status(409).json({ error: 'Jadwal berubah. Perbarui daftar lalu coba lagi.' }); return null; }
  if (row.enabled && row.next_at && Date.parse(row.next_at) <= Date.now()) { res.status(409).json({ error: 'Jadwal jatuh tempo sedang diproses. Perbarui daftar lalu coba lagi.' }); return null; }
  return row;
};
app.put('/api/schedules/:id', (req, res) => {
  const row = scheduleFor(req, res); if (!row) return;
  const { accountId, text, repeat, at, attachmentId } = req.body;
  if (account(req, row.account_id).role === 'bot' || account(req, accountId).role === 'bot') return res.status(409).json({ error: 'Jadwal tidak tersedia untuk akun bot' });
  const jid = destination(req.body.jid);
  const attachment = attachmentFor(attachmentId, accountId);
  if (typeof text !== 'string' || text.length > 4000 || (!text.trim() && !attachment)) throw new Error('Isi pesan atau lampiran wajib diisi');
  if (!['once', 'weekly'].includes(repeat)) throw new Error('Pengulangan tidak valid');
  const time = wibToIso(at);
  if (Date.parse(time) <= Date.now() + 15000) throw new Error('Pilih waktu setidaknya 15 detik dari sekarang');
  const result = db.prepare('UPDATE schedules SET account_id=?,jid=?,text=?,attachment_id=?,repeat=?,next_at=?,revision=revision+1 WHERE id=? AND revision=?').run(accountId, jid, text, attachment, repeat, time, row.id, row.revision);
  if (!result.changes) return res.status(409).json({ error: 'Jadwal berubah. Perbarui daftar lalu coba lagi.' });
  res.json({ ok: true });
});
app.post('/api/schedules/:id/enabled', (req, res) => {
  const row = scheduleFor(req, res); if (!row) return;
  const enabled = req.body.enabled;
  if (typeof enabled !== 'boolean') throw new Error('Status jadwal tidak valid');
  if (enabled && account(req, row.account_id).role === 'bot') return res.status(409).json({ error: 'Jadwal tidak tersedia untuk akun bot' });
  if (Boolean(row.enabled) === enabled) return res.json({ ok: true });
  let next = row.next_at;
  if (enabled) {
    if (!next) throw new Error('Ubah jadwal dan pilih waktu baru sebelum mengaktifkan');
    const earliest = Date.now() + 15000;
    if (Date.parse(next) <= earliest) {
      if (row.repeat !== 'weekly') throw new Error('Waktu sudah lewat. Ubah jadwal sebelum mengaktifkan');
      const week = 7 * 86400000;
      next = new Date(Date.parse(next) + (Math.floor((earliest - Date.parse(next)) / week) + 1) * week).toISOString();
    }
  }
  const result = db.prepare('UPDATE schedules SET enabled=?,next_at=?,revision=revision+1 WHERE id=? AND revision=?').run(Number(enabled), next, row.id, row.revision);
  if (!result.changes) return res.status(409).json({ error: 'Jadwal berubah. Perbarui daftar lalu coba lagi.' });
  res.json({ ok: true });
});
app.delete('/api/schedules/:id', (req, res) => {
  const row = scheduleFor(req, res); if (!row) return;
  const result = db.prepare('DELETE FROM schedules WHERE id=? AND revision=?').run(row.id, row.revision);
  if (!result.changes) return res.status(409).json({ error: 'Jadwal berubah. Perbarui daftar lalu coba lagi.' });
  res.json({ ok: true });
});
app.get('/api/history', (req, res) => {
  const conditions = ["account_id IN (SELECT id FROM accounts WHERE owner_id=? AND (?='admin' OR role='ordinary'))"]; const params = [req.user.id, req.user.role];
  for (const [key, column] of [['accountId', 'account_id'], ['status', 'status']]) if (req.query[key]) { conditions.push(`${column}=?`); params.push(req.query[key]); }
  if (req.query.destination) { conditions.push('jid LIKE ?'); params.push(`%${String(req.query.destination).slice(0, 100)}%`); }
  if (req.query.from) { conditions.push('created_at>=?'); params.push(wibToIso(`${req.query.from}T00:00`)); }
  if (req.query.to) { conditions.push('created_at<?'); params.push(new Date(Date.parse(wibToIso(`${req.query.to}T00:00`)) + 86400000).toISOString()); }
  res.json(db.prepare(`SELECT * FROM history ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`).all(...params));
});
app.get('/api/history-events', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.cursor === undefined) return res.json({ cursor: eventCursor(req.user.id, req.user.role), events: [], hasMore: false });
  const raw = String(req.query.cursor);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return res.status(400).json({ error: 'Cursor tidak valid' });
  const rows = db.prepare("SELECT e.seq, h.* FROM history_events e JOIN history h ON h.id=e.history_id JOIN accounts a ON a.id=h.account_id WHERE e.seq>? AND a.owner_id=? AND (?='admin' OR a.role='ordinary') ORDER BY e.seq LIMIT 101").all(Number(raw), req.user.id, req.user.role);
  const hasMore = rows.length > 100;
  const events = rows.slice(0, 100);
  res.json({ events, cursor: events.length ? events[events.length - 1].seq : Number(raw), hasMore });
});
app.use(express.static(new URL('../public', import.meta.url).pathname, { index: 'index.html' }));
app.use((err, req, res, next) => { if (/^\/api\/email(?:\/|$)/.test(req.path) || /^\/api\/accounts\/[^/]+\/(?:pairing-code\/?$|bot-config(?:\/|$))/.test(req.path)) return res.status(400).json({ error: 'Permintaan tidak valid' }); console.error(err); res.status(400).json({ error: err.message || 'Permintaan gagal' }); });

inventoryRevocations(db);
initMediaTemp({ preservePrevious: privatePreview });
if (!privatePreview) await recoverUploads();
recoverPending();
await tick({ startup: true });
for (const row of db.prepare('SELECT id FROM accounts WHERE NOT EXISTS (SELECT 1 FROM revoked_users WHERE user_id=accounts.owner_id)').all()) connect(row.id).catch(console.error);
setInterval(() => tick().catch(console.error), 1000).unref();
app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('WA Dashboard berjalan'));
