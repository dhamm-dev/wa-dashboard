import test from 'node:test';
import assert from 'node:assert/strict';
import { runCutover } from '../tools/cutover-machine.mjs';
import { createTestServiceManager } from '../tools/test-service-manager.mjs';

const fixture = options => createTestServiceManager({ environment: [{ DATA_DIR: 'wrong' }, { DATA_DIR: 'clone' }], ...options });

test('test manager completes cutover with ordered environment and exclusive services', async () => {
  const manager = fixture();
  const result = await runCutover(manager.operations);
  const state = manager.snapshot();
  assert.equal(result.status, 'completed');
  assert.deepEqual(state.services, { old: 'stopped', safe: 'stopped', preview: 'active' });
  assert.equal(state.socketOwner, 'preview');
  assert.equal(state.environment.DATA_DIR, 'clone');
  assert.deepEqual(state.calls, ['preflight', 'stopOld', 'clone', 'validate', 'startSafe', 'stopSafe', 'installPreview', 'startPreview', 'health']);
});

test('health failure rolls back only after preview is stopped', async () => {
  const manager = fixture({ faults: { health: 'before' } });
  const result = await runCutover(manager.operations);
  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(manager.snapshot().services, { old: 'active', safe: 'stopped', preview: 'stopped' });
  assert.equal(manager.snapshot().socketOwner, 'old');
  assert.deepEqual(manager.snapshot().calls.slice(-3), ['stopPreview', 'restoreOld', 'startOld']);
});

for (const operation of ['stopOld', 'stopSafe', 'stopPreview']) {
  for (const fault of ['lost', 'stale', 'job-failed']) {
    test(`${operation}: ${fault} never proves stopped or starts old`, async () => {
      const manager = fixture({ faults: { [operation]: fault, ...(operation === 'stopPreview' ? { health: 'before' } : {}) } });
      const result = await runCutover(manager.operations);
      assert.equal(result.status, 'unconfirmed');
      assert.equal(operation === 'stopPreview' ? result.rollbackError : result.error, 'OPERATION_UNCONFIRMED');
      assert.ok(!manager.snapshot().calls.includes('startOld'));
      const pending = manager.snapshot().jobs.find(job => job.name === operation && job.state === 'pending');
      if (pending) {
        manager.finish(pending.id);
        assert.ok(!manager.snapshot().calls.includes('startOld'));
      }
    });
  }
}

test('timed out start can complete later but cannot trigger rollback', async () => {
  const manager = fixture({ faults: { startPreview: 'pending' } });
  const result = await runCutover(manager.operations, { timeoutMs: 15 });
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.error, 'OPERATION_TIMEOUT');
  const job = manager.snapshot().jobs.find(job => job.name === 'startPreview');
  manager.finish(job.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.snapshot().services.preview, 'active');
  assert.ok(!manager.snapshot().calls.includes('startOld'));
  await assert.rejects(manager.operations.startOld(), { code: 'OPERATION_UNCONFIRMED' });
});

test('pending actions cannot be bypassed using a stale job id', async () => {
  const manager = fixture({ faults: { stopOld: 'pending' } });
  const stopping = manager.operations.stopOld();
  const id = manager.snapshot().jobs[0].id;
  assert.throws(() => manager.finish(id + 1), /Invalid test job/);
  await assert.rejects(manager.operations.clone(), { code: 'OPERATION_UNCONFIRMED' });
  manager.finish(id);
  await stopping;
  assert.throws(() => manager.finish(id), /Invalid test job/);
});

test('clone identity and final environment override are enforced before any safe start', async () => {
  assert.throws(() => fixture({ original: 'same', clone: 'same' }), TypeError);
  const manager = fixture({ environment: [{ DATA_DIR: 'clone' }, { DATA_DIR: 'original' }] });
  const result = await runCutover(manager.operations);
  assert.equal(result.status, 'rolled-back');
  assert.equal(manager.snapshot().services.safe, 'stopped');
  assert.equal(manager.snapshot().services.old, 'active');
});

test('a failed start job with unknown outcome cannot initiate rollback', async () => {
  const manager = fixture({ faults: { startSafe: 'job-failed' } });
  const result = await runCutover(manager.operations);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.error, 'OPERATION_UNCONFIRMED');
  assert.ok(!manager.snapshot().calls.includes('startOld'));
});
