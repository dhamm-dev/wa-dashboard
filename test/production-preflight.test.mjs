import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeService, containsEnvironment, expectedReleaseManifest, hasExactAssignment, manifestDigest, parseProperties, readOwnedFile, validPreviewConfig } from '../tools/production-preflight.mjs';

const service = [
  'Id=wa-dashboard.service', 'LoadState=loaded', 'ActiveState=active', 'SubState=running',
  'MainPID=123', 'Job=', 'InvocationID=abc', 'WorkingDirectory=/home/dhexweb/wa-dashboard', 'DropInPaths=', '',
].join('\n');

test('accepts only the expected active service metadata', () => {
  assert.equal(activeService(parseProperties(service)), true);
  for (const changed of [
    service.replace('MainPID=123', 'MainPID=0'),
    service.replace('ActiveState=active', 'ActiveState=inactive'),
    service.replace('WorkingDirectory=/home/dhexweb/wa-dashboard', 'WorkingDirectory=/tmp'),
    service.replace('DropInPaths=', 'DropInPaths=/other'),
    service.replace('Job=', 'Job=5'),
  ]) assert.equal(activeService(parseProperties(changed)), false);
  assert.throws(() => parseProperties(`${service}MainPID=456\n`));
  assert.throws(() => parseProperties(service.replace('Result=', 'Unknown=' ) + 'Unknown=x\n'));
});

test('checks exact configuration assignments without accepting duplicates', () => {
  const value = Buffer.from('SECRET=sensitive\nDHEXBOT_PRIVATE_PREVIEW=1\r\n');
  assert.equal(hasExactAssignment(value, 'DHEXBOT_PRIVATE_PREVIEW', '1'), true);
  assert.equal(hasExactAssignment(Buffer.concat([value, Buffer.from('DHEXBOT_PRIVATE_PREVIEW=0\n')]), 'DHEXBOT_PRIVATE_PREVIEW', '1'), false);
  assert.equal(hasExactAssignment(Buffer.from('PREFIX_DHEXBOT_PRIVATE_PREVIEW=1\n'), 'DHEXBOT_PRIVATE_PREVIEW', '1'), false);
});

test('preview requires all expected flags and well-formed credentials without returning them', () => {
  const config = Buffer.from([
    'DHEXBOT_PRIVATE_PREVIEW=1', 'DHEXBOT_PUBLIC_SIGNUP=0', 'COOKIE_SECURE=true', 'TRUST_PROXY=1',
    'GOOGLE_CLIENT_ID=906779767123-3dcfo6nunh5j3l8hkqqc877ecae62m0f.apps.googleusercontent.com',
    'GOOGLE_CLIENT_SECRET=synthetic-secret-123',
    `BOT_SECRET_ENCRYPTION_KEY=${Buffer.alloc(32).toString('base64')}`,
    'GOOGLE_ANDROID_REDIRECT_URI=https://wa.dhexx.my.id/api/google/android/callback', '',
  ].join('\n'));
  assert.equal(validPreviewConfig(config), true);
  assert.equal(validPreviewConfig(Buffer.concat([config, Buffer.from('DHEXBOT_PUBLIC_SIGNUP=1\n')])), false);
  assert.equal(validPreviewConfig(Buffer.from(config.toString().replace('synthetic-secret-123', 'short'))), false);
  assert.equal(validPreviewConfig(Buffer.from(config.toString().replace('COOKIE_SECURE=true', 'COOKIE_SECURE=false'))), false);
  assert.equal(validPreviewConfig(Buffer.from(config.toString().replace('GOOGLE_ANDROID_REDIRECT_URI=https://wa.dhexx.my.id', 'GOOGLE_ANDROID_REDIRECT_URI=http://wa.dhexx.my.id'))), false);
});

test('checks process environment fields on complete NUL boundaries', () => {
  const env = Buffer.from('OTHER=example\0DATA_DIR=/expected\0SECRET=hidden\0');
  assert.equal(containsEnvironment(env, 'DATA_DIR=/expected'), true);
  assert.equal(containsEnvironment(env, 'DATA_DIR=/expect'), false);
  assert.equal(containsEnvironment(env, 'OTHER=example'), true);
  assert.equal(containsEnvironment(env, 'SECRET=hidden\0extra'), false);
});

test('reads only bounded regular files with the expected owner and mode', async t => {
  if (process.geteuid() !== 1000) return t.skip('fixture requires the expected file owner');
  const dir = await mkdtemp(path.join(tmpdir(), 'preflight-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config');
  await writeFile(file, 'example', { mode: 0o600 });
  assert.equal((await readOwnedFile(file, 7, 0o600)).toString(), 'example');
  await assert.rejects(readOwnedFile(file, 6, 0o600), /Required file unavailable/);
  const link = path.join(dir, 'link');
  await symlink(file, link);
  await assert.rejects(readOwnedFile(link, 100, 0o600), /Required file unavailable/);
});

test('release manifest is order-independent and rejects missing integrity information', () => {
  const entries = [['src/server.js', 'a'.repeat(64)], ['public/index.html', 'b'.repeat(64)]];
  assert.equal(manifestDigest(entries), manifestDigest([...entries].reverse()));
  assert.notEqual(manifestDigest(entries), manifestDigest([entries[0], ['public/index.html', 'c'.repeat(64)]]));
  assert.throws(() => manifestDigest([]));
  assert.throws(() => manifestDigest([entries[0], entries[0]]));
  assert.throws(() => manifestDigest([['src/../secret.js', 'a'.repeat(64)]]));
  assert.throws(() => manifestDigest([['src/server.js', 'not-a-hash']]));
});

test('CLI refuses actions other than read-only inspection', () => {
  const script = fileURLToPath(new URL('../tools/production-preflight.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--execute'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'READ_ONLY_INSPECTION_OR_MANIFEST_ONLY\n');
  assert.equal(result.stderr, '');
});

test('manifest command returns only a digest for the local release source', () => {
  if (process.geteuid() !== 1000) return;
  const script = fileURLToPath(new URL('../tools/production-preflight.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--manifest'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/);
  assert.equal(result.stdout.trim(), expectedReleaseManifest);
  assert.equal(result.stderr, '');
});
