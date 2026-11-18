import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runDummySupervisor } from '../tools/dummy-supervisor.mjs';

const options = { timeoutMs: 5000 };

test('real synthetic processes complete the bounded sequence', async () => {
  const result = await runDummySupervisor(options);
  assert.equal(result.status, 'completed');
  assert.equal(result.backend, 'direct-child');
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.events.map(({ action, role }) => `${action}:${role}`),
    ['start:old', 'stop:old', 'start:safe', 'stop:safe', 'start:preview']);
  assert.equal(new Set(Object.values(result.names)).size, 3);
  for (const name of Object.values(result.names)) assert.match(name, /^dhexbot-cutover-test-[0-9a-f-]{36}\.service$/);
  assert.equal((await fs.stat(result.root)).mode & 0o777, 0o700);
  for (const dir of ['original', 'clone', 'scratch']) assert.ok((await fs.stat(path.join(result.root, dir, 'dashboard.sqlite'))).isFile());
});

test('failed preview health stops preview before restarting old', async () => {
  const result = await runDummySupervisor({ ...options, scenario: 'health-failure' });
  assert.equal(result.status, 'rolled-back');
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.events.map(({ action, role }) => `${action}:${role}`),
    ['start:old', 'stop:old', 'start:safe', 'stop:safe', 'start:preview', 'stop:preview', 'start:old']);
  assert.ok((await fs.stat(path.join(result.root, 'clone', 'dashboard.sqlite'))).isFile());
});

for (const scenario of ['stop-timeout', 'stop-unknown']) {
  test(`${scenario} never starts a second process`, async () => {
    const result = await runDummySupervisor({ scenario, timeoutMs: 1000 });
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.error, scenario === 'stop-timeout' ? 'OPERATION_TIMEOUT' : 'OPERATION_UNCONFIRMED');
    assert.deepEqual(result.events.map(({ action, role }) => `${action}:${role}`), ['start:old']);
    assert.equal(result.cleanupConfirmed, true);
    await assert.rejects(fs.stat(path.join(result.root, 'clone')), { code: 'ENOENT' });
  });
}

test('rejects unsupported scenarios and bounds', async () => {
  await assert.rejects(runDummySupervisor({ scenario: 'production' }), TypeError);
  await assert.rejects(runDummySupervisor({ timeoutMs: 0 }), TypeError);
  await assert.rejects(runDummySupervisor({ unit: 'anything.service' }), TypeError);
  await assert.rejects(runDummySupervisor({ path: '/tmp' }), TypeError);
});
