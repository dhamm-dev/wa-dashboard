import test from 'node:test';
import assert from 'node:assert/strict';
import { createDummySystemdInspector } from '../tools/dummy-systemd-supervisor.mjs';

const start = '{ path=/usr/bin/sleep ; argv[]=/usr/bin/sleep 180 ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }';
const properties = unit => ({ Id: unit, Names: unit, Transient: 'yes', ExecStart: start,
  Wants: '', Requires: 'basic.target', Requisite: '', BindsTo: '', PartOf: '' });
const serialize = values => Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
const unconfirmed = error => error.code === 'OPERATION_UNCONFIRMED' && error.message === 'Dummy unit inspection unconfirmed';
const setup = response => {
  let unit;
  const calls = [];
  const inspector = createDummySystemdInspector({ dryRun: true, runner: (...args) => {
    calls.push(args);
    return response(unit);
  } });
  const created = inspector.create();
  unit = created.unit;
  return { inspector, calls, ...created };
};

test('inspects only the generated unit with fixed command and reports metadata only', async () => {
  const item = setup(unit => serialize(properties(unit)));
  assert.match(item.unit, /^dhexbot-cutover-test-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.service$/);
  assert.deepEqual(await item.inspector.inspect(item.capability), { status: 'metadata-matched', unit: item.unit });
  assert.deepEqual(item.calls, [['/usr/sbin/runuser', ['-u', 'dhexct528dec24', '--', '/usr/bin/env',
    'XDG_RUNTIME_DIR=/run/user/999', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus',
    '/usr/bin/systemctl', '--user', 'show', ...['Id', 'Names', 'Transient', 'ExecStart', 'Wants',
      'Requires', 'Requisite', 'BindsTo', 'PartOf'].map(key => `--property=${key}`), '--', item.unit]]]);
});

test('accepts bounded runtime fields and explicit user-manager defaults', async () => {
  const item = setup(unit => serialize({ ...properties(unit), Wants: 'basic.target', Requires: '',
    ExecStart: start.replace('[n/a]', '[Tue 2026-11-17 12:34:56 UTC]')
      .replace('pid=0', 'pid=12345') }));
  assert.equal((await item.inspector.inspect(item.capability)).status, 'metadata-matched');
  const stopped = setup(unit => serialize({ ...properties(unit), ExecStart: start
    .replace('[n/a]', '[Tue 2026-11-17 12:34:56 WIB]')
    .replace('[n/a]', '[Tue 2026-11-17 12:37:56 WIB]')
    .replace('pid=0 ; code=(null) ; status=0/0', 'pid=12345 ; code=exited ; status=0/SUCCESS') }));
  assert.equal((await stopped.inspector.inspect(stopped.capability)).status, 'metadata-matched');
});

test('accepts observed user-manager Requires in either order', async () => {
  for (const requires of ['app.slice basic.target', 'basic.target app.slice']) {
    const item = setup(unit => serialize({ ...properties(unit), Requires: requires }));
    assert.equal((await item.inspector.inspect(item.capability)).status, 'metadata-matched');
  }
});

test('rejects forged or ambiguous metadata and locks after failure', async t => {
  const changes = [
    p => { p.Id += 'x'; }, p => { p.Names += ' alias.service'; }, p => { p.Names = 'alias.service'; },
    p => { p.Transient = 'no'; }, p => { delete p.Id; }, p => { p.Extra = 'secret'; },
    p => { p.ExecStart = p.ExecStart.replace('/usr/bin/sleep', '/tmp/sleep'); },
    p => { p.ExecStart = p.ExecStart.replace('sleep 180', 'sleep 180 1'); },
    p => { p.ExecStart += ' ' + start; }, p => { p.ExecStart = p.ExecStart.replace('180', '180; /bin/sh'); },
    p => { p.ExecStart = p.ExecStart.replace('ignore_errors=no', 'ignore_errors=yes'); },
    p => { p.ExecStart = p.ExecStart.replace('[n/a]', '[n/a] ; path=/bin/sh'); },
    p => { p.ExecStart = p.ExecStart.replace('pid=0', 'pid=1 ; argv[]=/bin/sh'); },
    p => { p.ExecStart = p.ExecStart.replace('pid=0', 'pid=-1'); },
    p => { p.ExecStart = p.ExecStart.replace('code=(null)', 'code=unknown'); },
    ...['Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf'].map(key => p => { p[key] = 'production.service'; }),
    p => { p.Requires = 'basic.target basic.target'; }, p => { p.Requires = 'basic.target  production.service'; },
    p => { p.Requires = 'app.slice app.slice basic.target'; },
    p => { p.Requires = 'app.slice basic.target other.slice'; },
    p => { p.Requires = 'app.slice basic.target production.service'; },
    p => { p.Wants = 'app.slice'; },
    p => { p.PartOf = 'basic.target'; }, p => { p.Wants = 'shutdown.target'; },
  ];
  for (const [index, change] of changes.entries()) await t.test(`invalid ${index}`, async () => {
    const item = setup(unit => { const p = properties(unit); change(p); return serialize(p); });
    await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
    await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
    assert.throws(() => item.inspector.create(), unconfirmed);
    assert.equal(item.calls.length, 1);
  });
});

test('rejects malformed output, duplicate keys, excessive output and redacts errors', async t => {
  const outputs = [u => serialize(properties(u)) + `Id=${u}\n`, u => serialize(properties(u)) + 'malformed\n',
    () => 'sensitive'.repeat(3000), () => ({ secret: 'sensitive' }), () => { throw new Error('sensitive'); }];
  for (const [index, output] of outputs.entries()) await t.test(`output ${index}`, async () => {
    const item = setup(output);
    await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
  });
});

test('rejects invalid options and foreign capabilities without calling runner', async () => {
  for (const options of [null, { dryRun: true }, { runner() {} }, { dryRun: 'yes' }, { extra: 1 },
    Object.defineProperty({}, 'dryRun', { get() { throw Error('secret'); } })]) {
    assert.throws(() => createDummySystemdInspector(options), unconfirmed);
  }
  const item = setup(unit => serialize(properties(unit)));
  await assert.rejects(item.inspector.inspect(Object.freeze({})), unconfirmed);
  await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
  assert.equal(item.calls.length, 0);
});

test('reentrancy locks both in-flight and subsequent inspections', async () => {
  let resolve;
  const item = setup(() => new Promise(done => { resolve = done; }));
  const pending = item.inspector.inspect(item.capability);
  await Promise.resolve();
  await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
  resolve(serialize(properties(item.unit)));
  await assert.rejects(pending, unconfirmed);
  await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
});

test('a stalled runner times out and locks the inspector', async () => {
  const item = setup(() => new Promise(() => {}));
  await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
  await assert.rejects(item.inspector.inspect(item.capability), unconfirmed);
});

test('a minted holder can only want its own distinct minted target', async () => {
  let pair;
  const calls = [];
  const inspector = createDummySystemdInspector({ dryRun: true, runner: (file, args) => {
    calls.push([file, args]);
    const unit = args.at(-1);
    return serialize({ ...properties(unit), Wants: unit === pair.holder.unit ? pair.target.unit : '' });
  } });
  pair = inspector.createPair();
  assert.notEqual(pair.target.unit, pair.holder.unit);
  assert.notEqual(pair.target.capability, pair.holder.capability);
  assert.equal((await inspector.inspect(pair.target.capability)).unit, pair.target.unit);
  assert.equal((await inspector.inspect(pair.holder.capability)).unit, pair.holder.unit);
  assert.deepEqual(calls.map(([, args]) => args.at(-1)), [pair.target.unit, pair.holder.unit]);
});

test('holder rejects aliases, wrong Wants, extra dependencies, and foreign capabilities', async () => {
  for (const change of [
    (p, pair) => { p.Wants = ''; },
    (p, pair) => { p.Wants = 'production.service'; },
    (p, pair) => { p.Wants += ' basic.target'; },
    (p, pair) => { p.Names += ' alias.service'; },
    (p, pair) => { p.Requires += ' production.service'; },
    (p, pair) => { p.ExecStart = p.ExecStart.replace('sleep 180', 'sleep 181'); },
  ]) {
    let pair;
    const inspector = createDummySystemdInspector({ dryRun: true, runner: (_file, args) => {
      const p = { ...properties(args.at(-1)), Wants: pair.target.unit };
      change(p, pair);
      return serialize(p);
    } });
    pair = inspector.createPair();
    await assert.rejects(inspector.inspect(pair.holder.capability), unconfirmed);
    await assert.rejects(inspector.inspect(pair.target.capability), unconfirmed);
  }
  const inspector = createDummySystemdInspector({ dryRun: true, runner: () => { throw Error('unexpected'); } });
  const pair = inspector.createPair();
  await assert.rejects(inspector.inspect({ ...pair.holder.capability }), unconfirmed);
  await assert.rejects(inspector.inspect(pair.holder.capability), unconfirmed);
});
