import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemdController } from '../tools/systemd-controller.mjs';

const unit = 'dummy-test.service';
const show = (overrides = {}) => Object.entries({ Id: unit, ActiveState: 'inactive', SubState: 'dead',
  MainPID: '0', ControlPID: '0', Job: '', InvocationID: 'invocation', Result: 'success', ...overrides })
  .map(([key, value]) => `${key}=${value}`).join('\n');
const evidence = () => ({ bootId: 'boot', managerId: 'manager', generation: 'generation', gateId: 'gate',
  gateHeld: true, writerCensusComplete: true, externalWriters: 0, unitWriters: 0, restartState: 'none',
  dataDirId: 'data', expectedDataDirId: 'data', cgroupCollectorTrusted: true, cgroupState: 'empty' });

function fixture({ shows = [], collect = evidence, run, timeoutMs = 35 } = {}) {
  const calls = [];
  let observations = 0;
  const runner = async (args, options) => {
    calls.push(args);
    if (run) return run(args, options);
    return { code: 0, stdout: args[1] === 'show' ? (shows[observations++] ?? show()) : '' };
  };
  const controller = createSystemdController({ unit, allowedUnit: unit, unitPattern: /^dummy-[a-z]+\.service$/,
    monitor: collect, runner, timeoutMs, intervalMs: 2 });
  return { controller, calls };
}
const rejects = promise => assert.rejects(promise, error => error.code === 'OPERATION_UNCONFIRMED' &&
  !String(error.stack).includes('SECRET') && !String(error.stack).includes('/private'));

test('stop requires a successful command and two confirmed observations', async () => {
  const stopped = show({ InvocationID: '', Job: '0' });
  const { controller, calls } = fixture({ shows: [show(), stopped, stopped] });
  await controller.stop();
  assert.deepEqual(calls.map(args => args[1]), ['show', 'stop', 'show', 'show']);
  assert.ok(calls.every(args => args.at(-1) === unit && args.at(-2) === '--'));
});

test('stop binds the prior invocation to the pre-stop systemd observation', async () => {
  for (const initial of [show({ InvocationID: '' }), show({ Job: '00' })]) {
    const { controller, calls } = fixture({ shows: [initial] });
    await rejects(controller.stop());
    assert.deepEqual(calls.map(args => args[1]), ['show']);
  }
  for (const later of [show({ InvocationID: 'new' }), show({ Job: '00' }), show({ Job: '0 ' })]) {
    const { controller } = fixture({ shows: [show(), ...Array(50).fill(later)], timeoutMs: 15,
      collect: () => ({ ...evidence(), priorInvocationId: 'new', invocationId: 'new' }) });
    await rejects(controller.stop());
  }
  const empty = show({ InvocationID: '' });
  const old = show();
  const { controller } = fixture({ shows: [old, empty, old, ...Array(50).fill(empty)], timeoutMs: 15,
    collect: (() => { let count = 0; return () => ({ ...evidence(), generation: count++ > 2 ? 'new' : 'generation' }); })() });
  await rejects(controller.stop());
});

test('start verifies stable healthy preview evidence', async () => {
  const active = show({ ActiveState: 'active', SubState: 'running', MainPID: '123' });
  const { controller } = fixture({ shows: [show(), active, active], collect: () => ({ ...evidence(),
    unitWriters: 1, cgroupState: 'populated', healthOk: true, appId: 'app', expectedAppId: 'app', cloneId: 'data', expectedCloneId: 'data' }) });
  await controller.start();
});

test('start cannot confirm an empty invocation ID', async () => {
  const active = show({ ActiveState: 'active', SubState: 'running', MainPID: '123', InvocationID: '', Job: '0' });
  const { controller } = fixture({ shows: [show({ InvocationID: '' }), ...Array(50).fill(active)], timeoutMs: 15,
    collect: () => ({ ...evidence(), unitWriters: 1, cgroupState: 'populated', healthOk: true,
      appId: 'app', expectedAppId: 'app', cloneId: 'data', expectedCloneId: 'data' }) });
  await rejects(controller.start());
});

test('timeout leaves the controller blocked even if the systemd job completes later', async () => {
  let complete;
  const { controller, calls } = fixture({ run: args => args[1] === 'show'
    ? Promise.resolve({ code: 0, stdout: show() })
    : new Promise(resolve => { complete = resolve; }) });
  await rejects(controller.stop());
  complete({ code: 0, stdout: '' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await rejects(controller.start());
  assert.deepEqual(calls.map(args => args[1]), ['show', 'stop']);
});

test('parent disconnect blocks future operations even when the runner ignores abort', async () => {
  const parent = new AbortController();
  const { controller, calls } = fixture({ run: args => args[1] === 'show'
    ? Promise.resolve({ code: 0, stdout: show() }) : new Promise(() => {}) });
  const operation = controller.stop({ signal: parent.signal });
  await new Promise(resolve => setTimeout(resolve, 3));
  parent.abort();
  await rejects(operation);
  await rejects(controller.start());
  assert.deepEqual(calls.map(args => args[1]), ['show', 'stop']);
});

test('stale, failed, missing and pending show properties cannot confirm a stop', async () => {
  for (const bad of [show({ ActiveState: 'active', SubState: 'running', MainPID: '1' }),
    show({ ActiveState: 'failed' }), show({ Job: '42' }), show({ MainPID: '' }),
    show().replace('Result=success', ''), show({ InvocationID: '00000000000000000000000000000000' }),
    show({ Result: 'exit-code' })]) {
    const { controller } = fixture({ shows: [show(), ...Array(50).fill(bad)], timeoutMs: 15 });
    await rejects(controller.stop());
  }
});

test('a failed action client cannot be followed by another action', async () => {
  const { controller, calls } = fixture({ run: async args => args[1] === 'show'
    ? { code: 0, stdout: show() } : { code: 1, stdout: 'SECRET /private/path' } });
  await rejects(controller.stop());
  await rejects(controller.start());
  assert.deepEqual(calls.map(args => args[1]), ['show', 'stop']);
});

test('unknown cgroup, incomplete root census, and changed identities fail closed', async () => {
  for (const change of [{ cgroupState: 'unknown' }, { cgroupCollectorTrusted: false },
    { writerCensusComplete: false }, { writerCensusComplete: undefined }, { externalWriters: 1 },
    { bootId: 'new' }, { generation: 'new' }]) {
    let count = 0;
    const { controller } = fixture({ timeoutMs: 15, collect: () => ({ ...evidence(), ...(count++ ? change : {}) }) });
    await rejects(controller.stop());
  }
});

test('only the exact allowlisted unit matching the supplied pattern is accepted', () => {
  const config = { unit, allowedUnit: unit, unitPattern: /^dummy-[a-z]+\.service$/, monitor: evidence };
  for (const change of [{ unit: 'other.service' }, { allowedUnit: 'other.service' },
    { unit: '--help', allowedUnit: '--help' }, { unitPattern: /dummy/ }, { unitPattern: /^other\.service$/ }]) {
    assert.throws(() => createSystemdController({ ...config, ...change }), TypeError);
  }
});

test('runner failures and collector exceptions never leak raw errors', async () => {
  for (const options of [
    { run: async () => { throw new Error('SECRET /private/path'); } },
    { run: async () => ({ code: 1, stdout: 'SECRET /private/path' }) },
    { collect: () => { throw new Error('SECRET /private/path'); } },
  ]) {
    const { controller } = fixture(options);
    await rejects(controller.stop());
    await rejects(controller.start());
  }
});
