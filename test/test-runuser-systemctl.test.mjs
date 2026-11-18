import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyntheticUnitValidator } from '../tools/test-runuser-systemctl.mjs';

const uid = 1234;
const evidence = unit => ({ id: unit, names: [unit], transient: true, ownerUid: uid,
  execStart: ['/usr/bin/sleep'], dependencies: ['basic.target'],
  cgroup: { synthetic: true, ownerUid: uid, unit } });

test('generates distinct UUID unit names and validates only its opaque capability', async () => {
  const seen = [];
  const validator = createSyntheticUnitValidator({ ownerUid: uid, inspect: unit => { seen.push(unit); return evidence(unit); } });
  const a = validator.create(), b = validator.create();
  assert.match(a.unit, /^dhexbot-cutover-test-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.service$/);
  assert.notEqual(a.unit, b.unit);
  assert.deepEqual(await validator.verify(a.capability), { unit: a.unit, ownerUid: uid });
  const other = createSyntheticUnitValidator({ ownerUid: uid, inspect: evidence });
  for (const token of [{}, a.unit, null, other.create().capability]) await assert.rejects(validator.verify(token));
  assert.deepEqual(seen, [a.unit]);
});

test('rejects aliases, wrong IDs, unsafe execution, dependencies and fake cgroup mismatch', async () => {
  const mutations = [
    x => { x.id = 'wa-dashboard.service'; },
    x => { x.names.push('wa-dashboard.service'); },
    x => { x.names = ['alias.service']; },
    x => { x.transient = false; },
    x => { x.ownerUid = 0; },
    x => { x.execStart = ['/usr/bin/sleep', '10']; },
    x => { x.execStart = ['/bin/sh']; },
    x => { x.dependencies.push('wa-dashboard.service'); },
    x => { x.dependencies.push('basic.target'); },
    x => { x.cgroup.ownerUid = 0; },
    x => { x.cgroup.unit = 'wa-dashboard.service'; },
    x => { x.cgroup.synthetic = false; },
    x => { x.extra = true; },
  ];
  for (const mutate of mutations) {
    const validator = createSyntheticUnitValidator({ ownerUid: uid, inspect: unit => { const x = evidence(unit); mutate(x); return x; } });
    await assert.rejects(validator.verify(validator.create().capability), { message: 'Invalid synthetic unit evidence' });
  }
});

test('rechecks every use, fails closed and sanitizes callback errors', async () => {
  let count = 0;
  const validator = createSyntheticUnitValidator({ ownerUid: uid, inspect: unit => {
    if (++count === 2) throw new Error('SECRET /private');
    return evidence(unit);
  } });
  const { capability } = validator.create();
  await validator.verify(capability);
  await assert.rejects(validator.verify(capability), error => error.message === 'Invalid synthetic unit evidence' && !error.stack.includes('SECRET'));
  for (const ownerUid of [0, -1, 1.5, '1', NaN]) assert.throws(() => createSyntheticUnitValidator({ ownerUid, inspect: evidence }));
});
