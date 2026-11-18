import { fileURLToPath } from 'node:url';
import { runCutover } from './cutover-machine.mjs';
import { holdsExclusiveFlock } from './flock-proof.mjs';
import { inspectProduction } from './production-preflight.mjs';

export const plan = Object.freeze({
  unit: 'wa-dashboard.service',
  oldServer: '/home/dhexweb/wa-dashboard/src/server.js',
  originalData: '/home/dhexweb/wa-dashboard/data',
  originalEnv: '/home/dhexweb/wa-dashboard/.env',
  previewServer: '/home/dhexweb/dhexbot-preview-release-37ec9a3cc5828208/app/src/server.js',
  previewEnv: '/home/dhexweb/dhexbot-preview-release-05aee121be1701ab/config/preview.env',
  cloneParent: '/home/dhexweb/dhexbot-preview-release-37ec9a3cc5828208',
  productionPort: 3000,
  cloneMode: 0o700,
});

const failed = () => new Error('SIMULATED_FAILURE');
const unconfirmed = () => Object.assign(failed(), { code: 'OPERATION_UNCONFIRMED' });
const requireTrue = value => { if (value !== true) throw failed(); };

export async function inspectPreview({ getUid = process.geteuid, checkGate = holdsExclusiveFlock, inspect = inspectProduction } = {}) {
  try {
    if (typeof getUid !== 'function' || getUid() !== 0 || typeof checkGate !== 'function' ||
        await checkGate('/run/lock/dhexbot-preview-cutover.lock') !== true) return { status: 'lock-not-held' };
    const result = await inspect();
    const names = ['root', 'service', 'data', 'preview', 'release', 'apk', 'schedules', 'dataWriters', 'stable'];
    if (!result || typeof result.ok !== 'boolean' || !result.checks ||
        names.some(name => typeof result.checks[name] !== 'boolean')) return { status: 'unconfirmed' };
    return { status: result.ok && names.every(name => result.checks[name]) ? 'ready-for-review' : 'blocked',
      checks: Object.fromEntries(names.map(name => [name, result.checks[name]])) };
  } catch {
    return { status: 'unconfirmed' };
  }
}

export async function simulatePreview({ evidence = {}, failAt, uncertainAt, timeoutAt, timeoutMs = 30 } = {}) {
  const snapshot = {
    unit: plan.unit, permission: true, exactMetadata: true, noDropins: true,
    rootCensus: true, noOtherKnownWriters: true, schedulerClear: true,
    sourceQuiescent: true, cloneVerified: true, safeHealth: true,
    previewHealthy: true, privateSignupDisabled: true, httpsLink: true,
    ...evidence,
  };
  const calls = [];
  const state = { running: 'old', dropin: null, clone: null, safe: null, sourceWrites: 0 };
  const step = (name, fn) => async ({ signal }) => {
    calls.push(name);
    if (name === timeoutAt) return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    if (name === uncertainAt) throw unconfirmed();
    if (name === failAt) throw failed();
    await fn();
  };
  const noRunning = () => requireTrue(state.running === null);
  const operations = {
    preflight: step('preflight', () => {
      requireTrue(snapshot.unit === plan.unit);
      for (const key of ['permission', 'exactMetadata', 'noDropins', 'rootCensus', 'noOtherKnownWriters']) requireTrue(snapshot[key]);
    }),
    stopOld: step('stopOld', () => {
      requireTrue(snapshot.schedulerClear);
      requireTrue(state.running === 'old');
      state.running = null;
    }),
    clone: step('clone', () => {
      noRunning();
      requireTrue(snapshot.sourceQuiescent);
      state.clone = { parent: plan.cloneParent, unique: true, mode: plan.cloneMode, data: 'clone' };
    }),
    validate: step('validate', () => { noRunning(); requireTrue(snapshot.cloneVerified && state.clone !== null); }),
    startSafe: step('startSafe', () => {
      noRunning();
      state.safe = { data: 'clone', host: '127.0.0.1', port: 'distinct-loopback', safeBoot: '1', private: '1', whatsapp: false };
      state.running = 'safe';
      requireTrue(snapshot.safeHealth);
    }),
    stopSafe: step('stopSafe', () => { requireTrue(state.running === 'safe' || state.running === null); state.running = null; }),
    installPreview: step('installPreview', () => {
      noRunning();
      requireTrue(snapshot.noDropins && state.dropin === null);
      state.dropin = { server: plan.previewServer, envFiles: [plan.originalEnv, plan.previewEnv],
        data: 'clone', port: plan.productionPort, private: '1', signup: '0', unset: ['DHEXBOT_SAFE_BOOT'] };
    }),
    startPreview: step('startPreview', () => {
      noRunning();
      requireTrue(state.dropin?.server === plan.previewServer && state.dropin.data === 'clone');
      state.running = 'preview';
    }),
    health: step('health', () => {
      for (const key of ['previewHealthy', 'privateSignupDisabled', 'httpsLink']) requireTrue(snapshot[key]);
    }),
    stopPreview: step('stopPreview', () => {
      requireTrue(state.running === 'preview' || state.running === null);
      state.running = null;
    }),
    restoreOld: step('restoreOld', () => {
      noRunning();
      state.dropin = { server: plan.oldServer, envFiles: [plan.originalEnv], data: 'original' };
    }),
    startOld: step('startOld', () => {
      noRunning();
      requireTrue(state.dropin === null || (state.dropin.server === plan.oldServer && state.dropin.data === 'original'));
      state.running = 'old';
    }),
  };
  const result = await runCutover(operations, { timeoutMs });
  return { result, calls, state };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !['--dry-run', '--inspect'].includes(process.argv[2])) {
    process.stdout.write('DRY_RUN_OR_INSPECT_REQUIRED\n');
    process.exitCode = 2;
  } else if (process.argv[2] === '--inspect') {
    const result = await inspectPreview();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'ready-for-review') process.exitCode = 1;
  } else {
    const { result } = await simulatePreview();
    for (const entry of result.history) process.stdout.write(`${entry.operation.toUpperCase()}_${entry.status.toUpperCase()}\n`);
    process.stdout.write(`SIMULATED_${result.status.toUpperCase().replaceAll('-', '_')}\n`);
  }
}
