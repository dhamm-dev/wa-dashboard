import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { verifyGoogleToken } from '../src/google-auth.js';
import { identityHash } from '../src/identity-tombstones.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
const audience = 'test-client.apps.googleusercontent.com';
const token = (nonce, overrides = {}, key = privateKey) => {
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ iss: 'https://accounts.google.com', aud: audience, sub: 'google-1', email: 'one@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce, ...overrides })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
};
const keys = async () => new Response(JSON.stringify({ keys: [jwk] }));

test('Google verification requires signature, claims, nonce and official key response', async () => {
  const options = { audience, nonce: 'nonce', fetchKeys: keys };
  assert.equal((await verifyGoogleToken(token('nonce'), options)).sub, 'google-1');
  for (const claims of [{ iss: 'bad' }, { aud: 'bad' }, { exp: 1 }, { sub: '' }, { sub: undefined }, { nonce: 'other' }, { azp: 'other' }]) await assert.rejects(verifyGoogleToken(token('nonce', claims), options));
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verifyGoogleToken(token('nonce', {}, other.privateKey), options));
  await assert.rejects(verifyGoogleToken(token('nonce'), { ...options, fetchKeys: async () => { throw new Error('offline'); } }));
});

for (const flags of [{}, { DHEXBOT_PRIVATE_PREVIEW: '1', DHEXBOT_PUBLIC_SIGNUP: '1' }]) test(`private signup gate ${JSON.stringify(flags)}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-private-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: audience, TEST_GOOGLE_JWK: JSON.stringify(jwk) };
  delete env.DHEXBOT_PRIVATE_PREVIEW; delete env.DHEXBOT_PUBLIC_SIGNUP;
  Object.assign(env, flags);
  const child = spawn(process.execPath, ['--import', './test/fixtures/google-mock.mjs', 'src/server.js'], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-request': '1', cookie }, body: JSON.stringify(body) });
  const google = async (sub, email, purpose = 'login', cookie = '') => {
    const c = await post('/api/google/challenge', { purpose }, cookie);
    const { nonce } = await c.json();
    return post('/api/google/login', { nonce, credential: token(nonce, { sub, email }) }, c.headers.get('set-cookie')?.split(';')[0] || cookie);
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { await fetch(base); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); } }
    assert.ok(ready);
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    db.prepare("INSERT INTO users VALUES ('existing-google','existing@example.test','existing-sub','customer')").run();
    db.prepare("INSERT INTO users VALUES ('existing-email','email-auth:existing-email',NULL,'customer')").run();
    const salt = Buffer.alloc(16, 1), password = 'long-password-123';
    db.prepare('INSERT INTO email_credentials VALUES (?,?,?,?)').run('existing@example.test', 'existing-email', salt, scryptSync(password, salt, 64));
    for (const email of ['existing@example.test', 'unknown@example.test']) {
      const response = await post('/api/email/register', { email, password });
      assert.equal(response.status, 403); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'Autentikasi gagal' });
    }
    assert.equal((await post('/api/email/login', { email: 'existing@example.test', password })).status, 200);
    const blocked = await google('new-sub', 'new@example.test');
    assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await blocked.json(), { error: 'Akses tidak tersedia' });
    assert.equal((await google('existing-sub', 'existing@example.test')).status, 200);
    const admin = await post('/api/login', { password: 'x' });
    assert.equal(admin.status, 200);
    assert.equal((await google('admin-sub', 'idhamk654@gmail.com', 'link', admin.headers.get('set-cookie').split(';')[0])).status, 200);
    assert.equal((await google('admin-sub', 'idhamk654@gmail.com')).status, 200);
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE role='customer'").get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM email_credentials').get().n, 1);
    db.close();
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Google login isolates customers, consumes challenges, links admin and blocks revoked subjects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-google-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './test/fixtures/google-mock.mjs', 'src/server.js'], { env: { ...process.env, DHEXBOT_PRIVATE_PREVIEW: '', DHEXBOT_PUBLIC_SIGNUP: '1', DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: audience, TEST_GOOGLE_JWK: JSON.stringify(jwk) }, stdio: 'ignore' });
  const post = (path, body, cookie = '', header = true) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'x-dashboard-request': '1' } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const challenge = async (purpose, cookie = '') => {
    const response = await post('/api/google/challenge', { purpose }, cookie);
    assert.equal(response.status, 200);
    return { ...(await response.json()), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  };
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
    assert.equal((await post('/api/google/challenge', { purpose: 'login' }, '', false)).status, 403);
    assert.equal((await post('/api/google/challenge', { purpose: 'link' })).status, 403);
    const c = await challenge('login');
    const credential = token(c.nonce);
    const response = await post('/api/google/login', { nonce: c.nonce, credential }, c.cookie);
    assert.equal(response.status, 200);
    const customerCookie = response.headers.get('set-cookie').split(';')[0];
    assert.notEqual(customerCookie, c.cookie);
    assert.equal((await post('/api/google/login', { nonce: c.nonce, credential }, c.cookie)).status, 401);
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    const customer = db.prepare('SELECT id,role FROM users WHERE google_sub=?').get('google-1');
    assert.equal(customer.role, 'customer');
    db.prepare("INSERT INTO accounts(id,name,owner_id) VALUES ('customer-account','Customer',?)").run(customer.id);
    const adminLogin = await post('/api/login', { password: 'x' });
    const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await (await fetch(base + '/api/accounts', { headers: { cookie: adminCookie } })).json(), []);
    const link = await challenge('link', adminCookie);
    assert.equal((await post('/api/google/login', { nonce: link.nonce, credential: token(link.nonce, { sub: 'admin-sub', email: 'idhamk654@gmail.com', email_verified: false }) }, link.cookie)).status, 403);
    const link2 = await challenge('link', adminCookie);
    assert.equal((await post('/api/google/login', { nonce: link2.nonce, credential: token(link2.nonce, { sub: 'admin-sub', email: 'idhamk654@gmail.com' }) }, link2.cookie)).status, 200);
    const adminGoogle = await challenge('login');
    const adminGoogleResponse = await post('/api/google/login', { nonce: adminGoogle.nonce, credential: token(adminGoogle.nonce, { sub: 'admin-sub', email: 'changed@example.test', email_verified: false }) }, adminGoogle.cookie);
    assert.equal(adminGoogleResponse.status, 200);
    const googleAdminCookie = adminGoogleResponse.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await (await fetch(base + '/api/accounts', { headers: { cookie: googleAdminCookie } })).json(), []);
    const existingEmail = await challenge('login');
    assert.equal((await post('/api/google/login', { nonce: existingEmail.nonce, credential: token(existingEmail.nonce, { sub: 'impostor', email: 'idhamk654@gmail.com' }) }, existingEmail.cookie)).status, 403);
    db.prepare('INSERT INTO revoked_google_subs VALUES (?)').run('google-1');
    assert.equal((await fetch(base + '/api/accounts', { headers: { cookie: customerCookie } })).status, 401);
    db.prepare('DELETE FROM accounts WHERE owner_id=?').run(customer.id);
    db.prepare('DELETE FROM users WHERE id=?').run(customer.id);
    const revoked = await challenge('login');
    assert.equal((await post('/api/google/login', { nonce: revoked.nonce, credential: token(revoked.nonce) }, revoked.cookie)).status, 403);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE google_sub=?').get('google-1').n, 0);
    db.prepare('INSERT INTO identity_tombstones VALUES (?)').run(identityHash('google', 'google-1'));
    db.prepare('DELETE FROM revoked_google_subs WHERE google_sub=?').run('google-1');
    const durable = await challenge('login');
    assert.equal((await post('/api/google/login', { nonce: durable.nonce, credential: token(durable.nonce) }, durable.cookie)).status, 403);
    const differentCase = await challenge('login');
    assert.equal((await post('/api/google/login', { nonce: differentCase.nonce, credential: token(differentCase.nonce, { sub: 'GOOGLE-1' }) }, differentCase.cookie)).status, 200);
    db.close();
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    rmSync(dir, { recursive: true, force: true });
  }
});
