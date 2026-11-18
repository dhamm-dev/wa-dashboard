import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdsExclusiveFlock } from '../tools/flock-proof.mjs';

test('recognizes only a lock held by the current process', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flock-proof-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'gate');
  await writeFile(lock, '', { mode: 0o600 });
  assert.equal(await holdsExclusiveFlock(lock), false);
  const modulePath = fileURLToPath(new URL('../tools/flock-proof.mjs', import.meta.url));
  const script = `import { pathToFileURL } from 'node:url';
    const [modulePath, lock] = process.argv.slice(1);
    const { holdsExclusiveFlock } = await import(pathToFileURL(modulePath));
    if (!(await holdsExclusiveFlock(lock))) process.exit(2);`;
  const child = spawn('/usr/bin/flock', ['--nonblock', '--no-fork', lock, process.execPath,
    '--input-type=module', '--eval', script, modulePath, lock], { stdio: 'ignore' });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  assert.equal(result, 0);
  assert.equal(await holdsExclusiveFlock(lock), false);
});

test('rejects missing, relative, shared, and symbolic-link lock paths', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flock-proof-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await holdsExclusiveFlock('relative'), false);
  assert.equal(await holdsExclusiveFlock(path.join(dir, 'missing')), false);
  const shared = path.join(dir, 'shared');
  await writeFile(shared, '', { mode: 0o644 });
  await chmod(shared, 0o644);
  assert.equal(await holdsExclusiveFlock(shared), false);
  const link = path.join(dir, 'link');
  await symlink(shared, link);
  assert.equal(await holdsExclusiveFlock(link), false);
});

test('does not accept a lock held by a different process', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flock-proof-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = path.join(dir, 'gate');
  await writeFile(lock, '', { mode: 0o600 });
  const modulePath = fileURLToPath(new URL('../tools/flock-proof.mjs', import.meta.url));
  const script = `import { openSync, closeSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const [modulePath, lock] = process.argv.slice(1);
    const { holdsExclusiveFlock } = await import(pathToFileURL(modulePath));
    closeSync(openSync(lock, 'r'));
    if (!(await holdsExclusiveFlock(lock))) process.exit(2);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);`;
  const args = ['--nonblock', '--no-fork', lock, process.execPath,
    '--input-type=module', '--eval', script, modulePath, lock];
  const child = spawn('/usr/bin/flock', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error('Lock holder exited early')));
      child.stdout.once('data', resolve);
    });
    assert.equal(await holdsExclusiveFlock(lock), false);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  const reacquire = spawn('/usr/bin/flock', ['--nonblock', lock, '/usr/bin/true'], { stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => {
    reacquire.once('error', reject);
    reacquire.once('close', resolve);
  });
  assert.equal(code, 0);
});
