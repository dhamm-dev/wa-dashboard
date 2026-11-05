import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, wibToIso } from '../src/schedule.js';

test('WIB conversion is independent of the server timezone', () => {
  assert.equal(wibToIso('2026-11-05T09:30'), '2026-11-05T02:30:00.000Z');
  assert.throws(() => wibToIso('2026-02-30T09:30'));
  assert.throws(() => wibToIso('2026-11-05T25:00'));
});

test('one-time schedules occur only once across checkpoint boundaries', () => {
  const schedule = { repeat: 'once', firstAt: '2026-11-05T02:30:00Z' };
  assert.deepEqual(occurrences(schedule, '2026-11-05T02:29:00Z', '2026-11-05T02:30:00Z'), ['2026-11-05T02:30:00.000Z']);
  assert.deepEqual(occurrences(schedule, '2026-11-05T02:30:00Z', '2026-11-06T00:00:00Z'), []);
});

test('weekly schedules retain their WIB wall time and enumerate missed occurrences', () => {
  const schedule = { repeat: 'weekly', firstAt: wibToIso('2026-11-05T09:30') };
  assert.deepEqual(occurrences(schedule, '2026-11-05T02:30:00Z', '2026-11-19T02:30:00Z'), [
    '2026-11-12T02:30:00.000Z', '2026-11-19T02:30:00.000Z'
  ]);
});

test('invalid ranges and recurrence are rejected', () => {
  assert.throws(() => occurrences({ repeat: 'daily', firstAt: '2026-11-05T02:30:00Z' }, '2026-11-05T00:00:00Z', '2026-11-06T00:00:00Z'));
  assert.throws(() => occurrences({ repeat: 'once', firstAt: 'invalid' }, '2026-11-05T00:00:00Z', '2026-11-06T00:00:00Z'));
});
