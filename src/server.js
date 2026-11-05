import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, dataDir } from './db.js';
import { connect, groups, repair, state, whatsappContacts } from './whatsapp.js';
import { send, recoverPending } from './sender.js';
import { tick } from './worker.js';
import { wibToIso } from './schedule.js';
import { validateAttachment } from './attachment.js';

const password = process.env.ADMIN_PASSWORD;
const secret = process.env.SESSION_SECRET;
if (!password || !secret || secret.length < 32) throw new Error('ADMIN_PASSWORD wajib diisi dan SESSION_SECRET minimal 32 karakter wajib diatur');
const passwordHash = scryptSync(password, 'wa-dashboard-admin', 64);
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '32kb' }));
app.use(session({ secret, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 12 * 3600000 } }));
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const validText = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const account = id => {
  const row = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
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
  attempts.delete(ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Gagal memulai sesi' });
    req.session.authenticated = true;
    res.json({ ok: true, eventCursor: db.prepare('SELECT coalesce(max(seq),0) AS cursor FROM history_events').get().cursor });
  });
});
app.use('/api', (req, res, next) => {
  if (!req.session.authenticated) return res.status(401).json({ error: 'Silakan masuk' });
  if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Dashboard-Request') !== '1') return res.status(403).json({ error: 'Permintaan ditolak' });
  next();
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, eventCursor: db.prepare('SELECT coalesce(max(seq),0) AS cursor FROM history_events').get().cursor }));
app.get('/api/accounts', (req, res) => res.set('Cache-Control', 'no-store').json(db.prepare('SELECT * FROM accounts ORDER BY name').all().map(a => ({ ...a, ...state(a.id) }))));
app.post('/api/accounts', asyncRoute(async (req, res) => {
  if (!validText(req.body.name, 80)) throw new Error('Nama akun wajib diisi');
  const id = randomUUID();
  db.prepare('INSERT INTO accounts(id,name) VALUES (?,?)').run(id, req.body.name.trim());
  connect(id).catch(console.error);
  res.status(201).json({ id });
}));
app.post('/api/accounts/:id/connect', asyncRoute(async (req, res) => { account(req.params.id); await connect(req.params.id); res.json({ ok: true }); }));
app.post('/api/accounts/:id/repair', asyncRoute(async (req, res) => { account(req.params.id); await repair(req.params.id); res.json({ ok: true }); }));
app.get('/api/accounts/:id/groups', asyncRoute(async (req, res) => { account(req.params.id); res.set('Cache-Control', 'no-store').json(await groups(req.params.id)); }));
app.get('/api/accounts/:id/whatsapp-contacts', (req, res) => { account(req.params.id); res.set('Cache-Control', 'no-store').json(whatsappContacts(req.params.id)); });
app.get('/api/contacts', (req, res) => { account(req.query.accountId); res.set('Cache-Control', 'no-store').json(db.prepare('SELECT * FROM contacts WHERE account_id=? ORDER BY name').all(req.query.accountId)); });
app.post('/api/contacts', (req, res) => {
  account(req.body.accountId);
  if (!validText(req.body.name, 100)) throw new Error('Nama kontak wajib diisi');
  const jid = destination(req.body.jid);
  if (!jid.endsWith('@s.whatsapp.net')) throw new Error('Kontak harus berupa nomor WhatsApp');
  db.prepare('INSERT INTO contacts VALUES (?,?,?,?)').run(randomUUID(), req.body.accountId, req.body.name.trim(), jid);
  res.status(201).json({ ok: true });
});
app.delete('/api/contacts/:id', (req, res) => { db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id); res.json({ ok: true }); });
app.get('/api/templates', (req, res) => res.json(db.prepare('SELECT * FROM templates ORDER BY name').all()));
app.post('/api/templates', (req, res) => {
  if (!validText(req.body.name, 100) || !validText(req.body.text)) throw new Error('Nama dan isi template wajib diisi');
  db.prepare('INSERT INTO templates VALUES (?,?,?)').run(randomUUID(), req.body.name.trim(), req.body.text);
  res.status(201).json({ ok: true });
});
app.delete('/api/templates/:id', (req, res) => { db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id); res.json({ ok: true }); });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
app.post('/api/attachments', upload.single('file'), asyncRoute(async (req, res) => {
  account(req.body.accountId);
  const f = req.file;
  if (!f) throw new Error('Pilih lampiran');
  const { name, mime } = validateAttachment(f);
  const id = randomUUID();
  await mkdir(join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, 'uploads', id), f.buffer, { flag: 'wx', mode: 0o600 });
  db.prepare('INSERT INTO attachments VALUES (?,?,?,?)').run(id, req.body.accountId, name, mime);
  res.status(201).json({ id, name });
}));
app.post('/api/messages', asyncRoute(async (req, res) => {
  const { accountId, text = '', attachmentId, repeat, at } = req.body;
  account(accountId);
  const jid = destination(req.body.jid);
  if (typeof text !== 'string' || text.length > 4000 || (!text.trim() && !attachmentId)) throw new Error('Isi pesan atau lampiran wajib diisi');
  const attachment = attachmentFor(attachmentId, accountId);
  if (!repeat || repeat === 'now') return res.json(await send(accountId, jid, text, attachment));
  if (!['once', 'weekly'].includes(repeat)) throw new Error('Pengulangan tidak valid');
  const time = wibToIso(at);
  if (Date.parse(time) <= Date.now() + 15000) throw new Error('Pilih waktu setidaknya 15 detik dari sekarang');
  db.prepare('INSERT INTO schedules(id,account_id,jid,text,attachment_id,repeat,next_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), accountId, jid, text, attachment, repeat, time, new Date().toISOString());
  res.status(201).json({ status: 'scheduled' });
}));
app.get('/api/schedules', (req, res) => {
  const conditions = []; const params = [];
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
  const row = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.id);
  if (!row) { res.status(404).json({ error: 'Jadwal tidak ditemukan' }); return null; }
  if (!Number.isSafeInteger(req.body?.revision) || req.body.revision !== row.revision) { res.status(409).json({ error: 'Jadwal berubah. Perbarui daftar lalu coba lagi.' }); return null; }
  if (row.enabled && row.next_at && Date.parse(row.next_at) <= Date.now()) { res.status(409).json({ error: 'Jadwal jatuh tempo sedang diproses. Perbarui daftar lalu coba lagi.' }); return null; }
  return row;
};
app.put('/api/schedules/:id', (req, res) => {
  const row = scheduleFor(req, res); if (!row) return;
  const { accountId, text, repeat, at, attachmentId } = req.body;
  account(accountId);
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
  const conditions = []; const params = [];
  for (const [key, column] of [['accountId', 'account_id'], ['status', 'status']]) if (req.query[key]) { conditions.push(`${column}=?`); params.push(req.query[key]); }
  if (req.query.destination) { conditions.push('jid LIKE ?'); params.push(`%${String(req.query.destination).slice(0, 100)}%`); }
  if (req.query.from) { conditions.push('created_at>=?'); params.push(wibToIso(`${req.query.from}T00:00`)); }
  if (req.query.to) { conditions.push('created_at<?'); params.push(new Date(Date.parse(wibToIso(`${req.query.to}T00:00`)) + 86400000).toISOString()); }
  res.json(db.prepare(`SELECT * FROM history ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`).all(...params));
});
app.get('/api/history-events', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.cursor === undefined) return res.json({ cursor: db.prepare('SELECT coalesce(max(seq),0) AS cursor FROM history_events').get().cursor, events: [], hasMore: false });
  const raw = String(req.query.cursor);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return res.status(400).json({ error: 'Cursor tidak valid' });
  const rows = db.prepare('SELECT e.seq, h.* FROM history_events e JOIN history h ON h.id=e.history_id WHERE e.seq>? ORDER BY e.seq LIMIT 101').all(Number(raw));
  const hasMore = rows.length > 100;
  const events = rows.slice(0, 100);
  res.json({ events, cursor: events.length ? events[events.length - 1].seq : Number(raw), hasMore });
});
app.use(express.static(new URL('../public', import.meta.url).pathname, { index: 'index.html' }));
app.use((err, req, res, next) => { console.error(err); res.status(400).json({ error: err.message || 'Permintaan gagal' }); });

recoverPending();
await tick({ startup: true });
for (const row of db.prepare('SELECT id FROM accounts').all()) connect(row.id).catch(console.error);
setInterval(() => tick().catch(console.error), 1000).unref();
app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log('WA Dashboard berjalan'));
