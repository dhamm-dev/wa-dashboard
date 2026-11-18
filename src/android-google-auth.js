import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyGoogleToken } from './google-auth.js';
import { isTombstoned } from './identity-tombstones.js';
import { publicSignupEnabled } from './signup-policy.js';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest();
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function androidGoogleAuth({ db, clientId, clientSecret, redirectUri, exchange = fetch, fetchKeys = fetch, now = Date.now }) {
  let configured = false;
  try {
    const url = new URL(redirectUri);
    configured = !!clientId && !!clientSecret && url.protocol === 'https:' && url.pathname === '/api/google/android/callback' && !url.username && !url.password && !url.search && !url.hash;
  } catch {}
  const transactions = new Map();
  const clean = () => { for (const [key, value] of transactions) if (value.expires <= now()) transactions.delete(key); };
  const noStore = res => res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const denied = res => noStore(res).status(401).json({ error: 'Login gagal' });
  const isAdmin = session => session?.authenticated === true && session.userId === 'legacy-admin' && !!db.prepare("SELECT 1 FROM users WHERE id='legacy-admin' AND role='admin' AND (google_sub IS NULL OR NOT EXISTS (SELECT 1 FROM revoked_google_subs WHERE google_sub=users.google_sub))").get();
  const start = (req, res) => {
    noStore(res);
    if (!configured) return res.status(503).json({ error: 'Login Google tidak tersedia' });
    if (req.get('X-Dashboard-Request') !== '1') return res.status(403).json({ error: 'Permintaan ditolak' });
    if (!valid(req.body?.secret)) return res.status(400).json({ error: 'Permintaan tidak valid' });
    const purpose = req.body?.purpose ?? 'login';
    if (!['login', 'link'].includes(purpose)) return res.status(400).json({ error: 'Permintaan tidak valid' });
    if (purpose === 'link' && !isAdmin(req.session)) return res.status(403).json({ error: 'Permintaan ditolak' });
    clean();
    if (transactions.size >= 1000) return res.status(429).json({ error: 'Terlalu banyak permintaan' });
    const state = random(), nonce = random(), verifier = random(), id = random();
    const tx = { id, nonce, verifier, secret: hash(req.body.secret), session: req.sessionID, purpose, expires: now() + 300000, status: 'pending' };
    transactions.set(state, tx);
    req.session.androidGoogle = true;
    req.session.save(err => {
      if (err) { transactions.delete(state); return res.status(500).json({ error: 'Gagal memulai sesi' }); }
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email', state, nonce, code_challenge: hash(verifier).toString('base64url'), code_challenge_method: 'S256' }).toString();
      res.json({ id, authorizationUrl: url.toString(), expiresIn: 300, pollInterval: 2 });
    });
  };
  const callback = async (req, res) => {
    noStore(res);
    clean();
    const state = req.query.state;
    if (!valid(state)) return denied(res);
    const tx = transactions.get(state);
    if (!tx || tx.status !== 'pending') return denied(res);
    tx.status = 'processing';
    if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) {
      tx.status = 'failed';
      return res.status(400).type('text').send('Login dibatalkan atau gagal. Kembali ke aplikasi.');
    }
    try {
      const response = await exchange('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: req.query.code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: tx.verifier }) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); throw new Error(); } chunks.push(value); }
      const { id_token } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const claims = await verifyGoogleToken(id_token, { audience: clientId, nonce: tx.nonce, fetchKeys, now: now() });
      if (tx.purpose === 'link') {
        const session = await new Promise((resolve, reject) => req.sessionStore.get(tx.session, (err, value) => err ? reject(err) : resolve(value)));
        if (!isAdmin(session)) throw new Error();
      }
      if (tx.expires <= now() || claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 254 || !claims.email.includes('@')) throw new Error();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (isTombstoned(db, 'google', claims.sub) || db.prepare('SELECT 1 FROM revoked_google_subs WHERE google_sub=?').get(claims.sub)) throw new Error();
        let user = db.prepare('SELECT id,role FROM users WHERE google_sub=?').get(claims.sub);
        if (user && db.prepare('SELECT 1 FROM revoked_users WHERE user_id=?').get(user.id)) throw new Error();
        if (tx.purpose === 'link') {
          const admin = db.prepare("SELECT email,google_sub FROM users WHERE id='legacy-admin' AND role='admin'").get();
          if (!admin || claims.email !== admin.email || (admin.google_sub !== null && admin.google_sub !== claims.sub) || (user && user.id !== 'legacy-admin')) throw new Error();
          db.prepare("UPDATE users SET google_sub=? WHERE id='legacy-admin' AND role='admin' AND google_sub IS NULL").run(claims.sub);
          user = { id: 'legacy-admin', role: 'admin' };
        } else if (!user) {
          if (!publicSignupEnabled()) throw new Error();
          user = { id: randomUUID(), role: 'customer' };
          db.prepare('INSERT INTO users(id,email,google_sub,role) VALUES (?,?,?,?)').run(user.id, claims.email, claims.sub, user.role);
        }
        db.exec('COMMIT');
        tx.userId = user.id;
        tx.googleSub = claims.sub;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      tx.status = 'ready';
      return res.type('text').send('Login selesai. Kembali ke aplikasi.');
    } catch {
      tx.status = 'failed';
      return res.status(400).type('text').send('Login gagal. Kembali ke aplikasi.');
    }
  };
  const poll = (req, res) => {
    noStore(res);
    if (req.get('X-Dashboard-Request') !== '1') return res.status(403).json({ error: 'Permintaan ditolak' });
    clean();
    if (!valid(req.body?.id) || !valid(req.body?.secret)) return denied(res);
    const entry = [...transactions.entries()].find(([, tx]) => tx.id === req.body.id);
    if (!entry) return denied(res);
    const [state, tx] = entry;
    if (tx.session !== req.sessionID || !timingSafeEqual(tx.secret, hash(req.body.secret))) return denied(res);
    if (tx.purpose === 'link' && !isAdmin(req.session)) { transactions.delete(state); return denied(res); }
    if (tx.status === 'pending' || tx.status === 'processing') return res.json({ status: 'pending' });
    transactions.delete(state);
    if (tx.status !== 'ready' || isTombstoned(db, 'google', tx.googleSub) || !db.prepare('SELECT id FROM users WHERE id=? AND google_sub=? AND NOT EXISTS (SELECT 1 FROM revoked_users WHERE user_id=users.id) AND NOT EXISTS (SELECT 1 FROM revoked_google_subs WHERE google_sub=users.google_sub)').get(tx.userId, tx.googleSub)) return denied(res);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Gagal memulai sesi' });
      if (isTombstoned(db, 'google', tx.googleSub) || !db.prepare('SELECT id FROM users WHERE id=? AND google_sub=? AND NOT EXISTS (SELECT 1 FROM revoked_users WHERE user_id=users.id)').get(tx.userId, tx.googleSub)) return denied(res);
      req.session.authenticated = true;
      req.session.userId = tx.userId;
      res.json({ status: 'complete' });
    });
  };
  return { start, callback, poll };
}
