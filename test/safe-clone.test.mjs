import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeClone } from '../tools/safe-clone.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'clone');
  await fs.mkdir(source);
  return { root, source, destination };
}
const clone = (options) => safeClone({ isQuiescent: async () => true, ...options });
const rejects = promise => assert.rejects(promise, { code: 'ECLONE', message: 'Clone failed; a private partial clone may remain' });

test('copies synthetic nested content with private permissions', async t => {
  const { source, destination } = await fixture(t);
  await fs.mkdir(path.join(source, 'sessions'));
  await fs.writeFile(path.join(source, 'sessions', 'key'), 'secret', { mode: 0o644 });
  await fs.writeFile(path.join(source, 'empty'), '');
  assert.deepEqual(await clone({ source, destination }), { files: 2, entries: 3 });
  assert.equal(await fs.readFile(path.join(destination, 'sessions', 'key'), 'utf8'), 'secret');
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(destination, 'sessions'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(destination, 'sessions', 'key'))).mode & 0o777, 0o600);
});

test('requires guard and rejects guard loss, retaining private partial clone', async t => {
  const { source, destination } = await fixture(t);
  await fs.writeFile(path.join(source, 'file'), 'original');
  await rejects(safeClone({ source, destination }));
  let calls = 0;
  await rejects(clone({ source, destination, isQuiescent: async () => ++calls === 1 }));
  assert.equal(calls, 2);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(path.join(source, 'file'), 'utf8'), 'original');
});

test('ignores concurrent unrelated ancestor changes and still detects guard loss', async t => {
  const { root, source } = await fixture(t);
  await fs.writeFile(path.join(source, 'file'), 'original');
  let running = true;
  let changes = 0;
  const churn = (async () => {
    while (running) {
      await fs.mkdir(path.join(root, 'unrelated'));
      await fs.rmdir(path.join(root, 'unrelated'));
      changes++;
    }
  })();
  try {
    for (let i = 0; i < 12; i++) {
      const destination = path.join(root, `clone-${i}`);
      let calls = 0;
      await rejects(clone({ source, destination, isQuiescent: async () => ++calls === 1 }));
      assert.equal(calls, 2);
      assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
    }
  } finally {
    running = false;
    await churn;
  }
  assert.ok(changes > 0);
  assert.equal(await fs.readFile(path.join(source, 'file'), 'utf8'), 'original');
});

test('rejects mutation during copy and preserves source and private partial clone', async t => {
  const { source, destination } = await fixture(t);
  const file = path.join(source, 'file');
  await fs.writeFile(file, Buffer.alloc(128 * 1024, 1));
  let mutated = false;
  await rejects(clone({ source, destination, onChunk: async () => {
    if (!mutated) { mutated = true; await fs.appendFile(file, 'changed'); }
  } }));
  assert.equal((await fs.stat(file)).size, 128 * 1024 + 7);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
});

test('rejects links, overlap, existing target and bounds', async t => {
  const { root, source, destination } = await fixture(t);
  const file = path.join(source, 'file');
  await fs.writeFile(file, 'abc');
  await fs.symlink('file', path.join(source, 'link'));
  await rejects(clone({ source, destination }));
  await fs.unlink(path.join(source, 'link'));
  await fs.link(file, path.join(source, 'link'));
  await rejects(clone({ source, destination }));
  await fs.unlink(path.join(source, 'link'));
  await rejects(clone({ source, destination: path.join(source, 'nested') }));
  await fs.symlink(source, path.join(root, 'alias'));
  await rejects(clone({ source, destination: path.join(root, 'alias', 'nested') }));
  await rejects(clone({ source, destination, maxBytes: 2 }));
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'keep'), 'untouched');
  await rejects(clone({ source, destination }));
  assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'untouched');
  assert.equal(await fs.readFile(file, 'utf8'), 'abc');
});

test('rejects forbidden source and destination ancestors before open', async t => {
  const { root, source } = await fixture(t);
  const destinationParent = path.join(root, 'destination-parent');
  await fs.mkdir(destinationParent);
  const file = path.join(source, 'file');
  await fs.writeFile(file, 'private');
  for (const target of [file, source, root, destinationParent, '/']) {
    const { dev, ino } = await fs.stat(target, { bigint: true });
    let opened = false;
    await rejects(clone({ source, destination: path.join(destinationParent, 'clone'), forbiddenInodes: [{ dev, ino }], onBeforeOpen: async candidate => {
      try {
        const stat = await fs.lstat(candidate, { bigint: true });
        if (stat.dev === dev && stat.ino === ino) opened = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } }));
    assert.equal(opened, false, target);
  }
});

test('copy stage rejects a newly forbidden alias and detects replacement', async t => {
  const { root, source, destination } = await fixture(t);
  const file = path.join(source, 'file');
  const alias = path.join(root, 'alias');
  await fs.writeFile(file, 'original');
  await fs.writeFile(alias, 'alias');
  const { dev, ino } = await fs.stat(alias, { bigint: true });
  let changed = false;
  await rejects(clone({ source, destination, forbiddenInodes: [{ dev, ino }], onBeforeOpen: async candidate => {
    if (!changed && candidate.endsWith('/file') && await fs.stat(destination).then(() => true, () => false)) {
      changed = true;
      await fs.rename(alias, file);
    }
  } }));
  assert.equal(changed, true);
});

test('ancestor changes inside the inspection hook still reach and reject a forbidden replacement', async t => {
  const { root } = await fixture(t);
  const ancestor = await fs.stat(root, { bigint: true });
  const cases = [];
  for (let i = 0; i < 8; i++) {
    const parent = path.join(root, `case-${i}`);
    const source = path.join(parent, 'source');
    await fs.mkdir(source, { recursive: true });
    const file = path.join(source, 'file');
    const alias = path.join(parent, 'alias');
    await fs.writeFile(file, 'original');
    await fs.writeFile(alias, 'alias');
    const { dev, ino } = await fs.stat(alias, { bigint: true });
    cases.push({ i, source, destination: path.join(parent, 'clone'), file, alias, dev, ino });
  }
  await Promise.all(cases.map(async ({ i, source, destination, file, alias, dev, ino }) => {
    let disturbed = false;
    let changed = false;
    await rejects(clone({ source, destination, forbiddenInodes: [{ dev, ino }], onBeforeOpen: async candidate => {
      if (!disturbed) {
        const stat = await fs.lstat(candidate, { bigint: true });
        if (stat.dev === ancestor.dev && stat.ino === ancestor.ino) {
          disturbed = true;
          await fs.writeFile(path.join(root, `unrelated-${i}`), 'dummy');
        }
      }
      if (!changed && candidate.endsWith('/file') && await fs.stat(destination).then(() => true, () => false)) {
        changed = true;
        await fs.rename(alias, file);
      }
    } }));
    assert.equal(disturbed, true);
    assert.equal(changed, true);
  }));
});
