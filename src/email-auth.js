import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isTombstoned, normalizeEmail } from './identity-tombstones.js';
import { publicSignupEnabled } from './signup-policy.js';

const derive = promisify(scrypt);
const dummySalt = randomBytes(16);
const dummyHash = randomBytes(64);
const windowMs = 15 * 60 * 1000;
const maxEntries = 4096;

export function emailAuth({ db }) {
  const ips = new Map(), identities = new Map();
  let running = 0;
  function allow(map, key, limit, now) {
    for (const [k, entry] of map) if (entry.until <= now) map.delete(k);
    let entry = map.get(key);
    if (!entry) {
      if (map.size >= maxEntries) return false;
      map.set(key, entry = { count: 0, until: now + windowMs });
    }
    return ++entry.count <= limit;
  }
  async function handle(req, res, register) {
    if (register && !publicSignupEnabled()) return res.set('Cache-Control', 'no-store').status(403).json({ error: 'Autentikasi gagal' });
    const now = Date.now();
    if (!allow(ips, req.ip, 30, now)) return res.status(429).json({ error: 'Terlalu banyak permintaan' });
    const input = req.body?.email;
    const password = req.body?.password;
    const email = typeof input === 'string' && input.length <= 254 ? normalizeEmail(input) : '';
    const validEmail = email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(email) && !email.includes('..');
    const validPassword = typeof password === 'string' && [...password].length >= 12 && Buffer.byteLength(password, 'utf8') <= 256;
    if (!req.is('application/json') || !validEmail || !validPassword) return res.status(400).json({ error: 'Permintaan tidak valid' });
    const key = createHash('sha256').update(email).digest('hex');
    if (!allow(identities, key, 8, now) || running >= 4) return res.status(429).json({ error: 'Terlalu banyak permintaan' });
    running++;
    try {
      const existing = db.prepare('SELECT user_id,salt,password_hash FROM email_credentials WHERE email=?').get(email);
      const salt = register ? randomBytes(16) : (existing?.salt ?? dummySalt);
      const hash = await derive(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
      let userId;
      if (register) {
        userId = randomUUID();
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!publicSignupEnabled() || isTombstoned(db, 'email', email)) throw new Error('Access denied');
          db.prepare("INSERT INTO users(id,email,role) VALUES (?,?,'customer')").run(userId, `email-auth:${userId}`);
          db.prepare('INSERT INTO email_credentials(email,user_id,salt,password_hash) VALUES (?,?,?,?)').run(email, userId, salt, hash);
          db.exec('COMMIT');
        } catch {
          db.exec('ROLLBACK');
          return res.status(401).json({ error: 'Autentikasi gagal' });
        }
      } else {
        const match = timingSafeEqual(hash, existing?.password_hash ?? dummyHash);
        if (!existing || !match || isTombstoned(db, 'email', email) || !db.prepare("SELECT 1 FROM email_credentials c JOIN users u ON u.id=c.user_id WHERE c.email=? AND c.user_id=? AND c.salt=? AND c.password_hash=? AND u.role='customer' AND u.google_sub IS NULL AND NOT EXISTS (SELECT 1 FROM revoked_users WHERE user_id=u.id)").get(email, existing.user_id, existing.salt, existing.password_hash)) return res.status(401).json({ error: 'Autentikasi gagal' });
        userId = existing.user_id;
      }
      await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
      if (isTombstoned(db, 'email', email) || db.prepare('SELECT 1 FROM revoked_users WHERE user_id=?').get(userId)) return res.status(401).json({ error: 'Autentikasi gagal' });
      req.session.authenticated = true;
      req.session.userId = userId;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      if (isTombstoned(db, 'email', email) || db.prepare('SELECT 1 FROM revoked_users WHERE user_id=?').get(userId)) return res.status(401).json({ error: 'Autentikasi gagal' });
      return res.json({ ok: true, role: 'customer', emailVerified: false });
    } catch {
      return res.status(500).json({ error: 'Autentikasi gagal' });
    } finally {
      running--;
    }
  }
  return { register: (req, res) => handle(req, res, true), login: (req, res) => handle(req, res, false) };
}
