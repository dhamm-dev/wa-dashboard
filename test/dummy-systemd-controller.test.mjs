import test from 'node:test';
import assert from 'node:assert/strict';
import { createDummySystemdController } from '../tools/dummy-systemd-controller.mjs';

const prefix = ['-u', 'dhexct528dec24', '--', '/usr/bin/env', 'XDG_RUNTIME_DIR=/run/user/999',
  'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus', '/usr/bin/systemctl', '--user'];
const exec = '{ path=/usr/bin/sleep ; argv[]=/usr/bin/sleep 180 ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';
const serialize = value => Object.entries(value).map(([k, v]) => `${k}=${v}`).join('\n');
const isolation = () => ({ synthetic: true, lockedNologin: true, ownerOnlyBus: true, supervisorOwned: true, noAdversarialActors: true });
const evidence = () => ({ synthetic: true, bootId: 'boot', managerId: 'manager', generation: 'generation', gateId: 'gate',
  gateHeld: true, writerCensusComplete: true, externalWriters: 0, unitWriters: 0, restartState: 'none',
  dataDirId: 'data', expectedDataDirId: 'data', cgroupCollectorTrusted: true, cgroupState: 'empty' });
const unconfirmed = error => error.code === 'OPERATION_UNCONFIRMED' && !/SECRET|private/.test(String(error.stack));

test('provision uses absent preflight and fixed commands for two distinct minted units', async () => {
  const { result, provisioningCalls, target, holder } = await fixture();
  assert.equal(result.status, 'provisioned-in-mock');
  assert.notEqual(target, holder);
  assert.deepEqual(provisioningCalls.slice(0, 2).map(([, a]) => a.at(-1)), [target, holder]);
  assert.ok(provisioningCalls.slice(0, 2).every(([, a]) => a.includes('--property=LoadState')));
  const creates = provisioningCalls.filter(([, a]) => a.includes('/usr/bin/systemd-run'));
  assert.deepEqual(creates.map(([file, args]) => [file, args]), [
    ['/usr/sbin/runuser', [...prefix.slice(0, 6), '/usr/bin/systemd-run', '--user', `--unit=${target}`, '--property=RuntimeMaxSec=180', '/usr/bin/sleep', '180']],
    ['/usr/sbin/runuser', [...prefix.slice(0, 6), '/usr/bin/systemd-run', '--user', `--unit=${holder}`, '--property=RuntimeMaxSec=180', `--property=Wants=${target}`, '/usr/bin/sleep', '180']],
  ]);
});

test('uncertain or existing preflight locks provisioning without creating or stopping anything', async () => {
  for (const result of [{ code: 0, stdout: 'LoadState=loaded\n' }, { code: 1, stdout: 'LoadState=not-found' },
    { code: 0, stdout: 'LoadState=not-found\nSECRET' }, null]) {
    const calls = [];
    const controller = createDummySystemdController({ runner: async (file, args) => { calls.push(args); return result; }, monitor: evidence, isolation, timeoutMs: 20, intervalMs: 1 });
    await assert.rejects(controller.provision(), unconfirmed);
    await assert.rejects(controller.provision(), unconfirmed);
    await assert.rejects(controller.stop(), unconfirmed);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][8], 'show');
  }
});

test('uncertain creation is never retried or followed by cleanup', async () => {
  const calls = [];
  const controller = createDummySystemdController({ runner: async (file, args) => {
    calls.push(args);
    if (args.includes('--property=LoadState')) return { code: 0, stdout: 'LoadState=not-found' };
    throw Error('SECRET /private');
  }, monitor: evidence, isolation, timeoutMs: 20, intervalMs: 1 });
  await assert.rejects(controller.provision(), unconfirmed);
  await assert.rejects(controller.stop(), unconfirmed);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes('/usr/bin/systemd-run'));
});

test('metadata mismatch after either creation blocks all further actions without cleanup', async () => {
  for (const badCreate of [1, 2]) {
    const calls = [];
    let target;
    let created = 0;
    const controller = createDummySystemdController({ runner: async (file, args) => {
      calls.push(args);
      if (args.includes('--property=LoadState')) return { code: 0, stdout: 'LoadState=not-found' };
      if (args.includes('/usr/bin/systemd-run')) {
        created++;
        if (created === 1) target = args.find(a => a.startsWith('--unit=')).slice(7);
        return { code: 0, stdout: '' };
      }
      const unit = args.at(-1);
      return { code: 0, stdout: serialize({ Id: unit, Names: created === badCreate ? `${unit} alias.service` : unit,
        Transient: 'yes', ExecStart: exec, Wants: created === 2 ? target : '', Requires: 'basic.target',
        Requisite: '', BindsTo: '', PartOf: '' }) };
    }, monitor: evidence, isolation, timeoutMs: 100, intervalMs: 1 });
    await assert.rejects(controller.provision(), unconfirmed);
    await assert.rejects(controller.stop(), unconfirmed);
    assert.equal(created, badCreate);
    assert.ok(calls.every(a => a[8] !== 'stop'));
  }
});

test('provision timeout and concurrent request lock out late work', async () => {
  for (const concurrent of [false, true]) {
    let release;
    let started;
    const runnerStarted = new Promise(resolve => { started = resolve; });
    const calls = [];
    const controller = createDummySystemdController({ runner: (file, args) => {
      calls.push(args);
      started();
      return new Promise(resolve => { release = resolve; });
    }, monitor: evidence, isolation, timeoutMs: 10, intervalMs: 1 });
    const pending = assert.rejects(controller.provision(), unconfirmed);
    await runnerStarted;
    if (concurrent) await assert.rejects(controller.provision(), unconfirmed);
    if (!concurrent) await pending;
    release({ code: 0, stdout: 'LoadState=not-found' });
    if (concurrent) await pending;
    await new Promise(resolve => setTimeout(resolve, 2));
    await assert.rejects(controller.start(), unconfirmed);
    assert.equal(calls.length, 1);
  }
});

async function fixture(overrides = {}) {
  const calls = [];
  let active = true;
  let metadataCount = 0;
  let ready = false;
  let target;
  let holder;
  const runner = async (file, args) => {
    calls.push([file, args]);
    if (ready && overrides.run) return overrides.run(file, args);
    if (args.includes('/usr/bin/systemd-run')) {
      const unit = args.find(arg => arg.startsWith('--unit=')).slice(7);
      if (!target) target = unit; else holder = unit;
      return { code: 0, stdout: '' };
    }
    if (args.includes('--property=LoadState')) return { code: 0, stdout: 'LoadState=not-found\n' };
    const unit = args.at(-1);
    const verb = args[8];
    if (verb === 'stop') { active = false; return { code: 0, stdout: '' }; }
    if (verb === 'start') { active = true; return { code: 0, stdout: '' }; }
    if (args.includes('--property=Names')) {
      const value = { Id: unit, Names: unit, Transient: 'yes', ExecStart: exec, Wants: unit === holder ? target : '', Requires: 'basic.target', Requisite: '', BindsTo: '', PartOf: '' };
      if (ready) overrides.metadata?.(value, ++metadataCount);
      return { code: 0, stdout: serialize(value) };
    }
    return { code: 0, stdout: serialize({ Id: unit, ActiveState: active ? 'active' : 'inactive',
      SubState: active ? 'running' : 'dead', MainPID: active ? '123' : '0', ControlPID: '0', Job: '',
      InvocationID: active ? 'invocation' : '', Result: 'success' }) };
  };
  const controller = createDummySystemdController({ runner, monitor: overrides.monitor ?? evidence,
    isolation: () => ready && overrides.isolation ? overrides.isolation() : isolation(), timeoutMs: overrides.timeoutMs ?? 100, intervalMs: 1 });
  const result = await controller.provision();
  const provisioningCalls = calls.slice();
  calls.length = 0;
  ready = true;
  return { controller, calls, provisioningCalls, result, target, holder };
}

test('mock stop inspects immediately before and after action and confirms two observations', async () => {
  const { controller, calls } = await fixture();
  assert.deepEqual(await controller.stop(), { role: 'dummy', evidence: 'synthetic', status: 'confirmed-in-mock' });
  assert.equal(controller.role, 'dummy');
  assert.deepEqual(calls.map(([, a]) => a[8] === 'show' && a.includes('--property=Names') ? 'inspect' : a[8]),
    ['show', 'inspect', 'inspect', 'stop', 'inspect', 'inspect', 'show', 'show']);
  const unit = calls[0][1].at(-1);
  assert.match(unit, /^dhexbot-cutover-test-[0-9a-f-]+\.service$/);
  for (const [file, args] of calls) {
    assert.equal(file, '/usr/sbin/runuser');
    assert.deepEqual(args.slice(0, 8), prefix);
    assert.ok(args.at(-1) === unit || args.includes('--property=Names'));
    assert.equal(args.at(-2), '--');
  }
});

test('mock start requires healthy synthetic evidence and two observations', async () => {
  const monitor = () => ({ ...evidence(), unitWriters: 1, cgroupState: 'populated', healthOk: true,
    appId: 'app', expectedAppId: 'app', cloneId: 'data', expectedCloneId: 'data' });
  const { controller } = await fixture({ monitor });
  assert.equal((await controller.start()).status, 'confirmed-in-mock');
});

test('alias or unexpected change blocks action or reports post-action mismatch', async () => {
  for (const changeAt of [1, 3]) {
    const { controller, calls } = await fixture({ metadata: (value, count) => { if (count === changeAt) value.Names += ' alias.service'; } });
    await assert.rejects(controller.stop(), unconfirmed);
    assert.equal(calls.filter(([, a]) => a[8] === 'stop').length, changeAt === 1 ? 0 : 1);
    await assert.rejects(controller.start(), unconfirmed);
  }
});

test('foreign capability, unit and malicious arguments are never accepted', async () => {
  for (const arg of [Object.freeze(Object.create(null)), 'production.service', '--help', { unit: 'production.service' }]) {
    const { controller, calls } = await fixture();
    await assert.rejects(controller.stop(arg), unconfirmed);
    await assert.rejects(controller.stop(), unconfirmed);
    assert.equal(calls.length, 0);
  }
  for (const extra of [{ unit: 'production.service' }, { capability: {} }, { path: '/private' }]) {
    assert.throws(() => createDummySystemdController({ runner() {}, monitor() {}, isolation() {}, ...extra }), unconfirmed);
  }
});

test('requires explicit synthetic isolation and monitoring on every observation', async () => {
  for (const key of Object.keys(isolation())) {
    const { controller, calls } = await fixture({ isolation: () => ({ ...isolation(), [key]: false }) });
    await assert.rejects(controller.stop(), unconfirmed);
    assert.equal(calls.filter(([, a]) => a[8] === 'stop').length, 0);
  }
  const { controller } = await fixture({ monitor: () => ({ ...evidence(), synthetic: false }) });
  await assert.rejects(controller.stop(), unconfirmed);
});

test('errors are redacted and concurrent operations block the in-flight action', async () => {
  for (const options of [{ run: () => { throw Error('SECRET /private'); } },
    { monitor: () => { throw Error('SECRET /private'); } }]) {
    const { controller } = await fixture(options);
    await assert.rejects(controller.stop(), unconfirmed);
    await assert.rejects(controller.start(), unconfirmed);
  }
  let release;
  let started;
  const runnerStarted = new Promise(resolve => { started = resolve; });
  const { controller, calls } = await fixture({ run: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const first = assert.rejects(controller.stop(), unconfirmed);
  await runnerStarted;
  await assert.rejects(controller.start(), unconfirmed);
  release({ code: 0, stdout: 'SECRET' });
  await first;
  assert.equal(calls.length, 1);
});

test('timeout blocks subsequent actions even when the mock runner resolves late', async () => {
  let release;
  const { controller, calls } = await fixture({ timeoutMs: 10, run: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(controller.stop(), unconfirmed);
  release({ code: 0, stdout: 'SECRET' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(controller.start(), unconfirmed);
  assert.equal(calls.length, 1);
});

test('a late inspection after timeout cannot issue the action', async () => {
  let release;
  const { controller, calls } = await fixture({ timeoutMs: 10, run: (file, args) => {
    const unit = args.at(-1);
    if (args.includes('--property=Names')) return new Promise(resolve => {
      release = () => resolve({ code: 0, stdout: serialize({ Id: unit, Names: unit, Transient: 'yes', ExecStart: exec,
        Wants: '', Requires: 'basic.target', Requisite: '', BindsTo: '', PartOf: '' }) });
    });
    return Promise.resolve({ code: 0, stdout: serialize({ Id: unit, ActiveState: 'active', SubState: 'running',
      MainPID: '123', ControlPID: '0', Job: '', InvocationID: 'invocation', Result: 'success' }) });
  } });
  await assert.rejects(controller.stop(), unconfirmed);
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(controller.stop(), unconfirmed);
  assert.deepEqual(calls.map(([, a]) => a[8]), ['show', 'show']);
});
