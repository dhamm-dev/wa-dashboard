import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDummyDbShow } from '../tools/dummy-db-adapter.mjs';

const unit = 'dhexbot-db-test-12345678-1234-4234-8234-123456789abc.service';
const fields = {
  Id: unit, Names: unit, LoadState: 'loaded', Transient: 'yes',
  ExecStart: '{ path=/usr/bin/sleep ; argv[]=/usr/bin/sleep 60 ; }', RuntimeMaxUSec: '3min',
  StandardInput: 'file', Wants: '', Requires: 'app.slice', Requisite: '', BindsTo: '', PartOf: '',
  ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0', ControlGroup: '',
  Job: '', InvocationID: '',
};
const show = values => Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
const unconfirmed = error => error.code === 'OPERATION_UNCONFIRMED' && error.message === 'Dummy DB operation unconfirmed';

test('parses bounded systemctl properties without inventing missing values', () => {
  const result = parseDummyDbShow(show(fields));
  assert.equal(result.ControlGroup, '');
  assert.equal(result.StandardInput, 'file');
  assert.equal(result.ExecStart, fields.ExecStart);
  assert.equal(Object.hasOwn(result, 'StandardInputFile'), false);
  assert.equal(Object.isFrozen(result), true);
});

test('rejects malformed, incomplete, extra, aliased and non-synthetic output', () => {
  const { Job, ...missing } = fields;
  const inputs = [show(missing), show({ ...fields, Unexpected: 'x' }),
    show(fields) + 'Job=duplicate\n', show({ ...fields, Names: `${unit} alias.service` }),
    show({ ...fields, Id: 'production.service', Names: 'production.service' }),
    show(fields).replace('Job=', 'Job\0='), show(fields).replace('Job=', 'Job\r='),
    show({ ...fields, ExecStart: 'x'.repeat(16385) }), null];
  for (const input of inputs) assert.throws(() => parseDummyDbShow(input), unconfirmed);
});
