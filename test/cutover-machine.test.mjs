import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runCutover } from '../tools/cutover-machine.mjs';

const names = ['preflight', 'stopOld', 'clone', 'validate', 'startSafe', 'stopSafe',
  'installPreview', 'startPreview', 'health', 'stopPreview', 'restoreOld', 'startOld'];

function fake(fail = []) {
  const calls = [];
  const running = new Set(['old']);
  let refs = 'old';
  let database = 'original';
  let cloned = false;
  const violations = [];
  const operations = Object.fromEntries(names.map((name) => [name, async () => {
    calls.push(name);
    if (fail.includes(name)) throw new Error(`failed ${name}`);
    if (name.startsWith('start')) {
      if (running.size) violations.push(`overlapping start: ${name}`);
      if (name !== 'startOld' && database !== 'clone') violations.push(`original database: ${name}`);
      running.add(name.slice(5).toLowerCase());
    }
    if (name.startsWith('stop')) running.delete(name.slice(4).toLowerCase());
    if (name === 'clone') cloned = true;
    if (name === 'validate') {
      if (!cloned) violations.push('validation without clone');
      database = 'clone';
    }
    if (name === 'installPreview') refs = 'preview';
    if (name === 'restoreOld') { refs = 'old'; database = 'original'; }
    if (name === 'startOld') assert.equal(refs, 'old');
  }]));
  return { operations, calls, running, violations };
}

test('successful simulation runs the ordered phases', async () => {
  const f = fake();
  const result = await runCutover(f.operations);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.state, { old: 'stopped', safe: 'stopped', preview: 'active', refs: 'preview' });
  assert.deepEqual(f.calls, names.slice(0, 9));
  assert.deepEqual(f.violations, []);
});

for (const name of names.slice(0, 9)) {
  test(`failure at ${name} is reported and safely handled`, async () => {
    const f = fake([name]);
    const result = await runCutover(f.operations);
    assert.deepEqual(f.violations, []);
    assert.equal(result.error, 'OPERATION_FAILED');
    if (name === 'preflight') assert.equal(result.status, 'unchanged');
    else if (name === 'stopOld' || name === 'stopSafe') {
      assert.equal(result.status, 'unconfirmed');
      assert.ok(!f.calls.includes('startOld'));
    } else {
      assert.equal(result.status, 'rolled-back');
      assert.deepEqual(result.state, { old: 'active', safe: 'stopped', preview: 'stopped', refs: 'old' });
      assert.deepEqual([...f.running], ['old']);
    }
  });
}

for (const [failure, rollback] of [['health', 'stopPreview'], ['startSafe', 'stopSafe'],
  ['health', 'restoreOld'], ['health', 'startOld']]) {
  test(`rollback failure at ${rollback} is never reported as success`, async () => {
    const f = fake([failure, rollback]);
    const result = await runCutover(f.operations);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.rollbackError, 'OPERATION_FAILED');
    if (rollback !== 'startOld') assert.ok(!f.calls.includes('startOld'));
  });
}

for (const name of ['startSafe', 'installPreview', 'startPreview']) {
  test(`${name} may take effect before rejecting`, async () => {
    const f = fake();
    const operation = f.operations[name];
    f.operations[name] = async (context) => {
      await operation(context);
      throw new Error('lost acknowledgement');
    };
    const result = await runCutover(f.operations);
    assert.equal(result.status, 'rolled-back');
    assert.deepEqual([...f.running], ['old']);
    assert.equal(result.state.refs, 'old');
  });
}

test('timeout aborts and fails closed even if operation later resolves', async () => {
  const f = fake();
  let release;
  let signal;
  f.operations.startPreview = (context) => {
    signal = context.signal;
    return new Promise((resolve) => { release = resolve; });
  };
  const result = await runCutover(f.operations, { timeoutMs: 10 });
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.error, 'OPERATION_TIMEOUT');
  assert.equal(result.state.preview, 'unknown');
  assert.equal(signal.aborted, true);
  assert.ok(!f.calls.includes('startOld'));
  release();
});

test('errors and rollback errors never expose injected secrets or paths', async () => {
  const f = fake();
  f.operations.health = async () => { throw new Error('PASSWORD=secret-value /private/data'); };
  f.operations.stopPreview = async () => { throw new Error('TOKEN=rollback-secret /private/rollback'); };
  const result = await runCutover(f.operations);
  assert.equal(result.phase, 'health');
  assert.equal(result.error, 'OPERATION_FAILED');
  assert.equal(result.rollbackError, 'OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret|PASSWORD|TOKEN|\/private/);
});

test('per-operation limits accept benchmark-sized clone and validation timeouts', async () => {
  const f = fake();
  const result = await runCutover(f.operations, {
    timeouts: { clone: 600_000, validate: 180_000, health: 120_000 },
  });
  assert.equal(result.status, 'completed');
});

test('per-operation timeout overrides the default without changing other timers', async () => {
  const f = fake();
  f.operations.clone = () => new Promise((resolve) => setTimeout(resolve, 30));
  f.operations.validate = () => new Promise((resolve) => setTimeout(resolve, 30));
  const result = await runCutover(f.operations, { timeoutMs: 10, timeouts: { clone: 200 } });
  assert.equal(result.phase, 'clone+validate');
  assert.equal(result.error, 'OPERATION_TIMEOUT');
  assert.equal(result.status, 'unconfirmed');
  assert.ok(result.history.some((entry) => entry.operation === 'clone' && entry.status === 'confirmed'));
  assert.ok(result.history.some((entry) => entry.operation === 'validate' && entry.status === 'timeout'));
  assert.ok(!f.calls.includes('startOld'));
});

test('rejects invalid timeout configuration before running operations', async () => {
  const configs = [
    { timeouts: { clone: 600_001 } }, { timeouts: { validate: 180_001 } },
    { timeouts: { health: 120_001 } }, { timeouts: { unknown: 1 } },
    { timeouts: { clone: 0 } }, { timeouts: { clone: 1.5 } },
    { timeouts: { clone: Infinity } }, { timeouts: { clone: '10' } },
    { timeouts: [['clone', 1], ['clone', 2]] }, { timeouts: [['clone']] },
    { timeouts: null }, { timeouts: new Map() }, { timeoutMs: 60_001 },
    { timeoutMs: 1.5 }, { timeouts: { [Symbol('clone')]: 1 } },
  ];
  for (const config of configs) {
    const f = fake();
    await assert.rejects(runCutover(f.operations, config));
    assert.deepEqual(f.calls, []);
  }
});

for (const name of names.slice(0, 9)) {
  test(`timeout at ${name} never retries or begins rollback`, async () => {
    const f = fake();
    let release;
    f.operations[name] = ({ signal }) => {
      f.calls.push(name);
      assert.equal(signal.aborted, false);
      return new Promise((resolve) => { release = resolve; });
    };
    const result = await runCutover(f.operations, { timeoutMs: 10 });
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.error, 'OPERATION_TIMEOUT');
    assert.equal(f.calls.at(-1), name);
    assert.equal(f.calls.filter((call) => call === name).length, 1);
    assert.equal(result.history.at(-1).status, 'timeout');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.at(-1), name);
  });
}

for (const [failure, rollback] of [['health', 'stopPreview'], ['startSafe', 'stopSafe'],
  ['health', 'restoreOld'], ['health', 'startOld']]) {
  test(`timeout during rollback ${rollback} is unconfirmed and not retried`, async () => {
    const f = fake([failure]);
    let release;
    f.operations[rollback] = () => {
      f.calls.push(rollback);
      return new Promise((resolve) => { release = resolve; });
    };
    const result = await runCutover(f.operations, { timeoutMs: 10 });
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.error, 'OPERATION_FAILED');
    assert.equal(result.rollbackError, 'OPERATION_TIMEOUT');
    assert.equal(f.calls.at(-1), rollback);
    assert.equal(f.calls.filter((call) => call === rollback).length, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.at(-1), rollback);
  });
}

test('failed subprocess termination is unconfirmed and never starts old', async () => {
  const f = fake();
  f.operations.clone = async () => {
    f.calls.push('clone');
    throw Object.assign(new Error('kill failed: /private SECRET'), { code: 'OPERATION_UNCONFIRMED' });
  };
  const result = await runCutover(f.operations);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.error, 'OPERATION_UNCONFIRMED');
  assert.equal(result.history.at(-1).status, 'unconfirmed');
  assert.deepEqual(f.calls, ['preflight', 'stopOld', 'clone']);
  assert.doesNotMatch(JSON.stringify(result), /private|SECRET|kill failed/);
});

test('unconfirmed process termination during rollback cannot report success', async () => {
  const f = fake(['health']);
  f.operations.stopPreview = async () => {
    f.calls.push('stopPreview');
    throw Object.assign(new Error('kill failed'), { code: 'OPERATION_UNCONFIRMED' });
  };
  const result = await runCutover(f.operations);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.error, 'OPERATION_FAILED');
  assert.equal(result.rollbackError, 'OPERATION_UNCONFIRMED');
  assert.equal(f.calls.at(-1), 'stopPreview');
  assert.equal(result.state.preview, 'unknown');
});

test('a worker continues after its independent client process disconnects', async () => {
  const moduleUrl = new URL('../tools/cutover-machine.mjs', import.meta.url).href;
  const worker = `
    import { runCutover } from ${JSON.stringify(moduleUrl)};
    const names = ${JSON.stringify(names)};
    const operations = Object.fromEntries(names.map(name => [name, async () => {}]));
    operations.health = () => new Promise(resolve => process.once('disconnect', resolve));
    const result = await runCutover(operations, { timeoutMs: 2000 });
    process.stdout.write(JSON.stringify(result));
  `;
  const client = `
    import { spawn } from 'node:child_process';
    const worker = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(worker)}],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    worker.on('spawn', () => { worker.disconnect(); worker.unref(); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', client], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(JSON.parse(stdout).status, 'completed');
});
