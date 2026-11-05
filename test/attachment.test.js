import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachment } from '../src/attachment.js';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('common formats use server-determined MIME and sanitized filenames', () => {
  const cases = [
    ['foto.jpg', 'ffd8ff', 'image/jpeg'], ['foto.png', '89504e470d0a1a0a', 'image/png'],
    ['gambar.gif', '474946383961', 'image/gif'], ['gambar.webp', '524946460000000057454250', 'image/webp'],
    ['dokumen.pdf', '255044462d', 'application/pdf'], ['dokumen.docx', '504b0304', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['tabel.xlsx', '504b0304', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slide.pptx', '504b0304', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['arsip.zip', '504b0506', 'application/zip'], ['suara.mp3', '494433', 'audio/mpeg'],
    ['video.mp4', '000000186674797000000000', 'video/mp4']
  ];
  for (const [name, hex, mime] of cases) assert.equal(validateAttachment({ originalname: name, mimetype: 'text/html', buffer: Buffer.from(hex, 'hex') }).mime, mime);
  assert.equal(validateAttachment({ originalname: '../a.exe.txt', buffer: Buffer.from('teks') }).name, 'a_exe.txt');
  assert.equal(validateAttachment({ originalname: 'data.csv', buffer: Buffer.from('a,b\n1,2') }).mime, 'text/csv');
});

test('rejects executable extensions, mismatched signatures and invalid text', () => {
  for (const file of [
    { originalname: 'run.exe', buffer: Buffer.from('MZ') },
    { originalname: 'foto.png', buffer: Buffer.from('not a png') },
    { originalname: 'script.html', buffer: Buffer.from('<script>') },
    { originalname: 'file.txt', buffer: Buffer.from([0, 1, 2]) },
    { originalname: 'empty.txt', buffer: Buffer.alloc(0) }
  ]) assert.throws(() => validateAttachment(file));
});

test('rejects a data directory inside the public web root', () => {
  const result = spawnSync(process.execPath, ['-e', "import('./src/db.js')"], { env: { ...process.env, DATA_DIR: resolve('public') }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATA_DIR tidak boleh berada di direktori publik/);
});
