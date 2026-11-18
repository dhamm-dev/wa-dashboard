import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('Baileys uses private temp dynamically and restart recovers only journaled directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-media-test-'));
  const legacy = join(dir, 'old-temp');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'legacy-image-original'), 'unowned');
  const env = { ...process.env, DATA_DIR: dir, TMPDIR: legacy };
  const script = `
    const { encryptedStream, prepareWAMessageMedia } = await import('@whiskeysockets/baileys');
    const { existsSync, statSync } = await import('node:fs');
    const { initMediaTemp } = await import('./src/media-temp.js');
    const dir = initMediaTemp();
    const media = await encryptedStream(Buffer.from('synthetic image bytes'), 'image', { saveOriginalFileIfRequired: true });
    let uploaded;
    const message = await prepareWAMessageMedia({ document: Buffer.from('synthetic document'), fileName: 'test.txt', mimetype: 'text/plain' }, { upload: async path => { uploaded = { path, size: statSync(path).size }; return { mediaUrl: 'https://example.test/media', directPath: '/media' }; } });
    process.stdout.write(JSON.stringify({ dir, original: media.originalFilePath, encrypted: media.encFilePath, repeat: initMediaTemp(), uploaded, cleaned: !existsSync(uploaded.path), name: message.documentMessage.fileName }) + '\\n');
    setInterval(() => {}, 1000);
  `;
  let child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const line = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(output.slice(0, output.indexOf('\n'))); });
    child.once('exit', code => reject(new Error(`child exited ${code}: ${stderr}`)));
  });
  try {
    const info = JSON.parse(await line);
    assert.equal(info.repeat, info.dir);
    assert.equal(dirname(info.original), info.dir);
    assert.equal(dirname(info.encrypted), info.dir);
    assert.equal(dirname(info.uploaded.path), info.dir);
    assert.ok(info.uploaded.size > 0);
    assert.equal(info.cleaned, true);
    assert.equal(info.name, 'test.txt');
    assert.equal(readFileSync(info.original, 'utf8'), 'synthetic image bytes');
    assert.equal(statSync(info.dir).mode & 0o777, 0o700);
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    assert.equal(db.prepare('SELECT id FROM media_temp_dirs').get().id, basename(info.dir));
    const unknown = join(dir, 'media-temp', 'unknown');
    mkdirSync(unknown);
    writeFileSync(join(unknown, 'keep'), 'unknown');
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', "const {initMediaTemp}=await import('./src/media-temp.js'); initMediaTemp()"], { env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /DATA_DIR sedang digunakan/);
    assert.equal(readFileSync(info.original, 'utf8'), 'synthetic image bytes');
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const crashScript = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.rmSync;
      fs.rmSync = (...args) => { original(...args); process.exit(91); };
      syncBuiltinESMExports();
      const {initMediaTemp} = await import('./src/media-temp.js'); initMediaTemp();
    `;
    const crash = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(crash.status, 91, crash.stderr);
    assert.ok(db.prepare('SELECT 1 FROM media_temp_dirs WHERE id=?').get(basename(info.dir)));
    assert.equal(existsSync(info.dir), false);
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e', "const {initMediaTemp}=await import('./src/media-temp.js'); process.stdout.write(initMediaTemp())"], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(restart.status, 0, restart.stderr);
    assert.notEqual(restart.stdout, info.dir);
    assert.equal(db.prepare('SELECT 1 FROM media_temp_dirs WHERE id=?').get(basename(info.dir)), undefined);
    assert.equal(readFileSync(join(legacy, 'legacy-image-original'), 'utf8'), 'unowned');
    assert.equal(readFileSync(join(unknown, 'keep'), 'utf8'), 'unknown');
    db.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid journal entries and non-private temp roots fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-media-fail-'));
  const env = { ...process.env, DATA_DIR: dir };
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', "const {initMediaTemp}=await import('./src/media-temp.js'); initMediaTemp()"], { env, encoding: 'utf8', timeout: 10000 });
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const db = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    db.prepare('INSERT INTO media_temp_dirs VALUES (?)').run('../unknown');
    writeFileSync(join(dir, 'keep'), 'safe');
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /ID direktori media sementara tidak valid/);
    assert.equal(readFileSync(join(dir, 'keep'), 'utf8'), 'safe');
    db.prepare('DELETE FROM media_temp_dirs WHERE id=?').run('../unknown');
    db.close();
    chmodSync(join(dir, 'media-temp'), 0o755);
    const insecure = run();
    assert.notEqual(insecure.status, 0);
    assert.match(insecure.stderr, /tidak privat/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
