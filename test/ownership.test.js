import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

test('legacy admin and simulated customer sessions are isolated across resources and bot access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-ownership-'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const audience = 'test-client.apps.googleusercontent.com';
  const children = [];
  async function start(script) {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['--import', './test/fixtures/google-mock.mjs', script], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: audience, TEST_GOOGLE_JWK: JSON.stringify(jwk) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) { try { await fetch(base); return base; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.fail(output);
  }
  async function login(base) {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-dashboard-request': '1' };
  }
  try {
    const adminBase = await start('src/server.js');
    const customerBase = adminBase;
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    db.exec(`INSERT INTO users VALUES ('customer-1','one@example.test','customer-sub','customer'), ('customer-2','two@example.test',NULL,'customer');
      INSERT INTO accounts(id,name,owner_id,role) VALUES ('admin','Admin','legacy-admin','ordinary'), ('bot','Bot','legacy-admin','bot'), ('one','One','customer-1','ordinary'), ('two','Two','customer-2','ordinary');
      INSERT INTO templates(id,name,text,owner_id) VALUES ('ta','Admin template','secret-admin','legacy-admin'), ('t1','One template','secret-one','customer-1'), ('t2','Two template','secret-two','customer-2');
      INSERT INTO contacts VALUES ('ca','admin','Admin contact','62812345678@s.whatsapp.net'), ('cb','bot','Bot contact','62812345678@s.whatsapp.net'), ('c1','one','One contact','62812345678@s.whatsapp.net'), ('c2','two','Two contact','62812345678@s.whatsapp.net');
      INSERT INTO schedules(id,account_id,jid,text,repeat,next_at,created_at) VALUES ('sa','admin','62812345678@s.whatsapp.net','admin','once','2099-01-01','2026-01-01'), ('sb','bot','62812345678@s.whatsapp.net','bot','once','2099-01-01','2026-01-01'), ('s1','one','62812345678@s.whatsapp.net','one','once','2099-01-01','2026-01-01'), ('s2','two','62812345678@s.whatsapp.net','two','once','2099-01-01','2026-01-01');
      INSERT INTO history VALUES ('ha','admin','62812345678@s.whatsapp.net','admin',NULL,'2026-01-01','success',''), ('hb','bot','62812345678@s.whatsapp.net','bot',NULL,'2026-01-01','success',''), ('h1','one','62812345678@s.whatsapp.net','one',NULL,'2026-01-01','success',''), ('h2','two','62812345678@s.whatsapp.net','two',NULL,'2026-01-01','success','');
      INSERT INTO history_events(history_id) VALUES ('ha'),('hb'),('h1'),('h2');`);
    const admin = await login(adminBase);
    const challengeResponse = await fetch(customerBase + '/api/google/challenge', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-request': '1' }, body: JSON.stringify({ purpose: 'login' }) });
    const challenge = await challengeResponse.json();
    const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
    const body = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode({ iss: 'https://accounts.google.com', aud: audience, sub: 'customer-sub', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), nonce: challenge.nonce })}`;
    const response = await fetch(customerBase + '/api/google/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-request': '1', cookie: challengeResponse.headers.get('set-cookie').split(';')[0] }, body: JSON.stringify({ nonce: challenge.nonce, credential: `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}` }) });
    assert.equal(response.status, 200);
    const customer = { cookie: response.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-dashboard-request': '1' };
    const get = async (base, headers, path) => (await fetch(base + path, { headers })).json();
    const request = (base, headers, path, method, body = {}) => fetch(base + path, { method, headers, body: JSON.stringify(body) });
    assert.deepEqual((await get(adminBase, admin, '/api/accounts')).map(x => x.id).sort(), ['admin', 'bot']);
    assert.deepEqual((await get(customerBase, customer, '/api/accounts')).map(x => x.id), ['one']);
    for (const [base, headers, ids] of [[adminBase, admin, ['admin', 'bot']], [customerBase, customer, ['one']]]) {
      assert.deepEqual((await get(base, headers, '/api/schedules')).map(x => x.account_id).sort(), ids);
      assert.deepEqual((await get(base, headers, '/api/history')).map(x => x.account_id).sort(), ids);
      assert.deepEqual((await get(base, headers, '/api/history-events?cursor=0')).events.map(x => x.account_id).sort(), ids);
    }
    assert.deepEqual((await get(adminBase, admin, '/api/templates')).map(x => x.id), ['ta']);
    assert.deepEqual((await get(customerBase, customer, '/api/templates')).map(x => x.id), ['t1']);
    for (const id of ['admin', 'bot', 'two']) {
      assert.equal((await fetch(`${customerBase}/api/accounts/${id}/whatsapp-contacts`, { headers: customer })).status, 400);
      assert.equal((await fetch(`${customerBase}/api/accounts/${id}/groups`, { headers: customer })).status, 400);
      assert.equal((await fetch(`${customerBase}/api/contacts?accountId=${id}`, { headers: customer })).status, 400);
      assert.equal((await request(customerBase, customer, `/api/accounts/${id}/connect`, 'POST')).status, 400);
      assert.equal((await request(customerBase, customer, `/api/accounts/${id}/repair`, 'POST')).status, 400);
      assert.equal((await request(customerBase, customer, '/api/messages', 'POST', { accountId: id, jid: '62812345678@s.whatsapp.net', text: 'x' })).status, 400);
    }
    assert.equal((await fetch(`${adminBase}/api/contacts?accountId=one`, { headers: admin })).status, 400);
    assert.deepEqual(await get(customerBase, customer, '/api/history?accountId=bot'), []);
    assert.deepEqual(await get(adminBase, admin, '/api/schedules?accountId=one'), []);
    assert.equal((await request(customerBase, customer, '/api/accounts', 'POST', { name: 'Bot', role: 'bot' })).status, 403);
    assert.equal((await request(customerBase, customer, '/api/schedules/sb', 'DELETE', { revision: 0 })).status, 404);
    assert.equal((await request(customerBase, customer, '/api/schedules/sb', 'PUT', { revision: 0, accountId: 'one' })).status, 404);
    assert.equal((await request(customerBase, customer, '/api/schedules/sb/enabled', 'POST', { revision: 0, enabled: false })).status, 404);
    assert.equal((await request(adminBase, admin, '/api/schedules/s1', 'DELETE', { revision: 0 })).status, 404);
    const transition = { expectedRole: 'ordinary', role: 'bot' };
    const rolePath = '/api/accounts/admin/role';
    assert.equal((await request(adminBase, { 'content-type': 'application/json', 'x-dashboard-request': '1' }, rolePath, 'PUT', transition)).status, 401);
    assert.equal((await request(customerBase, customer, '/api/accounts/one/role', 'PUT', transition)).status, 403);
    assert.equal((await request(adminBase, admin, '/api/accounts/one/role', 'PUT', transition)).status, 404);
    assert.equal((await request(adminBase, { ...admin, 'x-dashboard-request': '0' }, rolePath, 'PUT', transition)).status, 403);
    assert.equal((await request(adminBase, admin, rolePath, 'PUT', { role: 'bot' })).status, 400);
    assert.equal((await request(adminBase, admin, rolePath, 'PUT', { expectedRole: 'ordinary', role: 'ordinary' })).status, 400);
    db.exec("INSERT INTO schedules(id,account_id,jid,text,repeat,next_at,created_at,enabled,revision) VALUES ('paused','admin','62812345678@s.whatsapp.net','x','weekly','2099-01-01','2026-01-01',0,4), ('completed','admin','62812345678@s.whatsapp.net','x','once',NULL,'2026-01-01',1,2)");
    db.exec("CREATE TRIGGER test_role_abort BEFORE UPDATE OF role ON accounts WHEN NEW.id='admin' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    assert.equal((await request(adminBase, admin, rolePath, 'PUT', transition)).status, 400);
    assert.deepEqual({ ...db.prepare("SELECT enabled,revision FROM schedules WHERE id='sa'").get() }, { enabled: 1, revision: 0 });
    assert.equal(db.prepare("SELECT role FROM accounts WHERE id='admin'").get().role, 'ordinary');
    db.exec('DROP TRIGGER test_role_abort');
    const changed = await request(adminBase, admin, rolePath, 'PUT', transition);
    assert.deepEqual(await changed.json(), { ok: true, role: 'bot', pausedSchedules: 2 });
    assert.deepEqual(db.prepare("SELECT id,enabled,revision FROM schedules WHERE id IN ('sa','paused','completed') ORDER BY id").all().map(row => ({ ...row })), [
      { id: 'completed', enabled: 0, revision: 3 }, { id: 'paused', enabled: 0, revision: 4 }, { id: 'sa', enabled: 0, revision: 1 }
    ]);
    assert.equal((await request(adminBase, admin, rolePath, 'PUT', transition)).status, 409);
    assert.equal((await request(adminBase, admin, '/api/schedules/sa/enabled', 'POST', { revision: 0, enabled: true })).status, 409);
    assert.equal((await request(adminBase, admin, '/api/schedules/sa/enabled', 'POST', { revision: 1, enabled: true })).status, 409);
    const future = new Date(Date.now() + 86400000 + 7 * 3600000).toISOString().slice(0, 16);
    const message = { accountId: 'admin', jid: '62812345678@s.whatsapp.net', text: 'x', repeat: 'once', at: future };
    assert.equal((await request(adminBase, admin, '/api/messages', 'POST', message)).status, 409);
    assert.equal((await request(adminBase, admin, '/api/schedules/sa', 'PUT', { ...message, revision: 1 })).status, 409);
    assert.equal((await request(adminBase, admin, '/api/schedules/sb', 'PUT', { ...message, accountId: 'admin', revision: 0 })).status, 409);
    assert.equal((await request(adminBase, admin, '/api/accounts/admin/role', 'PUT', { expectedRole: 'bot', role: 'ordinary' })).status, 200);
    assert.deepEqual({ ...db.prepare("SELECT enabled,revision FROM schedules WHERE id='sa'").get() }, { enabled: 0, revision: 1 });
    assert.equal((await request(adminBase, admin, '/api/schedules/sa/enabled', 'POST', { revision: 1, enabled: true })).status, 200);
    await request(customerBase, customer, '/api/contacts/cb', 'DELETE');
    await request(customerBase, customer, '/api/templates/ta', 'DELETE');
    await request(adminBase, admin, '/api/contacts/c1', 'DELETE');
    await request(adminBase, admin, '/api/templates/t1', 'DELETE');
    assert.equal(db.prepare("SELECT count(*) AS n FROM contacts WHERE id IN ('cb','c1')").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM templates WHERE id IN ('ta','t1')").get().n, 2);
    assert.equal((await request(customerBase, customer, '/api/admin/users/customer-1/revoke', 'POST')).status, 403);
    assert.equal((await request(adminBase, admin, '/api/admin/users/legacy-admin/revoke', 'POST')).status, 404);
    db.exec("CREATE TRIGGER test_tombstone_abort BEFORE INSERT ON identity_tombstones BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    assert.equal((await request(adminBase, admin, '/api/admin/users/customer-1/revoke', 'POST')).status, 400);
    assert.equal(db.prepare("SELECT count(*) AS n FROM revoked_users WHERE user_id='customer-1'").get().n, 0);
    assert.equal(db.prepare("SELECT enabled FROM schedules WHERE id='s1'").get().enabled, 1);
    db.exec('DROP TRIGGER test_tombstone_abort');
    const revoked = await request(adminBase, admin, '/api/admin/users/customer-1/revoke', 'POST');
    assert.equal(revoked.status, 202);
    assert.equal((await revoked.json()).status, 'access_revoked_cleanup_not_implemented');
    assert.equal(db.prepare('SELECT count(*) AS n FROM identity_tombstones').get().n, 1);
    assert.equal((await fetch(customerBase + '/api/me', { headers: customer })).status, 401);
    assert.equal((await get(adminBase, admin, '/api/admin/users/customer-1/revoke')).status, 'access_revoked_cleanup_not_implemented');
    assert.equal(db.prepare("SELECT enabled FROM schedules WHERE id='s1'").get().enabled, 0);
    assert.equal(db.prepare("SELECT enabled FROM schedules WHERE id='s2'").get().enabled, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM templates WHERE id IN ('t1','t2')").get().n, 2);
    assert.throws(() => db.exec("DELETE FROM revoked_users WHERE user_id='customer-1'"));
    db.close();
  } finally {
    for (const child of children) if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    rmSync(dir, { recursive: true, force: true });
  }
});
