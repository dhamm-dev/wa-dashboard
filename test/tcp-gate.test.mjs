import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { portForIdentity, withTcpGate } from '../tools/tcp-gate.mjs';

if (process.argv[2] === '--gate-child') {
  const result = await withTcpGate(process.argv[3], async () => {
    process.send('held');
    await new Promise(resolve => process.once('message', resolve));
  });
  process.send(result.status);
  process.disconnect();
} else {
  const childPath = fileURLToPath(import.meta.url);
  function child(dir) {
    const proc = fork(childPath, ['--gate-child', dir], { silent: true });
    const messages = [];
    const waiters = [];
    proc.on('message', message => waiters.length ? waiters.shift()(message) : messages.push(message));
    return { proc, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)) };
  }
  async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'tcp-gate-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
  }
  const exit = proc => new Promise(resolve => proc.once('exit', resolve));

  test('cross-process exclusion survives unrelated descriptor close and SIGKILL releases it', { timeout: 10000 }, async t => {
    const dir = await fixture(t);
    const alias = `${dir}-alias`;
    await symlink(dir, alias);
    t.after(() => rm(alias, { force: true }));
    const first = child(dir);
    t.after(() => { if (first.proc.exitCode === null && first.proc.signalCode === null) first.proc.kill('SIGKILL'); });
    assert.equal(await first.next(), 'held');
    const fd = await open(dir, 'r');
    await fd.close();
    const second = child(alias);
    assert.equal(await second.next(), 'GATE_UNAVAILABLE');
    const secondExit = exit(second.proc);
    await secondExit;
    const firstExit = exit(first.proc);
    first.proc.kill('SIGKILL');
    await firstExit;
    const third = child(dir);
    t.after(() => { if (third.proc.exitCode === null && third.proc.signalCode === null) third.proc.kill('SIGKILL'); });
    assert.equal(await third.next(), 'held');
    const thirdExit = exit(third.proc);
    third.proc.send('stop');
    assert.equal(await third.next(), 'OK');
    await thirdExit;
  });

  test('different identities forced to collide fail closed', { timeout: 20000 }, async t => {
    const root = await fixture(t);
    const seen = new Map();
    let pair;
    for (let i = 0; i < 5000 && !pair; i++) {
      const dir = join(root, String(i));
      await mkdir(dir);
      const { dev, ino } = await stat(dir, { bigint: true });
      const port = portForIdentity(dev, ino);
      if (seen.has(port)) pair = [seen.get(port), dir];
      else seen.set(port, dir);
    }
    assert.ok(pair, 'expected a collision in the bounded port space');
    await withTcpGate(pair[0], async () => {
      assert.deepEqual(await withTcpGate(pair[1], () => assert.fail('must not run')), { status: 'GATE_UNAVAILABLE' });
    });
  });

  test('loopback-only binding and private handle', async t => {
    const dir = await fixture(t);
    const { dev, ino } = await stat(dir, { bigint: true });
    const other = net.createServer();
    t.after(() => other.close());
    const result = await withTcpGate(dir, async context => {
      assert.deepEqual(Object.keys(context), ['signal']);
      await new Promise((resolve, reject) => other.once('error', reject).listen({ host: '127.0.0.2', port: portForIdentity(dev, ino), exclusive: true }, resolve));
      return 42;
    });
    assert.deepEqual(result, { status: 'OK', value: 42 });
  });

  test('timeout aborts but holds the gate until work settles', async t => {
    const dir = await fixture(t);
    let finish;
    let aborted;
    const stopped = new Promise(resolve => { aborted = resolve; });
    const pending = withTcpGate(dir, ({ signal }) => new Promise(resolve => {
      finish = resolve;
      signal.addEventListener('abort', aborted, { once: true });
    }), { timeoutMs: 20 });
    await stopped;
    assert.deepEqual(await withTcpGate(dir, () => {}), { status: 'GATE_UNAVAILABLE' });
    finish();
    assert.deepEqual(await pending, { status: 'OPERATION_UNCONFIRMED' });
    assert.equal((await withTcpGate(dir, () => {})).status, 'OK');
  });

  test('unexpected gate error aborts work and reports uncertainty after it settles', async t => {
    const dir = await fixture(t);
    const createServer = net.createServer;
    let server;
    t.mock.method(net, 'createServer', (...args) => (server = createServer(...args)));
    let finish;
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    let signal;
    const pending = withTcpGate(dir, context => new Promise(resolve => {
      signal = context.signal;
      finish = resolve;
      ready();
    }));
    await started;
    server.emit('error', new Error('private detail'));
    assert.equal(signal.aborted, true);
    assert.deepEqual(await withTcpGate(dir, () => {}), { status: 'GATE_UNAVAILABLE' });
    finish();
    assert.deepEqual(await pending, { status: 'OPERATION_UNCONFIRMED' });
  });

  test('failures do not disclose callback errors or directory names', async t => {
    const dir = await fixture(t);
    const secret = 'sensitive-value';
    const result = await withTcpGate(dir, () => { throw new Error(secret); });
    assert.deepEqual(result, { status: 'OPERATION_FAILED' });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.deepEqual(await withTcpGate(join(dir, secret), () => {}), { status: 'IDENTITY_UNAVAILABLE' });
  });
}
