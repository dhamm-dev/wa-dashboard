import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUserSystemctlRunner } from '../tools/user-systemctl-runner.mjs';
import { createSystemdController } from '../tools/systemd-controller.mjs';

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kill = () => true;
  return child;
}

test('runs only allowlisted service commands through the fixed user manager', async () => {
  let observed;
  const child = childProcess();
  const run = createUserSystemctlRunner({ getUid: () => 0, spawnProcess: (file, args, options) => {
    observed = { file, args, options };
    return child;
  } });
  const request = run(['--user', 'show', '--property=MainPID', '--', 'wa-dashboard.service']);
  child.stdout.emit('data', 'MainPID=123\n');
  child.emit('close', 0);
  assert.deepEqual(await request, { code: 0, stdout: 'MainPID=123\n' });
  assert.equal(observed.file, '/usr/sbin/runuser');
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.args.slice(-5), ['--user', 'show', '--property=MainPID', '--', 'wa-dashboard.service']);
  assert.equal(observed.options.env.LANG, 'C');
});

test('rejects other units, commands, unknown properties, and non-root execution', async () => {
  let calls = 0;
  const spawnProcess = () => { calls++; return childProcess(); };
  const root = createUserSystemctlRunner({ getUid: () => 0, spawnProcess });
  const user = createUserSystemctlRunner({ getUid: () => 1000, spawnProcess });
  for (const args of [
    ['--user', 'stop', '--', 'other.service'],
    ['--user', 'restart', '--', 'wa-dashboard.service'],
    ['--user', 'show', '--property=Environment', '--', 'wa-dashboard.service'],
    ['--user', 'show', '--property=MainPID', '--property=MainPID', '--', 'wa-dashboard.service'],
  ]) await assert.rejects(root(args), { code: 'OPERATION_UNCONFIRMED' });
  await assert.rejects(user(['--user', 'stop', '--', 'wa-dashboard.service']), { code: 'OPERATION_UNCONFIRMED' });
  assert.equal(calls, 0);
});

test('timeouts, aborts, oversized output, and subprocess errors are sanitized', async () => {
  for (const reason of ['timeout', 'abort', 'output', 'error']) {
    const child = childProcess();
    const controller = new AbortController();
    const run = createUserSystemctlRunner({ getUid: () => 0, timeoutMs: 10, spawnProcess: () => child });
    const request = run(['--user', 'stop', '--', 'wa-dashboard.service'], { signal: controller.signal });
    const rejected = assert.rejects(request, error => error.code === 'OPERATION_UNCONFIRMED' && !error.message.includes('sensitive'));
    if (reason === 'abort') controller.abort();
    if (reason === 'output') child.stdout.emit('data', 'x'.repeat(65537));
    if (reason === 'error') child.emit('error', new Error('sensitive'));
    await rejected;
  }
});

test('controller and fixed-user runner preserve stop and start ordering', async () => {
  let running = true;
  let invocation = 'first';
  const calls = [];
  const run = createUserSystemctlRunner({ getUid: () => 0, spawnProcess: (_file, args) => {
    const child = childProcess();
    const verb = args[args.indexOf('--user') + 1];
    calls.push(verb);
    queueMicrotask(() => {
      if (verb === 'stop') running = false;
      if (verb === 'start') { running = true; invocation = 'second'; }
      if (verb === 'show') {
        child.stdout.emit('data', [
          'Id=wa-dashboard.service',
          `ActiveState=${running ? 'active' : 'inactive'}`,
          `SubState=${running ? 'running' : 'dead'}`,
          `MainPID=${running ? '123' : '0'}`,
          'ControlPID=0', 'Job=', `InvocationID=${running ? invocation : ''}`, 'Result=success', '',
        ].join('\n'));
      }
      child.emit('close', 0);
    });
    return child;
  } });
  const monitor = async () => ({
    bootId: 'boot', managerId: 'manager', generation: 'generation', gateId: 'gate', gateHeld: true,
    writerCensusComplete: true, externalWriters: 0, restartState: 'none',
    dataDirId: 'clone', expectedDataDirId: 'clone', unitWriters: running ? 1 : 0,
    cgroupCollectorTrusted: true, cgroupState: running ? 'populated' : 'absent',
    healthOk: running, appId: 'preview', expectedAppId: 'preview', cloneId: 'clone', expectedCloneId: 'clone',
  });
  const controller = createSystemdController({
    unit: 'wa-dashboard.service', allowedUnit: 'wa-dashboard.service',
    unitPattern: /^wa-dashboard\.service$/, runner: run, monitor, intervalMs: 1,
  });
  await controller.stop();
  assert.equal(running, false);
  await controller.start();
  assert.equal(running, true);
  assert.deepEqual(calls.filter(verb => verb !== 'show'), ['stop', 'start']);
});
