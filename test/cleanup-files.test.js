import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { cleanupFiles } from '../src/cleanup-files.js';

const id = '12345678-1234-4234-9234-123456789abc';
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const artifact = kind => ({ kind, id });

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(fileURLToPath(new URL('./fixtures/cleanup-files/', import.meta.url)), 'run-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir);
  for (const kind of ['sessions', 'uploads', 'uploads-v2']) await fs.mkdir(path.join(dataDir, kind));
  await fs.writeFile(path.join(base, 'outside'), 'keep');
  return { base, dataDir, target: kind => path.join(dataDir, kind, id) };
}

test('removes only listed artifacts and retries idempotently', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target('sessions'));
  await fs.writeFile(path.join(f.target('sessions'), 'creds.json'), '{}');
  await fs.writeFile(path.join(f.target('sessions'), 'pre-key-1.json'), '{}');
  await fs.writeFile(f.target('uploads'), 'old');
  await fs.mkdir(f.target('uploads-v2'));
  await fs.writeFile(path.join(f.target('uploads-v2'), 'data'), 'new');
  await fs.writeFile(path.join(f.dataDir, 'uploads', other), 'other');
  const args = { dataDir: f.dataDir, artifacts: ['sessions', 'uploads', 'uploads-v2'].map(artifact) };
  await cleanupFiles(args);
  await cleanupFiles(args);
  for (const item of args.artifacts) await assert.rejects(fs.lstat(f.target(item.kind)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.dataDir, 'uploads', other), 'utf8'), 'other');
  assert.equal(await fs.readFile(path.join(f.base, 'outside'), 'utf8'), 'keep');
});

test('rejects invalid inventory before deleting anything', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.target('uploads'), 'keep');
  for (const bad of ['../outside', `${id}/../x`, '', id + '\n']) {
    await assert.rejects(cleanupFiles({ dataDir: f.dataDir, artifacts: [artifact('uploads'), { kind: 'uploads', id: bad }] }), TypeError);
  }
  await assert.rejects(cleanupFiles({ dataDir: `${f.dataDir}/../data`, artifacts: [] }));
  assert.equal(await fs.readFile(f.target('uploads'), 'utf8'), 'keep');
});

test('rejects symlinks in roots, artifacts and children', async t => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.base, 'outside'), f.target('uploads'));
  await assert.rejects(cleanupFiles({ dataDir: f.dataDir, artifacts: [artifact('uploads')] }));
  await fs.mkdir(f.target('sessions'));
  await fs.symlink(path.join(f.base, 'outside'), path.join(f.target('sessions'), 'creds.json'));
  await assert.rejects(cleanupFiles({ dataDir: f.dataDir, artifacts: [artifact('sessions')] }));
  await fs.symlink(f.dataDir, path.join(f.base, 'link'));
  await assert.rejects(cleanupFiles({ dataDir: path.join(f.base, 'link'), artifacts: [] }));
  assert.equal(await fs.readFile(path.join(f.base, 'outside'), 'utf8'), 'keep');
});

test('rejects hardlinks and unexpected entries without deleting known children', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target('sessions'));
  const known = path.join(f.target('sessions'), 'creds.json');
  await fs.writeFile(known, '{}');
  await fs.link(path.join(f.base, 'outside'), path.join(f.target('sessions'), 'linked.json'));
  await assert.rejects(cleanupFiles({ dataDir: f.dataDir, artifacts: [artifact('sessions')] }));
  assert.equal(await fs.readFile(known, 'utf8'), '{}');
  await fs.unlink(path.join(f.target('sessions'), 'linked.json'));
  await fs.mkdir(path.join(f.target('sessions'), 'nested.json'));
  await assert.rejects(cleanupFiles({ dataDir: f.dataDir, artifacts: [artifact('sessions')] }));
  await fs.mkdir(f.target('uploads-v2'));
  await fs.writeFile(path.join(f.target('uploads-v2'), 'data'), 'keep');
  await fs.writeFile(path.join(f.target('uploads-v2'), 'unknown'), 'keep');
  await assert.rejects(cleanupFiles({ dataDir: f.dataDir, artifacts: [artifact('uploads-v2')] }));
  assert.equal(await fs.readFile(path.join(f.target('uploads-v2'), 'data'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(f.base, 'outside'), 'utf8'), 'keep');
});

test('rejects special files', async t => {
  const f = await fixture(t);
  const server = net.createServer();
  const uploads = await fs.open(path.join(f.dataDir, 'uploads'), 'r');
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(`/proc/self/fd/${uploads.fd}/${id}`, resolve));
    try {
      await assert.rejects(cleanupFiles({ dataDir: f.dataDir, artifacts: [artifact('uploads')] }));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await uploads.close();
  }
});

test('retry completes after interruption between unlink and sync', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target('sessions'));
  await fs.writeFile(path.join(f.target('sessions'), 'creds.json'), '{}');
  const args = { dataDir: f.dataDir, artifacts: [artifact('sessions')] };
  await assert.rejects(cleanupFiles({ ...args, afterUnlink: () => { throw new Error('interrupted'); } }), /interrupted/);
  await cleanupFiles(args);
  await assert.rejects(fs.lstat(f.target('sessions')), { code: 'ENOENT' });
});
