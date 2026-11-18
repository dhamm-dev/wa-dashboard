import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import express from 'express';
import { botConfigRouter } from '../src/bot-config.js';

test('admin bot configuration isolates and encrypts keys, validates input, and fences model requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-config-'));
  const oldDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  const { db } = await import('../src/db.js');
  if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
  db.exec(`INSERT INTO users(id,email,role) VALUES ('other','other@example.test','admin'),('customer','customer@example.test','customer');
    INSERT INTO accounts(id,name,owner_id,role) VALUES ('a','A','legacy-admin','bot'),('b','B','other','bot'),('c','C','legacy-admin','ordinary');`);
  let user = { id: 'legacy-admin', role: 'admin' };
  let master = Buffer.alloc(32, 7);
  let list = async () => [{ name: 'models/gemini-test', displayName: 'Test', supportedGenerationMethods: ['generateContent'] }];
  let received;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use('/accounts/:id/bot-config', botConfigRouter({ db, masterKey: () => { if (!master) throw new Error('master details'); return master; }, provider: options => { received = options; return { listModels: () => list() }; } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/accounts/`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  try {
    const path = 'a/bot-config';
    assert.equal((await call('b/bot-config')).status, 404);
    assert.equal((await call('c/bot-config')).status, 404);
    user = { id: 'customer', role: 'customer' };
    assert.equal((await call(path)).status, 403);
    user = { id: 'legacy-admin', role: 'admin' };
    const config = { model: 'models/gemini-test', systemInstruction: 'hello', enabled: true, adminPhones: ['+62 (812) 345-678'], enabledCommands: ['menu', 'ping'] };
    assert.equal((await call(path, 'PUT', config)).status, 200);
    for (const bad of [{ adminPhones: ['abc'] }, { adminPhones: ['+62812345678', '62812345678'] }, { enabledCommands: ['menu', 'menu'] }, { model: '../invalid' }, { enabled: 1 }, { provider: 'other' }]) assert.equal((await call(path, 'PUT', { ...config, ...bad })).status, 400);
    assert.equal((await call(path + '/models', 'POST', {})).status, 409);
    master = null;
    assert.equal((await call(path + '/keys', 'POST', { key: 'first-secret' })).status, 503);
    assert.equal(db.prepare('SELECT count(*) n FROM bot_keys').get().n, 0);
    master = Buffer.alloc(32, 7);
    assert.equal((await call(path + '/keys', 'POST', { key: 'x\nInjected: y' })).status, 400);
    const first = (await call(path + '/keys', 'POST', { key: 'first-secret' })).body.id;
    const second = (await call(path + '/keys', 'POST', { key: 'second-secret' })).body.id;
    const ciphertext = Buffer.from(db.prepare('SELECT ciphertext FROM bot_keys WHERE id=?').get(first).ciphertext);
    assert.equal(ciphertext.includes(Buffer.from('first-secret')), false);
    const result = await call(path);
    assert.equal(result.cache, 'no-store');
    assert.deepEqual(result.body, { provider: 'gemini', model: 'gemini-test', systemInstruction: 'hello', enabled: true, adminPhones: ['62812345678'], enabledCommands: ['menu', 'ping'], keys: [{ id: first, priority: 0 }, { id: second, priority: 1 }] });
    user = { id: 'other', role: 'admin' };
    assert.equal((await call('b/bot-config/keys/' + first, 'PUT', { key: 'replacement' })).status, 404);
    assert.equal((await call('b/bot-config/keys/' + first, 'DELETE')).status, 404);
    user = { id: 'legacy-admin', role: 'admin' };
    for (const ids of [[first, first], [first], [first, 'bad'], [second, first, first]]) assert.equal((await call(path + '/keys/order', 'PUT', { ids })).status, 400);
    assert.equal((await call(path + '/keys/order', 'PUT', { ids: [second, first] })).status, 200);
    assert.equal((await call(path + '/models', 'POST', {})).status, 200);
    assert.deepEqual(received.keys, ['second-secret', 'first-secret']);
    assert.equal(received.isCurrent(), true);
    db.prepare('UPDATE bot_keys SET ciphertext=? WHERE id=?').run(ciphertext, second);
    assert.equal((await call(path + '/models', 'POST', {})).status, 502);
    db.prepare('UPDATE bot_keys SET ciphertext=? WHERE id=?').run(Buffer.from([1, 2]), second);
    assert.equal((await call(path + '/models', 'POST', {})).status, 502);
    assert.equal((await call(path + '/keys/' + second, 'PUT', { key: 'replacement-secret' })).status, 200);
    master = null;
    assert.equal((await call(path + '/keys/' + second, 'PUT', { key: 'another-secret' })).status, 503);
    assert.equal((await call(path + '/models', 'POST', {})).status, 502);
    master = Buffer.alloc(32, 7);
    list = async () => { throw new Error('replacement-secret and private chat'); };
    const failure = await call(path + '/models', 'POST', {});
    assert.equal(failure.status, 502);
    assert.equal(JSON.stringify(failure).includes('secret'), false);
    list = async () => [{ name: 'replacement-secret' }];
    assert.equal((await call(path + '/models', 'POST', {})).status, 502);
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    list = () => new Promise(resolve => { release = resolve; started(); });
    const pending = call(path + '/models', 'POST', {});
    await waiting;
    db.exec("UPDATE accounts SET role='ordinary' WHERE id='a'; UPDATE accounts SET role='bot' WHERE id='a'");
    assert.equal(received.isCurrent(), false);
    release([{ name: 'models/gemini-test' }]);
    assert.equal((await pending).status, 409);
    assert.equal((await call(path + '/keys/' + first, 'DELETE')).status, 200);
    assert.equal((await call(path + '/keys/' + first, 'DELETE')).status, 404);
    db.prepare("UPDATE bot_config SET admin_phones='not-json' WHERE account_id='a'").run();
    assert.equal((await call(path)).status, 500);
    list = async () => [];
    for (let i = 0; i < 3; i++) await call(path + '/models', 'POST', {});
    assert.equal((await call(path + '/models', 'POST', {})).status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('server integration applies session, CSRF and sanitized JSON errors to bot config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-config-server-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    mock.module(new URL('./src/whatsapp.js', import.meta.url), { namedExports: {
      connect: async () => {}, fenceAccount: async () => {}, groups: async () => [], pairingCode: async () => '', repair: async () => {},
      socketFor: () => null, state: () => ({}), whatsappContacts: () => []
    } });
    async function run() {
      const { db } = await import('./src/db.js');
      db.exec("INSERT INTO accounts(id,name,owner_id,role) VALUES ('a','A','legacy-admin','bot')");
      await import('./src/server.js');
      const base = 'http://127.0.0.1:' + process.env.PORT;
      for (let i = 0; i < 100; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
      const path = base + '/api/accounts/a/bot-config';
      assert.equal((await fetch(path)).status, 401);
      const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const headers = { cookie, 'content-type': 'application/json', 'x-dashboard-request': '1' };
      assert.equal((await fetch(path + '/keys', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"key":"secret-value"}' })).status, 403);
      const added = await fetch(path + '/keys', { method: 'POST', headers, body: '{"key":"secret-value"}' });
      assert.equal(added.status, 201);
      assert.equal(added.headers.get('cache-control'), 'no-store');
      const result = await fetch(path, { headers });
      assert.equal((await result.text()).includes('secret-value'), false);
      const malformed = await fetch(path + '/keys', { method: 'POST', headers, body: '{"key":"secret-value"' });
      assert.equal(malformed.status, 400);
      assert.equal(malformed.headers.get('cache-control'), 'no-store');
      assert.equal((await malformed.text()).includes('secret-value'), false);
    }
    run().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
  `;
  try {
    const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters', BOT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') };
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout + result.stderr).includes('secret-value'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
