import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startIsolatedClone } from '../tools/isolated-clone-guard.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-clone-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const lockDir = path.join(root, 'private-lock');
  await fs.mkdir(source);
  await fs.mkdir(lockDir, { mode: 0o700 });
  await fs.writeFile(path.join(source, 'data'), Buffer.alloc(128 * 1024, 3));
  return { root, source, lockFile: path.join(lockDir, 'gate.sqlite'), callerGuardsQuiescence: true };
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('cooperating children exclude each other even after closing an unrelated descriptor; SIGKILL releases lock', async t => {
  const opts = await fixture(t);
  const locked = deferred(), release = deferred();
  const first = startIsolatedClone({ ...opts, destination: path.join(opts.root, 'first'), closeUnrelatedFd: true,
    onLocked: () => { locked.resolve(); return release.promise; } });
  const firstResult = first.result.catch(error => error);
  t.after(() => { first.child.kill('SIGKILL'); release.resolve(); });
  await locked.promise;
  const second = startIsolatedClone({ ...opts, destination: path.join(opts.root, 'second') });
  await assert.rejects(second.result, { code: 'EISOLATEDCLONE' });
  first.child.kill('SIGKILL');
  assert.equal((await firstResult).code, 'EISOLATEDCLONE');
  assert.notEqual(first.child.signalCode, null);
  const third = startIsolatedClone({ ...opts, destination: path.join(opts.root, 'third') });
  assert.deepEqual(await third.result, { files: 1, entries: 1 });
  assert.equal(third.child.exitCode, 0);
});

test('clone child does not inherit incompatible Node CLI flags', async t => {
  const opts = await fixture(t);
  const modulePath = fileURLToPath(new URL('../tools/isolated-clone-guard.mjs', import.meta.url));
  const destination = path.join(opts.root, 'flagged-parent');
  const script = `
    import { pathToFileURL } from 'node:url';
    const [modulePath, source, destination, lockFile] = process.argv.slice(1);
    const { startIsolatedClone } = await import(pathToFileURL(modulePath));
    const result = await startIsolatedClone({ source, destination, lockFile, callerGuardsQuiescence: true }).result;
    if (result.files !== 1 || result.entries !== 1) throw Error('unexpected result');
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', script,
    modulePath, opts.source, destination, opts.lockFile], { timeout: 10000 });
  assert.deepEqual(await fs.readFile(path.join(destination, 'data')), await fs.readFile(path.join(opts.source, 'data')));
});

test('forbidden lock inode alias in source fails and error leaves any partial destination private', async t => {
  const opts = await fixture(t);
  const alias = path.join(opts.source, 'alias');
  const run = startIsolatedClone({ ...opts, destination: path.join(opts.root, 'clone'),
    onLocked: () => fs.link(opts.lockFile, alias) });
  await assert.rejects(run.result, { code: 'EISOLATEDCLONE' });
  assert.equal(await fs.stat(path.join(opts.root, 'clone')).then(() => true, () => false), false);
});

test('bind-mounted lock inode in source is rejected in a synthetic mount namespace', async t => {
  const opts = await fixture(t);
  const alias = path.join(opts.source, 'alias');
  await fs.writeFile(opts.lockFile, '', { mode: 0o600 });
  await fs.writeFile(alias, '');
  const modulePath = fileURLToPath(new URL('../tools/isolated-clone-guard.mjs', import.meta.url));
  const script = `
    import { execFileSync } from 'node:child_process';
    import { stat } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const [lock, alias, source, destination, modulePath] = process.argv.slice(1);
    execFileSync('mount', ['--bind', lock, alias]);
    const a = await stat(lock, { bigint: true }), b = await stat(alias, { bigint: true });
    if (a.dev !== b.dev || a.ino !== b.ino || a.nlink !== 1n) throw Error('invalid bind fixture');
    const { startIsolatedClone } = await import(pathToFileURL(modulePath));
    let locked = false;
    try {
      await startIsolatedClone({ lockFile: lock, source, destination, callerGuardsQuiescence: true,
        onLocked: () => { locked = true; } }).result;
      throw Error('clone unexpectedly succeeded');
    } catch (error) { if (error.code !== 'EISOLATEDCLONE') throw error; }
    if (!locked) throw Error('lock checkpoint was not reached');
  `;
  await execFileAsync('unshare', ['--user', '--map-root-user', '--mount', process.execPath, '--input-type=module', '--eval', script,
    opts.lockFile, alias, opts.source, path.join(opts.root, 'clone'), modulePath], { timeout: 10000 });
});

test('copy error retains a private partial destination and child has exited', async t => {
  const opts = await fixture(t);
  const destination = path.join(opts.root, 'partial');
  let changed = false;
  const run = startIsolatedClone({ ...opts, destination, onChunk: async () => {
    if (!changed) { changed = true; await fs.appendFile(path.join(opts.source, 'data'), 'changed'); }
  } });
  await assert.rejects(run.result, { code: 'EISOLATEDCLONE' });
  assert.equal(changed, true);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
  assert.notEqual(run.child.exitCode, null);
});

test('refuses lock files within trees, symlink paths and hardlinked preexisting lock files', async t => {
  const opts = await fixture(t);
  const dest = path.join(opts.root, 'clone');
  for (const lockFile of [path.join(opts.source, 'gate'), path.join(dest, 'gate')]) {
    await assert.rejects(startIsolatedClone({ ...opts, destination: dest, lockFile }).result, { code: 'EISOLATEDCLONE' });
  }
  const real = path.join(opts.root, 'real');
  await fs.writeFile(real, '');
  await fs.symlink(real, opts.lockFile);
  await assert.rejects(startIsolatedClone({ ...opts, destination: dest }).result, { code: 'EISOLATEDCLONE' });
  await fs.unlink(opts.lockFile);
  await fs.link(real, opts.lockFile);
  await assert.rejects(startIsolatedClone({ ...opts, destination: dest }).result, { code: 'EISOLATEDCLONE' });
});
