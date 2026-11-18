import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { safeInventory } from '../tools/safe-inventory.mjs';
import { inventoryInodes } from '../tools/inventory-inodes.mjs';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const scan = (root, options = {}) => safeInventory({ root, callerGuardAndRescan: true, ...options });
const rejects = promise => assert.rejects(promise, { code: 'EINVENTORY', message: 'Inventory failed' });

test('inventories synthetic files deterministically with metadata and SHA-256', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'file'), 'hello');
  await fs.writeFile(path.join(root, 'empty'), '');
  const first = await scan(root);
  assert.deepEqual(await scan(root), first);
  assert.deepEqual(first.map(({ path: name, type }) => [name, type]), [
    ['', 'dir'], ['empty', 'regular'], ['nested', 'dir'], ['nested/file', 'regular']
  ]);
  for (const entry of first) {
    const actual = await fs.stat(path.join(root, entry.path), { bigint: true });
    assert.equal(entry.device, actual.dev.toString());
    assert.equal(entry.inode, actual.ino.toString());
  }
  assert.deepEqual(inventoryInodes(first), first.map(entry => ({ dev: BigInt(entry.device), ino: BigInt(entry.inode) })));
  const file = first[3];
  const stat = await fs.stat(path.join(root, 'nested', 'file'), { bigint: true });
  assert.equal(file.sha256, createHash('sha256').update('hello').digest('hex'));
  assert.equal(file.size, '5');
  assert.equal(file.mode, Number(stat.mode & 0o7777n));
  assert.equal(file.mtimeNs, stat.mtimeNs.toString());
  assert.equal(file.inode, stat.ino.toString());
});

test('requires caller guard and rescan acknowledgement', async t => {
  const root = await fixture(t);
  await rejects(safeInventory({ root }));
  await rejects(safeInventory(null));
});

test('rejects symlinks and hardlinked regular files', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file'), 'x');
  await fs.symlink('file', path.join(root, 'link'));
  await rejects(scan(root));
  await fs.unlink(path.join(root, 'link'));
  await fs.link(path.join(root, 'file'), path.join(root, 'link'));
  await rejects(scan(root));
});

test('rejects a synthetic FIFO', async t => {
  const root = await fixture(t);
  const result = spawnSync('mkfifo', [path.join(root, 'fifo')]);
  if (result.error?.code === 'ENOENT') return t.skip('mkfifo unavailable');
  assert.equal(result.status, 0);
  await rejects(scan(root));
});

test('rejects changes during hashing and path replacement', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fs.writeFile(file, Buffer.alloc(128 * 1024));
  let changed = false;
  await rejects(scan(root, { onChunk: async () => {
    if (!changed) { changed = true; await fs.appendFile(file, 'x'); }
  } }));
  changed = false;
  await rejects(scan(root, { onChunk: async () => {
    if (!changed) {
      changed = true;
      await fs.rename(file, path.join(root, 'old'));
      await fs.writeFile(file, 'replacement');
    }
  } }));
});

test('ignores unrelated sibling changes under an ancestor', async t => {
  const parent = await fixture(t);
  const ancestor = path.join(parent, 'ancestor');
  const root = path.join(ancestor, 'root');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'file'), 'contents');
  let changed = false;
  const manifest = await scan(root, { onChunk: async () => {
    if (!changed) {
      changed = true;
      const sibling = path.join(ancestor, 'sibling');
      await fs.mkdir(sibling);
      await fs.rmdir(sibling);
    }
  } });
  assert.equal(changed, true);
  assert.deepEqual(manifest.map(entry => entry.path), ['', 'file']);
});

test('rejects root replacement and ancestor symlink substitution', async t => {
  for (const replaceAncestor of [false, true]) {
    const parent = await fixture(t);
    const ancestor = path.join(parent, 'ancestor');
    const root = path.join(ancestor, 'root');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'file'), 'contents');
    let changed = false;
    await rejects(scan(root, { onChunk: async () => {
      if (!changed) {
        changed = true;
        const target = replaceAncestor ? ancestor : root;
        await fs.rename(target, `${target}-old`);
        await fs.symlink(`${target}-old`, target);
      }
    } }));
    assert.equal(changed, true);
  }
});

test('enforces depth, entry, file and byte budgets', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'dir'));
  await fs.writeFile(path.join(root, 'dir', 'file'), 'abc');
  for (const options of [{ maxDepth: 1 }, { maxEntries: 1 }, { maxFiles: 0 }, { maxBytes: 2 }]) {
    await rejects(scan(root, options));
  }
  assert.equal((await scan(root, { maxDepth: 2, maxEntries: 2, maxFiles: 1, maxBytes: 3 })).length, 3);
});

test('rejects forbidden file, root, ancestor and filesystem root before the open hook', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'tree');
  await fs.mkdir(root);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'one link');
  assert.equal((await fs.stat(file, { bigint: true })).nlink, 1n);
  for (const target of [file, root, parent, '/']) {
    const { dev, ino } = await fs.stat(target, { bigint: true });
    let opened = false;
    await rejects(scan(root, { forbiddenInodes: [{ dev, ino }], onBeforeOpen: async candidate => {
      const stat = await fs.lstat(candidate, { bigint: true });
      if (stat.dev === dev && stat.ino === ino) opened = true;
    } }));
    assert.equal(opened, false, target);
  }
});

test('validates and snapshots forbidden identities', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'file');
  await fs.writeFile(file, 'contents');
  const stat = await fs.stat(file, { bigint: true });
  for (const forbiddenInodes of [null, {}, [{}], [{ dev: 1, ino: 1n }], [{ dev: -1n, ino: 1n }], new Array(10001).fill({ dev: 0n, ino: 0n })]) {
    await rejects(scan(root, { forbiddenInodes }));
  }
  const entry = { dev: stat.dev, ino: stat.ino };
  const list = [entry];
  await rejects(scan(root, { forbiddenInodes: list, onBeforeOpen: async () => { entry.ino = 0n; list.length = 0; } }));
  assert.equal((await scan(root, { forbiddenInodes: [{ dev: stat.dev + 1n, ino: stat.ino }] })).length, 2);
});

test('scanning an inode alias does not release a SQLite advisory lock or close its fd', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'dashboard.sqlite');
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec('CREATE TABLE x (id INTEGER); BEGIN IMMEDIATE');
  const { dev, ino, nlink } = await fs.stat(file, { bigint: true });
  assert.equal(nlink, 1n);
  const fds = async () => {
    const result = [];
    for (const fd of await fs.readdir('/proc/self/fd')) {
      try {
        const s = await fs.stat(`/proc/self/fd/${fd}`, { bigint: true });
        if (s.dev === dev && s.ino === ino) result.push(fd);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result.sort();
  };
  const denied = () => spawnSync('python3', ['-c', 'import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR); fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB,1,1073741825,os.SEEK_SET)', file]);
  assert.notEqual(denied().status, 0);
  const before = await fds();
  assert.ok(before.length > 0);
  await rejects(scan(root, { forbiddenInodes: [{ dev, ino }] }));
  assert.deepEqual(await fds(), before);
  assert.notEqual(denied().status, 0);
  db.exec('ROLLBACK');
  assert.equal(denied().status, 0);
});
