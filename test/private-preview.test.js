import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

test('private preview retains journaled media and pending uploads and refuses revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-preview-'));
  const env = { ...process.env, DATA_DIR: dir, DHEXBOT_PRIVATE_PREVIEW: '1', DHEXBOT_PUBLIC_SIGNUP: '1', ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters' };
  const init = spawnSync(process.execPath, ['--input-type=module', '-e', "const {db}=await import('./src/db.js'); db.close()"], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const media = '11111111-1111-4111-8111-111111111111';
  const upload = '22222222-2222-4222-8222-222222222222';
  const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
  db.exec("INSERT INTO users VALUES ('customer','customer@example.test',NULL,'customer'); INSERT INTO accounts(id,name,owner_id) VALUES ('account','Account','customer');");
  db.prepare('INSERT INTO media_temp_dirs VALUES (?)').run(media);
  db.prepare('INSERT INTO upload_files VALUES (?,?,0)').run(upload, 'account');
  mkdirSync(join(dir, 'media-temp', media), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'uploads-v2', upload), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'media-temp', media, 'data'), 'old media');
  writeFileSync(join(dir, 'uploads-v2', upload, 'data'), 'pending upload');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  try {
    let response;
    for (let i = 0; i < 150; i++) {
      try { response = await fetch(base + '/api/auth/options'); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(response, 'server did not start');
    assert.equal((await response.json()).publicSignup, false);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const revoke = await fetch(base + '/api/admin/users/customer/revoke', { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' } });
    assert.equal(revoke.status, 503);
    assert.match((await revoke.json()).error, /pembersihan.*tidak tersedia/);
    assert.equal(db.prepare('SELECT 1 FROM revoked_users WHERE user_id=?').get('customer'), undefined);
    assert.ok(db.prepare('SELECT 1 FROM upload_files WHERE id=? AND ready=0').get(upload));
    assert.ok(db.prepare('SELECT 1 FROM media_temp_dirs WHERE id=?').get(media));
    const dirs = db.prepare('SELECT id FROM media_temp_dirs').all();
    assert.equal(dirs.length, 2);
    assert.equal(statSync(join(dir, 'media-temp', dirs.find(row => row.id !== media).id)).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(dir, 'media-temp', media, 'data'), 'utf8'), 'old media');
    assert.equal(readFileSync(join(dir, 'uploads-v2', upload, 'data'), 'utf8'), 'pending upload');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview leaves filesystem deletion APIs intact and cleanup refuses to run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-preview-guard-'));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import * as promises from 'node:fs/promises';
    const originals = ['unlink', 'rm', 'rmdir'].flatMap(name => [fs[name], fs[name + 'Sync'], promises[name]]);
    const { privatePreview } = await import('./src/private-preview.js');
    const { cleanupRevokedCustomer } = await import('./src/customer-cleanup.js');
    assert.equal(privatePreview, true);
    assert.deepEqual(['unlink', 'rm', 'rmdir'].flatMap(name => [fs[name], fs[name + 'Sync'], promises[name]]), originals);
    process.env.DHEXBOT_PRIVATE_PREVIEW = '';
    const path = process.env.TEST_FILE;
    await promises.unlink(path);
    await assert.rejects(promises.unlink(path), { code: 'ENOENT' });
    assert.throws(() => fs.unlinkSync(path), { code: 'ENOENT' });
    await new Promise(resolve => fs.unlink(path, err => { assert.equal(err.code, 'ENOENT'); resolve(); }));
    await assert.rejects(cleanupRevokedCustomer(null, null, null), /unavailable/);
  `;
  const file = join(dir, 'keep');
  writeFileSync(file, 'keep');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DHEXBOT_PRIVATE_PREVIEW: '1', TEST_FILE: file, TEST_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preview auth key null persists and matches Baileys reads; write errors propagate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-preview-auth-'));
  const script = `
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs/promises';
    import { join } from 'node:path';
    import { useMultiFileAuthState } from '@whiskeysockets/baileys';
    const { createFencedAuthStore } = await import('./src/fenced-auth-store.js');
    const dir = process.env.TEST_DIR;
    const store = await createFencedAuthStore(dir);
    await store.state.keys.set({ session: { key: { value: 1 } }, 'app-state-sync-key': { key: { keyData: Buffer.from([1]) } } });
    await store.state.keys.set({ session: { key: null }, 'app-state-sync-key': { key: null } });
    for (const type of ['session', 'app-state-sync-key']) {
      assert.equal(await fs.readFile(join(dir, type + '-key.json'), 'utf8'), 'null');
      assert.deepEqual(await store.state.keys.get(type, ['key']), { key: null });
      const stock = await useMultiFileAuthState(dir);
      assert.deepEqual(await stock.state.keys.get(type, ['key']), { key: null });
    }
    const denied = Object.assign(new Error('write denied'), { code: 'EACCES' });
    const failing = await createFencedAuthStore(dir, { fs: { ...fs, writeFile: async () => { throw denied; } } });
    await assert.rejects(failing.state.keys.set({ session: { key: null } }), error => error === denied);
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DHEXBOT_PRIVATE_PREVIEW: '1', TEST_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('direct preview recovery performs no media rm or upload unlink and retains records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-preview-recovery-'));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const { db } = await import('./src/db.js');
    const media = '11111111-1111-4111-8111-111111111111';
    const upload = '22222222-2222-4222-8222-222222222222';
    db.prepare('INSERT INTO media_temp_dirs VALUES (?)').run(media);
    db.exec("INSERT INTO accounts(id,name,owner_id) VALUES ('a','A','legacy-admin')");
    db.prepare('INSERT INTO upload_files VALUES (?,?,0)').run(upload, 'a');
    fs.mkdirSync(join(process.env.DATA_DIR, 'media-temp', media), { recursive: true, mode: 0o700 });
    fs.mkdirSync(join(process.env.DATA_DIR, 'uploads-v2', upload), { recursive: true });
    fs.writeFileSync(join(process.env.DATA_DIR, 'media-temp', media, 'keep'), 'media');
    fs.writeFileSync(join(process.env.DATA_DIR, 'uploads-v2', upload, 'data'), 'upload');
    let calls = 0;
    fs.rmSync = () => { calls++; throw new Error('unexpected rm'); };
    fs.promises.unlink = async () => { calls++; throw new Error('unexpected unlink'); };
    syncBuiltinESMExports();
    const { initMediaTemp } = await import('./src/media-temp.js');
    const { recoverUploads } = await import('./src/upload-store.js');
    initMediaTemp();
    await recoverUploads();
    assert.equal(calls, 0);
    assert.ok(db.prepare('SELECT 1 FROM media_temp_dirs WHERE id=?').get(media));
    assert.ok(db.prepare('SELECT 1 FROM upload_files WHERE id=? AND ready=0').get(upload));
    assert.equal(fs.readFileSync(join(process.env.DATA_DIR, 'media-temp', media, 'keep'), 'utf8'), 'media');
    assert.equal(fs.readFileSync(join(process.env.DATA_DIR, 'uploads-v2', upload, 'data'), 'utf8'), 'upload');
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DATA_DIR: dir, DHEXBOT_PRIVATE_PREVIEW: '1' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
