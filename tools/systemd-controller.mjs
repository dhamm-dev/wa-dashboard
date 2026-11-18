import { spawn } from 'node:child_process';
import { isHealthyPreview, isQuiescent } from './service-state.mjs';

const unconfirmed = () => Object.assign(new Error('Service operation unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });
const properties = ['Id', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'Job', 'InvocationID', 'Result'];
const identity = value => typeof value === 'string' && value.length > 0 && value.trim() === value;

function runSystemctl(args, { signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(unconfirmed());
    const child = spawn('systemctl', args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 65536) child.kill('SIGKILL');
    });
    child.on('error', () => reject(unconfirmed()));
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (code !== 0 || signal.aborted || output.length > 65536) reject(unconfirmed());
      else resolve({ code, stdout: output });
    });
  });
}

function parseShow(output, unit) {
  if (typeof output !== 'string' || output.length > 65536) throw unconfirmed();
  const values = Object.create(null);
  for (const line of output.split('\n')) {
    if (!line) continue;
    const pos = line.indexOf('=');
    const key = line.slice(0, pos);
    if (pos < 1 || !properties.includes(key) || Object.hasOwn(values, key)) throw unconfirmed();
    values[key] = line.slice(pos + 1);
  }
  if (properties.some(key => !Object.hasOwn(values, key) ||
      (key !== 'Job' && key !== 'InvocationID' && !identity(values[key]))) ||
      (values.InvocationID !== '' && !identity(values.InvocationID)) ||
      values.Id !== unit || /^0+$/.test(values.InvocationID) || values.ActiveState === 'failed' || values.Result !== 'success' ||
      !/^\d+$/.test(values.MainPID) || !/^\d+$/.test(values.ControlPID)) throw unconfirmed();
  const mainPID = Number(values.MainPID), controlPID = Number(values.ControlPID);
  if (!Number.isSafeInteger(mainPID) || !Number.isSafeInteger(controlPID)) throw unconfirmed();
  return { unitId: values.Id, activeState: values.ActiveState, subState: values.SubState,
    mainPID, controlPID, job: values.Job === '' || values.Job === '0' ? null : values.Job, invocationId: values.InvocationID };
}

export function createSystemdController({ unit, allowedUnit, unitPattern, runner = runSystemctl, monitor,
  timeoutMs = 10000, intervalMs = 100 } = {}) {
  if (typeof unit !== 'string' || unit !== allowedUnit || !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/.test(unit) ||
      !(unitPattern instanceof RegExp) || unitPattern.global || unitPattern.sticky ||
      !unitPattern.source.startsWith('^') || !unitPattern.source.endsWith('$') || !unitPattern.test(unit) ||
      typeof runner !== 'function' || typeof monitor !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > timeoutMs) {
    throw new TypeError('Invalid controller configuration');
  }
  let blocked = false;
  let busy = false;

  async function action(verb, { signal } = {}) {
    if (blocked || busy) throw unconfirmed();
    busy = true;
    const aborter = new AbortController();
    let timer;
    let onAbort;
    const check = () => { if (aborter.signal.aborted) throw unconfirmed(); };
    const command = async args => {
      check();
      const result = await runner(args, { signal: aborter.signal });
      check();
      if (!result || result.code !== 0) throw unconfirmed();
      return result.stdout;
    };
    const observe = async () => {
      const show = parseShow(await command(['--user', 'show', ...properties.map(p => `--property=${p}`), '--', unit]), unit);
      const evidence = await monitor({ unit, signal: aborter.signal });
      check();
      return { ...evidence, writerCensusComplete: evidence?.writerCensusComplete === true, ...show };
    };
    const work = async () => {
      const before = await observe();
      if (!identity(before.bootId) || !identity(before.managerId) || !identity(before.generation) ||
          before.job !== null || before.gateHeld !== true || !identity(before.gateId) ||
          (verb === 'stop' && !identity(before.invocationId))) throw unconfirmed();
      await command(['--user', verb, '--', unit]);
      let previous;
      while (true) {
        const current = { ...await observe(), ...(verb === 'stop' ? { priorInvocationId: before.invocationId } : {}) };
        if (['bootId', 'managerId', 'generation', 'gateId'].some(key => current[key] !== before[key]) ||
            current.gateHeld !== true) throw unconfirmed();
        const valid = verb === 'stop' ? isQuiescent : isHealthyPreview;
        if (previous && valid(previous, current) && (verb === 'stop' ||
            [previous, current].every(item => item.cgroupCollectorTrusted === true && item.cgroupState === 'populated'))) return;
        previous = current;
        await new Promise((resolve, reject) => {
          const done = () => { aborter.signal.removeEventListener('abort', cancel); resolve(); };
          const id = setTimeout(done, intervalMs);
          const cancel = () => { clearTimeout(id); reject(unconfirmed()); };
          aborter.signal.addEventListener('abort', cancel, { once: true });
          if (aborter.signal.aborted) cancel();
        });
        check();
      }
    };
    try {
      const interrupted = new Promise((_, reject) => {
        onAbort = () => { aborter.abort(); reject(unconfirmed()); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(onAbort, timeoutMs);
      });
      await Promise.race([work(), interrupted]);
    } catch {
      blocked = true;
      aborter.abort();
      throw unconfirmed();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      busy = false;
    }
  }
  return { start: options => action('start', options), stop: options => action('stop', options) };
}
