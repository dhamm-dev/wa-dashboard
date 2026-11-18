import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { inspectPreview, plan, simulatePreview } from '../tools/manual-preview-supervisor.mjs';

test('dry run models clone-only safe boot and ordered preview configuration', async () => {
  const { result, calls, state } = await simulatePreview();
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['preflight', 'stopOld', 'clone', 'validate', 'startSafe', 'stopSafe', 'installPreview', 'startPreview', 'health']);
  assert.deepEqual(state.clone, { parent: plan.cloneParent, unique: true, mode: 0o700, data: 'clone' });
  assert.deepEqual(state.safe, { data: 'clone', host: '127.0.0.1', port: 'distinct-loopback', safeBoot: '1', private: '1', whatsapp: false });
  assert.deepEqual(state.dropin, { server: plan.previewServer, envFiles: [plan.originalEnv, plan.previewEnv], data: 'clone', port: 3000, private: '1', signup: '0', unset: ['DHEXBOT_SAFE_BOOT'] });
  assert.equal(state.sourceWrites, 0);
});

for (const key of ['permission', 'exactMetadata', 'noDropins', 'rootCensus', 'noOtherKnownWriters']) {
  test(`preflight rejects missing ${key}`, async () => {
    const { result, calls, state } = await simulatePreview({ evidence: { [key]: false } });
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(calls, ['preflight']);
    assert.equal(state.running, 'old');
  });
}

test('scheduler is rechecked immediately before stop and blocks clone', async () => {
  const { result, calls, state } = await simulatePreview({ evidence: { schedulerClear: false } });
  assert.equal(result.status, 'unconfirmed');
  assert.deepEqual(calls, ['preflight', 'stopOld']);
  assert.equal(state.running, 'old');
});

for (const key of ['sourceQuiescent', 'cloneVerified', 'safeHealth', 'previewHealthy', 'privateSignupDisabled', 'httpsLink']) {
  test(`${key} failure preserves source and recovers the original data reference`, async () => {
    const { result, state } = await simulatePreview({ evidence: { [key]: false } });
    assert.equal(result.status, 'rolled-back');
    assert.equal(state.running, 'old');
    assert.equal(state.sourceWrites, 0);
    if (state.dropin) assert.deepEqual(state.dropin, { server: plan.oldServer, envFiles: [plan.originalEnv], data: 'original' });
  });
}

test('preview health failure stops preview before restoring both original references', async () => {
  const { result, calls, state } = await simulatePreview({ failAt: 'health' });
  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(calls.slice(-3), ['stopPreview', 'restoreOld', 'startOld']);
  assert.equal(state.dropin.server, plan.oldServer);
  assert.equal(state.dropin.data, 'original');
  assert.ok(state.clone);
  assert.equal(state.sourceWrites, 0);
});

for (const operation of ['stopOld', 'clone', 'startSafe', 'stopSafe', 'installPreview', 'startPreview', 'health']) {
  test(`uncertain ${operation} does not issue another start`, async () => {
    const { result, calls } = await simulatePreview({ uncertainAt: operation });
    assert.equal(result.status, 'unconfirmed');
    assert.equal(calls.at(-1), operation);
    assert.ok(!calls.includes('startOld'));
  });
}

test('timeout returns unconfirmed without a second start', async () => {
  const { result, calls } = await simulatePreview({ timeoutAt: 'startPreview', timeoutMs: 10 });
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.error, 'OPERATION_TIMEOUT');
  assert.equal(calls.at(-1), 'startPreview');
});

test('CLI refuses execution and emits enum-only dry-run output', () => {
  const script = new URL('../tools/manual-preview-supervisor.mjs', import.meta.url);
  for (const args of [[], ['--execute'], ['--dry-run', 'secret']]) {
    const run = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, 'DRY_RUN_OR_INSPECT_REQUIRED\n');
  }
  const run = spawnSync(process.execPath, [script.pathname, '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /SIMULATED_COMPLETED\n$/);
  assert.match(run.stdout, /^(?:[A-Z_]+\n)+$/);
  assert.equal(run.stderr, '');
});

test('read-only inspection cannot run without an exclusive gate', async () => {
  let inspected = false;
  const result = await inspectPreview({ getUid: () => 0, checkGate: async () => false,
    inspect: async () => { inspected = true; return { ok: true }; } });
  assert.deepEqual(result, { status: 'lock-not-held' });
  assert.equal(inspected, false);
});

test('read-only inspection returns only validated check names and booleans', async () => {
  const checks = Object.fromEntries(['root', 'service', 'data', 'preview', 'release', 'apk', 'schedules', 'dataWriters', 'stable'].map(name => [name, true]));
  const options = { getUid: () => 0, checkGate: async () => true,
    inspect: async () => ({ ok: true, checks: { ...checks, secret: 'not returned' } }) };
  assert.deepEqual(await inspectPreview(options), { status: 'ready-for-review', checks });
  assert.deepEqual(await inspectPreview({ ...options, inspect: async () => { throw new Error('sensitive'); } }), { status: 'unconfirmed' });
  assert.deepEqual(await inspectPreview({ ...options, inspect: async () => ({ ok: true, checks: { ...checks, stable: 'yes' } }) }), { status: 'unconfirmed' });
});
