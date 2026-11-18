import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

test('exclusive startup and upload recovery preserve ready and legacy files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-upload-recovery-'));
  const env = { ...process.env, DATA_DIR: dir, ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters' };
  const init = spawnSync(process.execPath, ['--input-type=module', '-e', "const {db}=await import('./src/db.js'); db.close()"], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
  db.exec("PRAGMA foreign_keys=ON; INSERT INTO users VALUES ('customer','customer@example.test','sub','customer'); INSERT INTO accounts(id,name,owner_id) VALUES ('account','Account','customer');");
  const legacy = join(dir, 'uploads', 'legacy');
  mkdirSync(join(dir, 'uploads'));
  writeFileSync(legacy, 'legacy orphan');
  mkdirSync(join(dir, 'uploads-v2'));
  for (const id of ids) mkdirSync(join(dir, 'uploads-v2', id));
  writeFileSync(join(dir, 'uploads-v2', ids[1], 'data'), 'partial');
  writeFileSync(join(dir, 'uploads-v2', ids[2], 'data'), 'complete but uncommitted');
  writeFileSync(join(dir, 'uploads-v2', ids[3], 'data'), 'ready');
  for (const id of ids) db.prepare('INSERT INTO upload_files VALUES (?,?,?)').run(id, 'account', Number(id === ids[3]));
  db.prepare('INSERT INTO attachments VALUES (?,?,?,?)').run(ids[3], 'account', 'ready.txt', 'text/plain');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  const start = () => spawn(process.execPath, ['src/server.js'], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const ready = async () => {
    for (let i = 0; i < 100; i++) { try { await fetch(base); return; } catch { await new Promise(r => setTimeout(r, 50)); } }
    assert.fail('server did not start');
  };
  try {
    child = start();
    await ready();
    for (const id of ids.slice(0, 3)) {
      assert.equal(existsSync(join(dir, 'uploads-v2', id, 'data')), false);
      assert.equal(db.prepare('SELECT 1 FROM upload_files WHERE id=?').get(id), undefined);
    }
    assert.equal(readFileSync(legacy, 'utf8'), 'legacy orphan');
    assert.equal(readFileSync(join(dir, 'uploads-v2', ids[3], 'data'), 'utf8'), 'ready');
    const pending = ids[0];
    db.prepare('INSERT INTO upload_files VALUES (?,?,0)').run(pending, 'account');
    writeFileSync(join(dir, 'uploads-v2', pending, 'data'), 'active');
    const second = spawnSync(process.execPath, ['src/server.js'], { env: { ...env, PORT: String(port + 1) }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /DATA_DIR sedang digunakan/);
    assert.equal(readFileSync(join(dir, 'uploads-v2', pending, 'data'), 'utf8'), 'active');
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    child = start();
    await ready();
    assert.equal(existsSync(join(dir, 'uploads-v2', pending, 'data')), false);
    assert.equal(db.prepare('SELECT 1 FROM upload_files WHERE id=?').get(pending), undefined);
    assert.equal(readFileSync(legacy, 'utf8'), 'legacy orphan');
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await stopped;
    db.prepare('INSERT INTO upload_files VALUES (?,?,0)').run(pending, 'account');
    writeFileSync(join(dir, 'uploads-v2', pending, 'data'), 'interrupted recovery');
    const interrupted = spawnSync(process.execPath, ['--import', './test/fixtures/upload-crash.mjs', 'src/server.js'], { env: { ...env, PORT: String(port), TEST_RECOVERY_CRASH: '1' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(interrupted.status, 92, interrupted.stderr);
    assert.equal(existsSync(join(dir, 'uploads-v2', pending, 'data')), false);
    assert.ok(db.prepare('SELECT 1 FROM upload_files WHERE id=?').get(pending));
    child = start();
    await ready();
    assert.equal(db.prepare('SELECT 1 FROM upload_files WHERE id=?').get(pending), undefined);
    assert.equal(readFileSync(legacy, 'utf8'), 'legacy orphan');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sender reads both new and legacy attachments without crossing accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-upload-send-'));
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const { db, dataDir } = await import('./src/db.js');
    db.exec("INSERT INTO accounts(id,name,owner_id) VALUES ('a','A','legacy-admin'),('b','B','legacy-admin')");
    const { storeUpload } = await import('./src/upload-store.js');
    const fresh = await storeUpload('a', 'new.txt', 'text/plain', Buffer.from('new bytes'));
    const legacy = '55555555-5555-4555-8555-555555555555';
    mkdirSync(join(dataDir, 'uploads'));
    writeFileSync(join(dataDir, 'uploads', legacy), 'old bytes');
    db.prepare('INSERT INTO attachments VALUES (?,?,?,?)').run(legacy, 'a', 'old.txt', 'text/plain');
    const sent = [];
    mock.module(new URL('./src/whatsapp.js', import.meta.url), { namedExports: { socketFor: () => ({ sendMessage: async (jid, content) => sent.push(content) }) } });
    const { send } = await import('./src/sender.js');
    for (const id of [fresh, legacy]) assert.equal((await send('a', '62812345678@s.whatsapp.net', 'hi', id)).status, 'success');
    assert.deepEqual(sent.map(x => x.document.toString()), ['new bytes', 'old bytes']);
    assert.equal((await send('b', '62812345678@s.whatsapp.net', 'hi', fresh)).status, 'failed');
    assert.equal(sent.length, 2);
    db.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('crashes around file creation leave owner metadata until restart recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-upload-crash-'));
  const env = { ...process.env, DATA_DIR: dir, ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters' };
  delete env.TEST_UPLOAD_CRASH;
  const init = spawnSync(process.execPath, ['--input-type=module', '-e', "const {db}=await import('./src/db.js'); db.prepare(\"INSERT INTO accounts(id,name,owner_id) VALUES ('a','A','legacy-admin')\").run(); db.close()"], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function start(crash) {
    child = spawn(process.execPath, ['--import', './test/fixtures/upload-crash.mjs', 'src/server.js'], { env: { ...env, PORT: String(port), ...(crash ? { TEST_UPLOAD_CRASH: crash } : {}) }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { await fetch(base); return; } catch { await new Promise(r => setTimeout(r, 50)); } }
    assert.fail('server did not start');
  }
  try {
    for (const phase of ['before', 'partial', 'written', 'synced']) {
      await start(phase);
      const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const form = new FormData();
      form.append('accountId', 'a');
      form.append('file', new Blob(['payload']), 'test.txt');
      const exited = new Promise(resolve => child.once('exit', resolve));
      await fetch(base + '/api/attachments', { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body: form }).catch(() => {});
      assert.equal(await exited, 91);
      const row = db.prepare('SELECT id,account_id,ready FROM upload_files').get();
      assert.equal(row.account_id, 'a');
      assert.equal(row.ready, 0);
      assert.equal(db.prepare('SELECT 1 FROM attachments WHERE id=?').get(row.id), undefined);
      assert.equal(existsSync(join(dir, 'uploads-v2', row.id, 'data')), phase !== 'before');
      await start();
      assert.equal(db.prepare('SELECT count(*) AS n FROM upload_files').get().n, 0);
      assert.equal(existsSync(join(dir, 'uploads-v2', row.id, 'data')), false);
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await stopped;
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
