import { createDummySystemdInspector } from './dummy-systemd-supervisor.mjs';
import { createSystemdController } from './systemd-controller.mjs';

const program = '/usr/sbin/runuser';
const prefix = ['-u', 'dhexct528dec24', '--', '/usr/bin/env',
  'XDG_RUNTIME_DIR=/run/user/999', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus',
  '/usr/bin/systemctl', '--user'];
const metadata = ['Id', 'Names', 'Transient', 'ExecStart', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf'];
const state = ['Id', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'Job', 'InvocationID', 'Result'];
const failure = () => Object.assign(new Error('Dummy operation unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

export function createDummySystemdController(options) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => !['runner', 'monitor', 'isolation', 'timeoutMs', 'intervalMs'].includes(key)) ||
      typeof options.runner !== 'function' || typeof options.monitor !== 'function' || typeof options.isolation !== 'function') throw failure();
  const { runner, monitor, isolation, timeoutMs = 10000, intervalMs = 100 } = options;
  let blocked = false;
  let busy = false;
  let provisioned = false;
  const inspector = createDummySystemdInspector({ dryRun: true, runner: async (file, args) => {
    if (file !== program || ![unit, holder.unit].some(name => same(args, [...prefix, 'show', ...metadata.map(p => `--property=${p}`), '--', name]))) throw failure();
    const result = await runner(program, [...args]);
    if (!result || result.code !== 0) throw failure();
    return result.stdout;
  } });
  const { target, holder } = inspector.createPair();
  const { unit } = target;
  const check = signal => { if (blocked || signal?.aborted) throw failure(); };
  const checkIsolation = async signal => {
    check(signal);
    const snapshot = await isolation();
    check(signal);
    if (!plain(snapshot) || snapshot.synthetic !== true || snapshot.lockedNologin !== true ||
        snapshot.ownerOnlyBus !== true || snapshot.supervisorOwned !== true || snapshot.noAdversarialActors !== true) throw failure();
  };
  const inspect = async (entry, signal) => {
    await checkIsolation(signal);
    const result = await inspector.inspect(entry.capability);
    check(signal);
    if (result.status !== 'metadata-matched' || result.unit !== entry.unit) throw failure();
  };
  const inspectPair = async signal => { await inspect(holder, signal); await inspect(target, signal); };
  let controller;
  try {
    controller = createSystemdController({ unit, allowedUnit: unit,
      unitPattern: /^dhexbot-cutover-test-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.service$/,
      timeoutMs, intervalMs,
      monitor: async ({ signal }) => {
        check(signal);
        const evidence = await monitor();
        check(signal);
        if (!plain(evidence) || evidence.synthetic !== true) throw failure();
        return evidence;
      },
      runner: async (args, { signal }) => {
        check(signal);
        const show = ['--user', 'show', ...state.map(p => `--property=${p}`), '--', unit];
        const start = ['--user', 'start', '--', unit];
        const stop = ['--user', 'stop', '--', unit];
        if (!same(args, show) && !same(args, start) && !same(args, stop)) throw failure();
        const action = same(args, start) || same(args, stop);
        if (action) await inspectPair(signal);
        check(signal);
        const result = await runner(program, [...prefix, ...args.slice(1)]);
        check(signal);
        if (!result || result.code !== 0) throw failure();
        if (action) await inspectPair(signal);
        return result;
      },
    });
  } catch { throw failure(); }
  const action = async (verb, args) => {
    if (blocked || busy || !provisioned || args.length !== 0) { blocked = true; throw failure(); }
    busy = true;
    try {
      await controller[verb]();
      check();
      return Object.freeze({ role: 'dummy', evidence: 'synthetic', status: 'confirmed-in-mock' });
    } catch {
      blocked = true;
      throw failure();
    } finally { busy = false; }
  };
  const provision = async (...args) => {
    if (blocked || busy || provisioned || args.length !== 0) { blocked = true; throw failure(); }
    busy = true;
    const aborter = new AbortController();
    let timer;
    const work = async () => {
      for (const entry of [target, holder]) {
        await checkIsolation(aborter.signal);
        const result = await runner(program, [...prefix, 'show', '--property=LoadState', '--', entry.unit]);
        check(aborter.signal);
        if (!result || result.code !== 0 || !/^LoadState=not-found\n?$/.test(result.stdout)) throw failure();
      }
      for (const entry of [target, holder]) {
        await checkIsolation(aborter.signal);
        const args = [...prefix.slice(0, 6), '/usr/bin/systemd-run', '--user', `--unit=${entry.unit}`,
          '--property=RuntimeMaxSec=180', ...(entry === holder ? [`--property=Wants=${unit}`] : []), '/usr/bin/sleep', '180'];
        const result = await runner(program, args);
        check(aborter.signal);
        if (!result || result.code !== 0) throw failure();
        await inspect(entry, aborter.signal);
      }
      await inspectPair(aborter.signal);
      check(aborter.signal);
      provisioned = true;
    };
    try {
      await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => { aborter.abort(); reject(failure()); }, timeoutMs);
      })]);
      check(aborter.signal);
      return Object.freeze({ role: 'dummy', evidence: 'synthetic', status: 'provisioned-in-mock' });
    } catch {
      blocked = true;
      aborter.abort();
      throw failure();
    } finally { clearTimeout(timer); busy = false; }
  };
  return Object.freeze({ role: 'dummy', evidence: 'synthetic',
    provision, start: (...args) => action('start', args), stop: (...args) => action('stop', args) });
}
