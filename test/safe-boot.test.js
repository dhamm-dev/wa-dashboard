import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

test('safe boot isolates the migrated clone and exposes only health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-boot-'));
  const env = { ...process.env, DATA_DIR: dir, DHEXBOT_PRIVATE_PREVIEW: '1', DHEXBOT_SAFE_BOOT: '1' };
  const init = spawnSync(process.execPath, ['--input-type=module', '-e', "const {db}=await import('./src/db.js'); db.close()"], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
  db.exec(`INSERT INTO users VALUES ('customer','customer@example.test',NULL,'customer');
    INSERT INTO accounts(id,name,owner_id) VALUES ('account','Account','customer');
    INSERT INTO revoked_users VALUES ('customer','2020-01-01');
    INSERT INTO history(id,account_id,jid,text,created_at,status) VALUES ('h','account','123','message','2020-01-01','pending');
    INSERT INTO schedules(id,account_id,jid,text,repeat,next_at,created_at) VALUES ('s','account','123','message','once','2020-01-01','2020-01-01');
    INSERT INTO upload_files VALUES ('upload','account',0);
    INSERT INTO media_temp_dirs VALUES ('media');`);
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', 'keep'), 'session');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const script = `
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    net.Socket.prototype.connect = () => { throw new Error('outbound socket'); };
    syncBuiltinESMExports();
    globalThis.setInterval = () => { throw new Error('interval'); };
    globalThis.setTimeout = () => { throw new Error('timeout'); };
    globalThis.fetch = () => { throw new Error('external fetch'); };
    await import('./src/server.js');
    process.env.DHEXBOT_SAFE_BOOT = '';
    process.env.DHEXBOT_PRIVATE_PREVIEW = '';
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let health;
    for (let i = 0; i < 150; i++) {
      try { health = await fetch(base + '/api/health'); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      if (child.exitCode !== null) break;
    }
    assert.ok(health, `server did not start: ${stderr}`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { safeBoot: true });
    for (const [path, method] of [['/api/health', 'POST'], ['/api/accounts', 'GET'], ['/api/accounts/account/connect', 'POST'], ['/api', 'GET'], ['/index.html', 'GET'], ['/dashboard.sqlite', 'GET']]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(db.prepare("SELECT status FROM history WHERE id='h'").get().status, 'pending');
    assert.equal(db.prepare("SELECT next_at FROM schedules WHERE id='s'").get().next_at, '2020-01-01');
    for (const table of ['cleanup_manifests', 'cleanup_items', 'cleanup_seals', 'cleanup_journal']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM upload_files').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM media_temp_dirs').get().n, 1);
    assert.equal(readFileSync(join(dir, 'sessions', 'keep'), 'utf8'), 'session');
    assert.equal(child.exitCode, null, stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safe boot fails before touching data when preview is not enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-boot-denied-'));
  try {
    for (const preview of ['', '0']) {
      const result = spawnSync(process.execPath, ['src/server.js'], { env: { ...process.env, DATA_DIR: join(dir, 'untouched'), DHEXBOT_SAFE_BOOT: '1', DHEXBOT_PRIVATE_PREVIEW: preview }, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires DHEXBOT_PRIVATE_PREVIEW=1/);
    }
    assert.throws(() => readFileSync(join(dir, 'untouched', 'dashboard.sqlite')), { code: 'ENOENT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
