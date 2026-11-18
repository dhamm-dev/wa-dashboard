import { randomUUID } from 'node:crypto';

const fail = () => Object.assign(new Error('Dummy DB operation unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });
const TIMEOUT = 3000;
const account = Object.freeze({ name: 'dhexct528dec24', uid: 999, gid: 983 });
const fixed = Object.freeze({ executable: '/usr/bin/sleep', args: Object.freeze(['60']), runtimeMaxSec: 180 });

// This module has no real runner or filesystem implementation. All evidence is simulated.
export function createDummyDbSupervisor(options) {
  try {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
        Reflect.ownKeys(options).sort().join(',') !== 'census,evidence,runner,safeClone' ||
        Reflect.ownKeys(options).some(k => !Object.hasOwn(Object.getOwnPropertyDescriptor(options, k), 'value')) ||
        ['evidence', 'runner', 'census', 'safeClone'].some(key => typeof options[key] !== 'function')) throw fail();
  } catch { throw fail(); }
  const { evidence, runner, census, safeClone } = options;
  let state = 'new';

  async function invoke(fn, request) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn(request)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), TIMEOUT); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  return Object.freeze({
    async provisionAndValidate() {
      if (state !== 'new') { state = 'failed'; throw fail(); }
      state = 'busy';
      const checkState = () => { if (state !== 'busy') throw fail(); };
      const ask = async (fn, request) => { const result = await invoke(fn, request); checkState(); return result; };
      try {
        const preflight = await ask(evidence, Object.freeze({ kind: 'preflight', account, synthetic: true }));
        if (preflight?.name !== account.name || preflight.uid !== 999 || preflight.gid !== 983 ||
            preflight.loginDisabled !== true || preflight.sudoGroups !== false ||
            preflight.busOwnerUid !== 999 || preflight.busOwnerOnly !== true || preflight.synthetic !== true) throw fail();

        const target = `dhexbot-db-test-${randomUUID()}.service`;
        const holder = `dhexbot-db-test-${randomUUID()}.service`;
        if (target === holder) throw fail();
        const path = `/home/dhexct528dec24/.dummy-db-${randomUUID()}.sqlite`;
        const fixture = await ask(evidence, Object.freeze({ kind: 'create-fixture', path, account, synthetic: true }));
        if (fixture?.synthetic !== true || fixture.path !== path || fixture.uid !== 999 || fixture.gid !== 983 ||
            fixture.mode !== 0o600 || fixture.regular !== true || fixture.symlink !== false ||
            fixture.sqlite !== true || !Number.isSafeInteger(fixture.dev) || fixture.dev < 0 ||
            !Number.isSafeInteger(fixture.ino) || fixture.ino <= 0) throw fail();
        const identity = Object.freeze({ dev: fixture.dev, ino: fixture.ino });
        const spec = (unit, wants, stdin) => Object.freeze({ unit, account, ...fixed,
          wants: Object.freeze(wants), stdin, synthetic: true });
        const targetSpec = spec(target, [], `file:${path}`);
        const holderSpec = spec(holder, [target], 'null');
        let targetCgroup;
        let newTargetEpoch = true;
        let provenance;
        let observedFd;
        const inspect = async (expected, active) => {
          const result = await ask(evidence, Object.freeze({ kind: 'inspect', unit: expected.unit, synthetic: true }));
          if (result?.synthetic !== true || result.id !== expected.unit || result.names !== expected.unit ||
              result.transient !== true || result.executable !== fixed.executable ||
              !Array.isArray(result.args) || result.args.length !== 1 || result.args[0] !== '60' ||
              result.runtimeMaxSec !== 180 || result.stdinMode !== (expected === targetSpec ? 'file' : 'null') || result.uid !== 999 ||
              result.gid !== 983 ||
              !Array.isArray(result.wants) || result.wants.length !== expected.wants.length ||
              result.wants.some((value, index) => value !== expected.wants[index]) ||
              !Array.isArray(result.otherDependencies) || result.otherDependencies.length !== 0 ||
              result.active !== active || !Number.isSafeInteger(result.pid) || (active ? result.pid <= 0 : result.pid !== 0)) throw fail();
          const expectedCgroup = `/user.slice/user-999.slice/user@999.service/app.slice/${expected.unit}`;
          if (expected === holderSpec) {
            if (!active || result.cgroup !== expectedCgroup) throw fail();
          } else if (active) {
            if (!provenance || provenance.provisionedInputPath !== path || provenance.identity !== identity ||
                result.cgroup !== expectedCgroup || result.cgroupTrusted !== true || result.cgroupPid !== result.pid ||
                !Number.isSafeInteger(result.cgroupGeneration) || result.cgroupGeneration <= 0) throw fail();
            if (!newTargetEpoch && (!targetCgroup || targetCgroup.path !== result.cgroup ||
                targetCgroup.pid !== result.pid || targetCgroup.generation !== result.cgroupGeneration)) throw fail();
            targetCgroup = Object.freeze({ path: result.cgroup, pid: result.pid, generation: result.cgroupGeneration });
            newTargetEpoch = false;
          } else {
            if (!provenance || provenance.provisionedInputPath !== path || provenance.identity !== identity || !targetCgroup || newTargetEpoch ||
                !observedFd || observedFd.pid !== targetCgroup.pid || observedFd.generation !== targetCgroup.generation || result.job !== false ||
                (result.cgroup !== '' && result.cgroup !== targetCgroup.path)) throw fail();
            const quiet = await ask(evidence, Object.freeze({ kind: 'targetCgroupQuiescent', unit: expected.unit,
              actualControlGroup: result.cgroup, recordedCgroup: targetCgroup, synthetic: true }));
            if (quiet?.synthetic !== true || quiet.trusted !== true || quiet.unit !== expected.unit ||
                quiet.actualControlGroup !== result.cgroup || quiet.path !== targetCgroup.path ||
                quiet.generation !== targetCgroup.generation || quiet.scopedPid !== targetCgroup.pid ||
                quiet.mainPid !== 0 || quiet.job !== false || !['empty', 'absent'].includes(quiet.state)) throw fail();
          }
          return result.pid;
        };
        const absent = async unit => {
          const result = await ask(evidence, Object.freeze({ kind: 'absent', unit, synthetic: true }));
          if (result?.synthetic !== true || result.unit !== unit || result.absent !== true) throw fail();
        };
        const action = async (action, expected) => {
          if (action === 'stop' && expected === targetSpec && (!targetCgroup || newTargetEpoch ||
              !observedFd || observedFd.pid !== targetCgroup.pid || observedFd.generation !== targetCgroup.generation)) throw fail();
          const result = await ask(runner, Object.freeze({ action, spec: expected, synthetic: true }));
          if (result?.synthetic !== true || result.confirmed !== true || result.action !== action || result.unit !== expected.unit) throw fail();
          if (action === 'provision' && expected === targetSpec) provenance = Object.freeze({ provisionedInputPath: path, identity });
          if (action === 'start' && expected === targetSpec) { newTargetEpoch = true; observedFd = undefined; }
        };
        const writers = async expected => {
          const result = await ask(census, Object.freeze({ path, identity, synthetic: true }));
          if (result?.synthetic !== true || result.path !== path || result.dev !== identity.dev ||
              result.ino !== identity.ino || result.complete !== true || !Array.isArray(result.pids) ||
              result.pids.length !== expected.length || result.pids.some((pid, i) => pid !== expected[i])) throw fail();
        };
        const verifyFd = async pid => {
          if (!provenance || provenance.provisionedInputPath !== path || provenance.identity !== identity || !targetCgroup ||
              newTargetEpoch || targetCgroup.pid !== pid) throw fail();
          const fd = await ask(evidence, Object.freeze({ kind: 'fd0', pid, unit: target,
            generation: targetCgroup.generation, synthetic: true }));
          if (fd?.synthetic !== true || fd.unit !== target || fd.pid !== pid || fd.generation !== targetCgroup.generation ||
              fd.uid !== 999 || fd.dev !== identity.dev || fd.ino !== identity.ino) throw fail();
          observedFd = Object.freeze({ pid, generation: targetCgroup.generation });
        };
        const sourceHash = async () => {
          const hash = await ask(evidence, Object.freeze({ kind: 'hash', path, identity, synthetic: true }));
          if (hash?.synthetic !== true || hash.path !== path || hash.dev !== identity.dev || hash.ino !== identity.ino ||
              typeof hash.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(hash.sha256)) throw fail();
          return hash.sha256;
        };

        await absent(target);
        await absent(holder);
        await writers([]);
        await action('provision', targetSpec);
        let pid = await inspect(targetSpec, true);
        await verifyFd(pid);
        await writers([pid]);
        await absent(holder);
        await inspect(targetSpec, true);
        await action('provision', holderSpec);
        pid = await inspect(targetSpec, true);
        await inspect(holderSpec, true);
        await verifyFd(pid);
        await writers([pid]);
        await inspect(targetSpec, true);
        await inspect(holderSpec, true);
        await action('stop', targetSpec);
        await inspect(targetSpec, false);
        await inspect(holderSpec, true);
        await writers([]);
        const before = await sourceHash();
        const clonePath = `/home/dhexct528dec24/.dummy-db-clone-${randomUUID()}.sqlite`;
        if (clonePath === path) throw fail();
        const clone = await ask(safeClone, Object.freeze({ source: path, destination: clonePath, identity, synthetic: true }));
        if (clone?.synthetic !== true || clone.source !== path || clone.destination !== clonePath ||
            clone.confirmed !== true || clone.dev === identity.dev && clone.ino === identity.ino ||
            !Number.isSafeInteger(clone.dev) || clone.dev < 0 || !Number.isSafeInteger(clone.ino) || clone.ino <= 0) throw fail();
        if (await sourceHash() !== before) throw fail();
        await inspect(holderSpec, true);
        await inspect(targetSpec, false);
        await writers([]);
        await action('start', targetSpec);
        pid = await inspect(targetSpec, true);
        await inspect(holderSpec, true);
        await verifyFd(pid);
        await writers([pid]);
        await inspect(holderSpec, true);
        await inspect(targetSpec, true);
        await action('stop', targetSpec);
        await inspect(targetSpec, false);
        await inspect(holderSpec, true);
        await writers([]);
        await inspect(targetSpec, false);
        await inspect(holderSpec, true);
        await action('stop', holderSpec);
        const quiet = await ask(evidence, Object.freeze({ kind: 'holderQuiescent', unit: holder,
          cgroup: `/user.slice/user-999.slice/user@999.service/app.slice/${holder}`, synthetic: true }));
        if (quiet?.synthetic !== true || quiet.unit !== holder ||
            quiet.cgroup !== `/user.slice/user-999.slice/user@999.service/app.slice/${holder}` || quiet.job !== false ||
            !((quiet.found === true && quiet.pid === 0 && quiet.cgroupEmpty === true) ||
              (quiet.found === false && quiet.capturedCgroupAbsent === true))) throw fail();
        checkState();
        state = 'done';
        return Object.freeze({ status: 'synthetic-cycle-complete' });
      } catch {
        state = 'failed';
        throw fail();
      }
    },
  });
}
