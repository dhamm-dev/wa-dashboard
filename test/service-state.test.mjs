import test from 'node:test';
import assert from 'node:assert/strict';
import { isHealthyPreview, isQuiescent } from '../tools/service-state.mjs';

const stopped = () => ({
  bootId: 'boot', managerId: 'manager', unitId: 'service', invocationId: 'invocation', priorInvocationId: 'invocation',
  generation: 'generation', gateId: 'gate', gateHeld: true,
  writerCensusComplete: true, externalWriters: 0, unitWriters: 0,
  job: null, restartState: 'none', dataDirId: 'original', expectedDataDirId: 'original',
  activeState: 'inactive', subState: 'dead', mainPID: 0, controlPID: 0,
  cgroupCollectorTrusted: true, cgroupState: 'empty',
});

const { priorInvocationId: unusedPrior, ...previewBase } = stopped();
const preview = () => ({
  ...previewBase, dataDirId: 'clone', expectedDataDirId: 'clone',
  activeState: 'active', subState: 'running', mainPID: 123, unitWriters: 1,
  appId: 'app', expectedAppId: 'app', cloneId: 'clone', expectedCloneId: 'clone', healthOk: true,
});

test('accepts only confirmed stopped snapshots including trusted absent cgroup', () => {
  assert.equal(isQuiescent(stopped(), stopped()), true);
  assert.equal(isQuiescent({ ...stopped(), invocationId: '' }, { ...stopped(), invocationId: '' }), true);
  assert.equal(isQuiescent(stopped(), { ...stopped(), invocationId: '' }), false);
  assert.equal(isQuiescent({ ...stopped(), invocationId: 'new' }, { ...stopped(), invocationId: 'new' }), false);
  assert.equal(isQuiescent(stopped(), { ...stopped(), priorInvocationId: 'other' }), false);
  assert.equal(isQuiescent(stopped(), { ...stopped(), cgroupState: 'absent' }), true);
  assert.equal(isQuiescent(stopped(), { ...stopped(), cgroupState: 'absent', cgroupCollectorTrusted: false }), false);
});

test('missing required stopped evidence fails closed in either observation', () => {
  for (const key of Object.keys(stopped())) {
    const incomplete = stopped();
    delete incomplete[key];
    assert.equal(isQuiescent(incomplete, stopped()), false, key);
    assert.equal(isQuiescent(stopped(), incomplete), false, key);
  }
});

test('rejects state changes, stale jobs, restart, writers, and incorrect data', () => {
  const changes = {
    bootId: 'other', managerId: 'other', unitId: 'other', invocationId: 'other',
    generation: 'other', gateId: 'other', gateHeld: false, writerCensusComplete: false,
    externalWriters: 1, unitWriters: 1, job: { state: 'done' }, restartState: 'queued',
    dataDirId: 'wrong', expectedDataDirId: 'wrong', activeState: 'failed', subState: 'failed',
    mainPID: 1, controlPID: 1, cgroupState: 'populated', cgroupCollectorTrusted: false,
  };
  for (const [key, value] of Object.entries(changes)) {
    assert.equal(isQuiescent(stopped(), { ...stopped(), [key]: value }), false, key);
  }
  assert.equal(isQuiescent(stopped(), { ...stopped(), restartState: 'running' }), false);
  assert.equal(isQuiescent(stopped(), { ...stopped(), mainPID: '0' }), false);
  assert.equal(isQuiescent({ ...stopped(), dataDirId: 'wrong' }, { ...stopped(), dataDirId: 'wrong' }), false);
});

test('healthy preview requires stable app, clone, health and exclusive writer evidence', () => {
  assert.equal(isHealthyPreview(preview(), preview()), true);
  assert.equal(isHealthyPreview({ ...preview(), invocationId: '' }, { ...preview(), invocationId: '' }), false);
  const changes = {
    activeState: 'failed', subState: 'dead', mainPID: 0, controlPID: 1, unitWriters: 0,
    externalWriters: 1, writerCensusComplete: false, healthOk: false, appId: 'wrong',
    expectedAppId: 'wrong', cloneId: 'wrong', expectedCloneId: 'wrong', dataDirId: 'original',
    generation: 'new', invocationId: 'new', gateHeld: false, job: {}, restartState: 'running',
  };
  for (const [key, value] of Object.entries(changes)) {
    assert.equal(isHealthyPreview(preview(), { ...preview(), [key]: value }), false, key);
  }
  for (const key of Object.keys(preview()).filter(key => !key.startsWith('cgroup'))) {
    const incomplete = preview();
    delete incomplete[key];
    assert.equal(isHealthyPreview(incomplete, preview()), false, key);
  }
  assert.equal(isHealthyPreview(preview(), { ...preview(), mainPID: 124 }), false);
});

test('malformed inputs and throwing collectors return only false without exposing data', () => {
  const secret = 'PASSWORD=secret /private/data';
  const throwing = new Proxy({}, { get() { throw new Error(secret); } });
  for (const validate of [isQuiescent, isHealthyPreview]) {
    for (const input of [undefined, null, 'invalid', throwing]) {
      const result = validate(input, input);
      assert.equal(result, false);
      assert.doesNotMatch(JSON.stringify(result), /secret|PASSWORD|\/private/);
    }
  }
});
