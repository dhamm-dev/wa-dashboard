import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('email credentials are isolated, bounded and independent of Google identities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-email-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const audience = 'test-client.apps.googleusercontent.com';
  const child = spawn(process.execPath, ['--import', './test/fixtures/google-mock.mjs', 'src/server.js'], { env: { ...process.env, DHEXBOT_PRIVATE_PREVIEW: '', DHEXBOT_PUBLIC_SIGNUP: '1', DATA_DIR: dir, PORT: String(port), TRUST_PROXY: '1', ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: audience, TEST_GOOGLE_JWK: JSON.stringify(jwk) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-request': '1', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const cookie = response => response.headers.get('set-cookie').split(';')[0];
  const secret = 'long-password-123';
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { await fetch(base); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(ready, output);
    const admin = await post('/api/login', { password: 'x' });
    const adminCookie = cookie(admin);
    const registered = await post('/api/email/register', { email: '  IDHAMK654@gmail.com ', password: secret }, adminCookie);
    assert.equal(registered.status, 200);
    assert.equal(registered.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await registered.json(), { ok: true, role: 'customer', emailVerified: false });
    const customerCookie = cookie(registered);
    assert.notEqual(customerCookie, adminCookie);
    assert.equal((await (await fetch(base + '/api/me', { headers: { cookie: customerCookie } })).json()).role, 'customer');
    assert.equal((await fetch(base + '/api/me', { headers: { cookie: adminCookie } })).status, 401);
    assert.equal((await post('/api/accounts', { name: 'bot', role: 'bot' }, customerCookie)).status, 403);
    const logged = await post('/api/email/login', { email: 'idhamk654@gmail.com', password: secret });
    assert.equal(logged.status, 200);
    assert.deepEqual(await logged.json(), { ok: true, role: 'customer', emailVerified: false });
    for (const body of [{ email: 'idhamk654@gmail.com', password: 'wrong-password-123' }, { email: 'missing@example.test', password: secret }]) {
      const denied = await post('/api/email/login', body);
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), { error: 'Autentikasi gagal' });
    }
    for (const password of ['short', 'é'.repeat(129)]) assert.equal((await post('/api/email/register', { email: 'bad@example.test', password })).status, 400);
    const malformed = await fetch(base + '/api/email/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"secret' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await malformed.json(), { error: 'Permintaan tidak valid' });

    const race = await Promise.all([1, 2].map(() => post('/api/email/register', { email: 'same@example.test', password: secret })));
    assert.deepEqual(race.map(r => r.status).sort(), [200, 401]);
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    const stored = db.prepare('SELECT * FROM email_credentials WHERE email=?').get('same@example.test');
    assert.equal(stored.salt.length, 16);
    assert.equal(stored.password_hash.length, 64);
    assert.notEqual(Buffer.from(stored.password_hash).toString(), secret);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_credentials WHERE email=?').get('same@example.test').n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE email LIKE 'email-auth:%'").get().n, 2);
    db.prepare("INSERT INTO templates(id,name,text,owner_id) VALUES ('private','Private','secret',?)").run(stored.user_id);
    assert.deepEqual(await (await fetch(base + '/api/templates', { headers: { cookie: customerCookie } })).json(), []);

    const challengeResponse = await post('/api/google/challenge', { purpose: 'login' });
    const challenge = await challengeResponse.json();
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const jwt = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ iss: 'https://accounts.google.com', aud: audience, sub: 'google-same', email: 'same@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: challenge.nonce })}`;
    const google = await post('/api/google/login', { nonce: challenge.nonce, credential: `${jwt}.${sign('RSA-SHA256', Buffer.from(jwt), privateKey).toString('base64url')}` }, cookie(challengeResponse));
    assert.equal(google.status, 200);
    assert.notEqual(db.prepare('SELECT id FROM users WHERE google_sub=?').get('google-same').id, stored.user_id);
    assert.deepEqual(await (await fetch(base + '/api/templates', { headers: { cookie: cookie(google) } })).json(), []);
    db.prepare("INSERT INTO users(id,email,google_sub,role) VALUES ('google-first','first@example.test','google-first-sub','customer')").run();
    const first = await post('/api/email/register', { email: 'first@example.test', password: secret });
    assert.equal(first.status, 200);
    assert.notEqual(db.prepare('SELECT user_id FROM email_credentials WHERE email=?').get('first@example.test').user_id, 'google-first');
    const adminAgain = cookie(await post('/api/login', { password: 'x' }));
    assert.equal((await post(`/api/admin/users/${stored.user_id}/revoke`, {}, adminAgain)).status, 202);
    assert.equal((await post(`/api/admin/users/${stored.user_id}/revoke`, {}, adminAgain)).status, 202);
    assert.equal(db.prepare('SELECT count(*) AS n FROM identity_tombstones').get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM templates WHERE id='private'").get().n, 1);
    assert.equal((await fetch(base + '/api/me', { headers: { cookie: cookie(google) } })).status, 200);
    db.prepare('DELETE FROM email_credentials WHERE user_id=?').run(stored.user_id);
    for (const path of ['/api/email/register', '/api/email/login']) {
      const denied = await post(path, { email: '  SAME@example.test ', password: secret });
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), { error: 'Autentikasi gagal' });
    }
    db.close();
    let limited;
    for (let i = 0; i < 9; i++) limited = await post('/api/email/login', { email: 'throttle@example.test', password: secret });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    for (let i = 0; i < 31; i++) limited = await fetch(base + '/api/email/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.7' }, body: '{}' });
    assert.equal(limited.status, 429);
    assert.ok(!output.includes(secret));
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
