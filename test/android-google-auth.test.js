import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import session from 'express-session';
import { androidGoogleAuth } from '../src/android-google-auth.js';

test('Android OAuth binds one-use callback and handoff to app secret and session', async () => {
  const originalPublic = process.env.DHEXBOT_PUBLIC_SIGNUP, originalPrivate = process.env.DHEXBOT_PRIVATE_PREVIEW;
  delete process.env.DHEXBOT_PUBLIC_SIGNUP; delete process.env.DHEXBOT_PRIVATE_PREVIEW;
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE,google_sub TEXT UNIQUE,role TEXT); CREATE TABLE revoked_google_subs(google_sub TEXT PRIMARY KEY); CREATE TABLE revoked_users(user_id TEXT PRIMARY KEY); CREATE TABLE identity_tombstones(identity_hash TEXT PRIMARY KEY)');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key', use: 'sig', alg: 'RS256' };
  let clock = Date.now(), nonce, subject = 'subject', verified = true, expectedChallenge;
  const exchange = async (_url, options) => {
    assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), expectedChallenge);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = `${encode({ alg: 'RS256', kid: 'key' })}.${encode({ iss: 'https://accounts.google.com', aud: 'client', sub: subject, email: `${subject}@example.test`, email_verified: verified, nonce, iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 300 })}`;
    return new Response(JSON.stringify({ id_token: `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}` }));
  };
  const auth = androidGoogleAuth({ db, clientId: 'client', clientSecret: 'secret', redirectUri: 'https://example.test/api/google/android/callback', exchange, fetchKeys: async () => new Response(JSON.stringify({ keys: [jwk] })), now: () => clock });
  const app = express(); app.use(express.json()); app.use(session({ secret: 'test session secret of sufficient length', resave: false, saveUninitialized: false }));
  app.post('/start', auth.start); app.get('/callback', auth.callback); app.post('/poll', auth.poll);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const secret = () => randomBytes(32).toString('base64url');
  const post = (path, body, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-request': '1', cookie }, body: JSON.stringify(body) });
  const start = async (cookie = '') => {
    const key = secret(), response = await post('/start', { secret: key }, cookie), body = await response.json();
    const url = new URL(body.authorizationUrl);
    return { key, id: body.id, state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge'), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  };
  const callback = (state, extra = 'code=code') => fetch(`${base}/callback?state=${state}&${extra}`);
  const poll = (tx, cookie = tx.cookie, key = tx.key) => post('/poll', { id: tx.id, secret: key }, cookie);
  try {
    const blocked = await start(); nonce = blocked.nonce; expectedChallenge = blocked.challenge;
    const denied = await callback(blocked.state);
    assert.equal(denied.status, 400); assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal(await denied.text(), 'Login gagal. Kembali ke aplikasi.');
    assert.equal((await poll(blocked)).status, 401);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
    process.env.DHEXBOT_PUBLIC_SIGNUP = '1';
    const a = await start(), b = await start();
    assert.equal((await poll(a, b.cookie)).status, 401);
    assert.equal((await poll(a, a.cookie, b.key)).status, 401);
    assert.equal((await callback(secret())).status, 401);
    assert.equal((await poll(a)).status, 200);
    nonce = a.nonce; expectedChallenge = a.challenge;
    const responses = await Promise.all([callback(a.state), callback(a.state)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
    const done = await poll(a); assert.equal((await done.json()).status, 'complete');
    assert.ok(done.headers.get('set-cookie')); assert.equal((await poll(a)).status, 401);
    assert.equal(db.prepare('SELECT role FROM users WHERE google_sub=?').get('subject').role, 'customer');
    process.env.DHEXBOT_PRIVATE_PREVIEW = '1';
    const existing = await start(); nonce = existing.nonce; expectedChallenge = existing.challenge;
    assert.equal((await callback(existing.state)).status, 200); assert.equal((await poll(existing)).status, 200);
    subject = 'new-subject';
    const privateTx = await start(); nonce = privateTx.nonce; expectedChallenge = privateTx.challenge;
    assert.equal((await callback(privateTx.state)).status, 400); assert.equal((await poll(privateTx)).status, 401);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    assert.equal((await callback(b.state, 'error=access_denied')).status, 400);
    assert.equal((await poll(b)).status, 401);
    const expired = await start(); clock += 300001;
    assert.equal((await callback(expired.state)).status, 401); assert.equal((await poll(expired)).status, 401);
    const unverified = await start(); nonce = unverified.nonce; expectedChallenge = unverified.challenge; verified = false;
    assert.equal((await callback(unverified.state)).status, 400); assert.equal((await poll(unverified)).status, 401);
    verified = true; subject = 'revoked'; db.prepare('INSERT INTO revoked_google_subs VALUES (?)').run(subject);
    const revoked = await start(); nonce = revoked.nonce; expectedChallenge = revoked.challenge;
    assert.equal((await callback(revoked.state)).status, 400); assert.equal((await poll(revoked)).status, 401);
  } finally {
    if (originalPublic === undefined) delete process.env.DHEXBOT_PUBLIC_SIGNUP; else process.env.DHEXBOT_PUBLIC_SIGNUP = originalPublic;
    if (originalPrivate === undefined) delete process.env.DHEXBOT_PRIVATE_PREVIEW; else process.env.DHEXBOT_PRIVATE_PREVIEW = originalPrivate;
    await new Promise(resolve => server.close(resolve)); db.close();
  }
});
