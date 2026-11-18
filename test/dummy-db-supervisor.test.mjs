import test from 'node:test';
import assert from 'node:assert/strict';
import { createDummyDbSupervisor } from '../tools/dummy-db-supervisor.mjs';

const unconfirmed = error => error.code === 'OPERATION_UNCONFIRMED' && error.message === 'Dummy DB operation unconfirmed';

function setup(mutate = (_request, result) => result) {
  const units = new Map();
  const calls = [];
  let identity;
  const evidence = request => {
    calls.push(request);
    let result;
    if (request.kind === 'preflight') result = { ...request.account, loginDisabled: true, sudoGroups: false, busOwnerUid: 999, busOwnerOnly: true, synthetic: true };
    if (request.kind === 'create-fixture') {
      identity = { dev: 123, ino: 456 };
      result = { ...identity, path: request.path, uid: 999, gid: 983, mode: 0o600, regular: true, symlink: false, sqlite: true, synthetic: true };
    }
    if (request.kind === 'absent') result = { unit: request.unit, absent: !units.has(request.unit), synthetic: true };
    if (request.kind === 'inspect') {
      const { spec, active } = units.get(request.unit);
      result = { id: spec.unit, names: spec.unit, transient: true, executable: spec.executable, args: spec.args,
        runtimeMaxSec: spec.runtimeMaxSec, stdinMode: spec.wants.length ? 'null' : 'file', uid: 999, gid: 983,
        cgroup: active ? `/user.slice/user-999.slice/user@999.service/app.slice/${spec.unit}` : '',
        cgroupTrusted: true, cgroupPid: active ? (spec.wants.length ? 102 : 101) : 0, cgroupGeneration: 77, job: false,
        wants: spec.wants, otherDependencies: [], active, pid: active ? (spec.wants.length ? 102 : 101) : 0, synthetic: true };
    }
    if (request.kind === 'fd0') result = { ...identity, unit: request.unit, pid: request.pid,
      generation: request.generation, uid: 999, synthetic: true };
    if (request.kind === 'hash') result = { ...identity, path: request.path, sha256: 'a'.repeat(64), synthetic: true };
    if (request.kind === 'targetCgroupQuiescent') result = { synthetic: true, trusted: true, unit: request.unit,
      actualControlGroup: request.actualControlGroup, path: request.recordedCgroup.path,
      generation: request.recordedCgroup.generation, scopedPid: request.recordedCgroup.pid,
      mainPid: 0, job: false, state: 'absent' };
    if (request.kind === 'holderQuiescent') result = { unit: request.unit, cgroup: request.cgroup, found: true, pid: 0, job: false, cgroupEmpty: true, synthetic: true };
    return mutate(request, result);
  };
  const runner = request => {
    calls.push(request);
    if (request.action === 'provision') units.set(request.spec.unit, { spec: request.spec, active: true });
    else units.get(request.spec.unit).active = request.action === 'start';
    return mutate(request, { action: request.action, unit: request.spec.unit, confirmed: true, synthetic: true });
  };
  const census = request => {
    calls.push({ ...request, kind: 'census' });
    const pids = [...units.values()].filter(x => x.active && x.spec.stdin.startsWith('file:')).map(() => 101);
    return mutate({ ...request, kind: 'census' }, { ...request.identity, path: request.path, pids, complete: true, synthetic: true });
  };
  const safeClone = request => {
    calls.push({ ...request, kind: 'clone' });
    return mutate({ ...request, kind: 'clone' }, { source: request.source, destination: request.destination, dev: 123, ino: 457, confirmed: true, synthetic: true });
  };
  return { supervisor: createDummyDbSupervisor({ evidence, runner, census, safeClone }), calls };
}

test('simulates isolated provisioning, clone and stop/start cycle', async () => {
  const { supervisor, calls } = setup();
  assert.deepEqual(await supervisor.provisionAndValidate(), { status: 'synthetic-cycle-complete' });
  const actions = calls.filter(x => x.action);
  assert.deepEqual(actions.map(x => x.action), ['provision', 'provision', 'stop', 'start', 'stop', 'stop']);
  const [target, holder] = actions.map(x => x.spec);
  assert.deepEqual(actions.map(x => x.spec.unit), [target.unit, holder.unit, target.unit, target.unit, target.unit, holder.unit]);
  assert.match(target.unit, /^dhexbot-db-test-[0-9a-f-]{36}\.service$/);
  assert.notEqual(target.unit, holder.unit);
  assert.deepEqual(holder.wants, [target.unit]);
  assert.deepEqual(target.wants, []);
  assert.equal(target.executable, '/usr/bin/sleep');
  assert.deepEqual(target.args, ['60']);
  assert.equal(target.runtimeMaxSec, 180);
  assert.match(target.stdin, /^file:\/home\/dhexct528dec24\/\.dummy-db-[0-9a-f-]{36}\.sqlite$/);
  assert.equal(holder.stdin, 'null');
  const clone = calls.find(x => x.kind === 'clone');
  assert.notEqual(clone.source, clone.destination);
  assert.match(clone.destination, /^\/home\/dhexct528dec24\/\.dummy-db-clone-[0-9a-f-]{36}\.sqlite$/);
  assert.equal(calls.filter(x => x.kind === 'hash').length, 2);
  assert.equal(calls.filter(x => x.kind === 'census').length, 7);
  await assert.rejects(supervisor.provisionAndValidate(), unconfirmed);
});

test('rejects unsafe preflight, fixture, metadata and fd evidence', async t => {
  const cases = [
    ['preflight', r => { r.loginDisabled = false; }], ['preflight', r => { r.sudoGroups = true; }],
    ['preflight', r => { r.busOwnerOnly = false; }], ['preflight', r => { r.uid = 0; }],
    ['create-fixture', r => { r.symlink = true; }], ['create-fixture', r => { r.path = '/secret'; }],
    ['create-fixture', r => { r.sqlite = false; }], ['absent', r => { r.absent = false; }],
    ['inspect', r => { r.id = 'other.service'; }], ['inspect', r => { r.names += ' alias'; }],
    ['inspect', r => { r.transient = false; }], ['inspect', r => { r.executable = '/bin/sh'; }],
    ['inspect', r => { r.args = ['60', 'extra']; }], ['inspect', r => { r.stdinMode = 'null'; }],
    ['inspect', r => { r.runtimeMaxSec = 181; }], ['inspect', r => { r.uid = 0; }],
    ['inspect', r => { r.cgroup = '/other'; }], ['inspect', r => { r.wants = ['other.service']; }],
    ['inspect', r => { r.otherDependencies = ['other.service']; }], ['inspect', r => { r.pid = 0; }],
    ['fd0', r => { r.ino++; }], ['fd0', r => { r.dev++; }], ['fd0', r => { r.pid++; }],
    ['fd0', r => { r.synthetic = false; }],
  ];
  for (const [index, [kind, change]] of cases.entries()) await t.test(String(index), async () => {
    const item = setup((request, result) => { if (request.kind === kind) change(result); return result; });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    const count = item.calls.length;
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.length, count);
    if (kind === 'preflight' || kind === 'create-fixture' || kind === 'absent') assert.equal(item.calls.filter(x => x.action).length, 0);
    if (kind === 'inspect') assert.equal(item.calls.filter(x => x.action).length, 1);
  });
});

test('unconfirmed action and concurrent use permanently lock without another action or leaked errors', async () => {
  const item = setup((request, result) => {
    if (request.action) throw new Error('secret path and unit');
    return result;
  });
  await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  assert.equal(item.calls.filter(x => x.action).length, 1);

  let resolve;
  const calls = [];
  const supervisor = createDummyDbSupervisor({ evidence: () => new Promise(done => { resolve = done; }), runner: x => calls.push(x), census() {}, safeClone() {} });
  const pending = supervisor.provisionAndValidate();
  await Promise.resolve();
  await assert.rejects(supervisor.provisionAndValidate(), unconfirmed);
  resolve({ name: 'dhexct528dec24', uid: 999, gid: 983, loginDisabled: true, sudoGroups: false, busOwnerUid: 999, busOwnerOnly: true, synthetic: true });
  await assert.rejects(pending, unconfirmed);
  assert.equal(calls.length, 0);
});

test('requires explicit injected functions and rejects caller-provided paths or units', () => {
  for (const options of [undefined, {}, { evidence() {}, runner() {}, path: '/secret' },
    { evidence() {}, runner() {}, unit: 'other.service' },
    Object.defineProperty({ runner() {} }, 'evidence', { get() { throw Error('secret'); } })]) {
    assert.throws(() => createDummyDbSupervisor(options), unconfirmed);
  }
});

test('timed-out provisioning remains unconfirmed even if the action later completes', async () => {
  let resolve;
  const item = setup((request, result) => request.action
    ? new Promise(done => { resolve = () => done(result); }) : result);
  await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  assert.equal(item.calls.filter(x => x.action).length, 1);
  resolve();
  await Promise.resolve();
  await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  assert.equal(item.calls.filter(x => x.action).length, 1);
});

test('rejects conflicting or incomplete census at each lifecycle checkpoint', async t => {
  for (let checkpoint = 1; checkpoint <= 7; checkpoint++) await t.test(String(checkpoint), async () => {
    let count = 0;
    const item = setup((request, result) => {
      if (request.kind === 'census' && ++count === checkpoint) result.pids = [101, 202];
      return result;
    });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    const actions = item.calls.filter(x => x.action).length;
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.filter(x => x.action).length, actions);
    if (checkpoint <= 4) assert.equal(item.calls.some(x => x.kind === 'clone'), false);
    if (checkpoint <= 5) assert.equal(item.calls.some(x => x.action === 'start'), false);
  });
});

test('clone failure, alias or changed source hash prevents restart', async t => {
  for (const mode of ['reject', 'alias', 'destination', 'hash']) await t.test(mode, async () => {
    let hashes = 0;
    const item = setup((request, result) => {
      if (request.kind === 'clone' && mode === 'reject') throw Error('private clone error');
      if (request.kind === 'clone' && mode === 'alias') result.ino = 456;
      if (request.kind === 'clone' && mode === 'destination') result.destination = result.source;
      if (request.kind === 'hash' && ++hashes === 2 && mode === 'hash') result.sha256 = 'b'.repeat(64);
      return result;
    });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.some(x => x.action === 'start'), false);
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  });
});

test('unconfirmed restart never triggers another action', async () => {
  const item = setup((request, result) => {
    if (request.action === 'start') throw Error('private timeout details');
    return result;
  });
  await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  assert.deepEqual(item.calls.filter(x => x.action).map(x => x.action), ['provision', 'provision', 'stop', 'start']);
  await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
});

test('incomplete census and forged holder metadata fail closed', async () => {
  const incomplete = setup((request, result) => {
    if (request.kind === 'census') result.complete = false;
    return result;
  });
  await assert.rejects(incomplete.supervisor.provisionAndValidate(), unconfirmed);
  assert.equal(incomplete.calls.some(x => x.action), false);

  const forged = setup((request, result) => {
    if (request.kind === 'inspect' && result.wants.length) result.wants = [];
    return result;
  });
  await assert.rejects(forged.supervisor.provisionAndValidate(), unconfirmed);
  assert.deepEqual(forged.calls.filter(x => x.action).map(x => x.action), ['provision', 'provision']);
});

test('holder remains active through target stop, clone, restart and final zero census', async () => {
  let holderUnit;
  let holderActive = false;
  const item = setup((request, result) => {
    if (request.action === 'provision' && request.spec.wants.length) {
      holderUnit = request.spec.unit;
      holderActive = true;
    }
    if (request.action === 'stop' && request.spec.unit === holderUnit) holderActive = false;
    if (holderUnit && (request.kind === 'clone' || request.action === 'start' ||
        (request.kind === 'census' && !item.calls.some(x => x.action === 'stop' && x.spec.unit === holderUnit)))) {
      assert.equal(holderActive, true);
    }
    return result;
  });
  await item.supervisor.provisionAndValidate();
  const finalHolderStop = item.calls.findIndex(x => x.action === 'stop' && x.spec.unit === holderUnit);
  assert.equal(item.calls.slice(0, finalHolderStop).filter(x => x.kind === 'census').length, 7);
  assert.equal(item.calls.at(-1).kind, 'holderQuiescent');
});

test('holder GC is only accepted after confirmed holder stop with separate quiescence proof', async t => {
  const disappeared = setup((request, result) => {
    if (request.kind === 'holderQuiescent') return { unit: request.unit, cgroup: request.cgroup,
      found: false, capturedCgroupAbsent: true, job: false, synthetic: true };
    return result;
  });
  assert.equal((await disappeared.supervisor.provisionAndValidate()).status, 'synthetic-cycle-complete');

  for (const mode of ['missing', 'job', 'pid', 'cgroup', 'absent-cgroup', 'wrong-unit', 'stop-unconfirmed']) await t.test(mode, async () => {
    const item = setup((request, result) => {
      if (request.action === 'stop' && request.spec.wants.length && mode === 'stop-unconfirmed') result.confirmed = false;
      if (request.kind === 'holderQuiescent') {
        if (mode === 'missing') return undefined;
        if (mode === 'job') result.job = true;
        if (mode === 'pid') result.pid = 101;
        if (mode === 'cgroup') result.cgroupEmpty = false;
        if (mode === 'absent-cgroup') { result.found = false; result.capturedCgroupAbsent = false; }
        if (mode === 'wrong-unit') result.unit = 'private';
      }
      return result;
    });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    if (mode === 'stop-unconfirmed') assert.equal(item.calls.some(x => x.kind === 'holderQuiescent'), false);
    const count = item.calls.length;
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.length, count);
  });
});

test('early holder disappearance prevents further target actions', async () => {
  let holderUnit;
  let targetStopped = false;
  const item = setup((request, result) => {
    if (request.action === 'provision' && request.spec.wants.length) holderUnit = request.spec.unit;
    if (request.action === 'stop' && request.spec.unit !== holderUnit) targetStopped = true;
    if (request.kind === 'inspect' && request.unit === holderUnit && targetStopped) return undefined;
    return result;
  });
  await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  assert.deepEqual(item.calls.filter(x => x.action).map(x => x.action), ['provision', 'provision', 'stop']);
  assert.equal(item.calls.some(x => x.kind === 'clone'), false);
});

test('inactive target preserves actual ControlGroup and requires separately scoped empty or absent evidence', async t => {
  for (const actual of ['released', 'retained']) for (const state of ['empty', 'absent']) await t.test(`${actual}-${state}`, async () => {
    const item = setup((request, result) => {
      if (request.kind === 'inspect' && !result.active && actual === 'retained') {
        result.cgroup = `/user.slice/user-999.slice/user@999.service/app.slice/${request.unit}`;
      }
      if (request.kind === 'targetCgroupQuiescent') {
        assert.equal(request.actualControlGroup, actual === 'released' ? '' : request.recordedCgroup.path);
        assert.notEqual(request.recordedCgroup.path, '');
        assert.equal(request.recordedCgroup.pid, 101);
        assert.equal(request.recordedCgroup.generation, 77);
        result.state = state;
      }
      return result;
    });
    assert.equal((await item.supervisor.provisionAndValidate()).status, 'synthetic-cycle-complete');
    assert.equal(item.calls.filter(x => x.kind === 'targetCgroupQuiescent').length, 4);
  });
});

test('inactive target rejects missing, untrusted, nonempty or mismatched quiescence evidence', async t => {
  const cases = {
    missing: () => undefined,
    synthetic: r => { r.synthetic = false; },
    trust: r => { r.trusted = false; },
    unit: r => { r.unit = 'other'; },
    actual: r => { r.actualControlGroup = r.path; },
    path: r => { r.path = '/other'; },
    generation: r => { r.generation++; },
    scopedPid: r => { r.scopedPid++; },
    mainPid: r => { r.mainPid = 101; },
    job: r => { r.job = true; },
    populated: r => { r.state = 'populated'; },
    unknown: r => { r.state = 'unknown'; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const item = setup((request, result) => {
      if (request.kind === 'targetCgroupQuiescent') {
        const replacement = change(result);
        if (name === 'missing') return replacement;
      }
      return result;
    });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.some(x => x.kind === 'clone'), false);
    const count = item.calls.length;
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.length, count);
  });
});

test('target cgroup identity and inactive metadata fail closed on ambiguity', async t => {
  const cases = {
    inactiveUnknownPath: r => { r.cgroup = '/unknown'; },
    inactiveMissingPath: r => { delete r.cgroup; },
    inactivePid: r => { r.pid = 101; },
    inactiveJob: r => { r.job = true; },
    inactiveIdentity: r => { r.id = 'other'; },
    activeUntrusted: r => { r.cgroupTrusted = false; },
    activePidScope: r => { r.cgroupPid++; },
    activeGeneration: r => { r.cgroupGeneration = 0; },
    activeChangedPath: r => { r.cgroup = '/unknown'; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const item = setup((request, result) => {
      if (request.kind === 'inspect' && result.wants.length === 0 && result.active === name.startsWith('active')) change(result);
      return result;
    });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.some(x => x.kind === 'clone'), false);
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
  });
});

test('target PID and cgroup generation cannot change within an active epoch', async t => {
  for (const field of ['pid', 'generation']) await t.test(field, async () => {
    let inspections = 0;
    const item = setup((request, result) => {
      if (request.kind === 'inspect' && result.active && result.wants.length === 0 && ++inspections === 2) {
        if (field === 'pid') { result.pid++; result.cgroupPid++; }
        else result.cgroupGeneration++;
      }
      return result;
    });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.filter(x => x.action).length, 1);
  });
});

test('a confirmed restart records a new target cgroup generation for subsequent proof', async () => {
  let restarted = false;
  const generations = [];
  const item = setup((request, result) => {
    if (request.action === 'start') restarted = true;
    if (request.kind === 'inspect' && result.active && result.wants.length === 0 && restarted) result.cgroupGeneration = 78;
    if (request.kind === 'targetCgroupQuiescent') generations.push(request.recordedCgroup.generation);
    return result;
  });
  await item.supervisor.provisionAndValidate();
  assert.deepEqual(generations, [77, 77, 78, 78]);
});

test('stdin mode is inspected separately from internal provisioning path and fd observations', async () => {
  let active = false;
  let restarts = 0;
  let fdCount = 0;
  const item = setup((request, result) => {
    if (request.action === 'provision' && request.spec.wants.length === 0) active = true;
    if (request.action === 'stop' && request.spec.wants.length === 0) active = false;
    if (request.action === 'start') { active = true; restarts++; }
    if (request.kind === 'inspect') {
      assert.equal(Object.hasOwn(result, 'stdin'), false);
      assert.equal(Object.hasOwn(result, 'provisionedInputPath'), false);
    }
    if (request.kind === 'fd0') {
      assert.equal(active, true);
      assert.equal(request.generation, 77);
      fdCount++;
      if (restarts) assert.equal(fdCount, 3);
    }
    if (request.kind === 'targetCgroupQuiescent') assert.equal(active, false);
    return result;
  });
  await item.supervisor.provisionAndValidate();
  assert.equal(fdCount, 3);
  assert.equal(restarts, 1);
});

test('stdin mode, provenance confirmation and fd generation are required for each role and epoch', async t => {
  for (const mode of ['target-inactive', 'target-restart', 'holder', 'holder-alias', 'provision',
    'fd-unit', 'fd-generation', 'restart-fd-generation', 'restart-fd-inode']) await t.test(mode, async () => {
    let restarted = false;
    const item = setup((request, result) => {
      if (request.action === 'start') restarted = true;
      if (request.action === 'provision' && request.spec.wants.length === 0 && mode === 'provision') result.confirmed = false;
      if (request.kind === 'inspect') {
        if (mode === 'target-inactive' && !result.active) result.stdinMode = 'null';
        if (mode === 'target-restart' && restarted && result.wants.length === 0) result.stdinMode = 'null';
        if (mode === 'holder' && result.wants.length) result.stdinMode = 'file';
        if (mode === 'holder-alias' && result.wants.length) result.names += ' alias.service';
      }
      if (request.kind === 'fd0') {
        if (mode === 'fd-unit') result.unit = 'other';
        if (mode === 'fd-generation' || (mode === 'restart-fd-generation' && restarted)) result.generation++;
        if (mode === 'restart-fd-inode' && restarted) result.ino++;
      }
      return result;
    });
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    const actions = item.calls.filter(x => x.action);
    if (mode === 'provision') assert.equal(item.calls.some(x => x.kind === 'inspect'), false);
    if (mode.startsWith('restart-fd')) assert.equal(actions.at(-1).action, 'start');
    const count = item.calls.length;
    await assert.rejects(item.supervisor.provisionAndValidate(), unconfirmed);
    assert.equal(item.calls.length, count);
  });
});
