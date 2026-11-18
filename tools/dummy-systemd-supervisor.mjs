import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROGRAM = '/usr/sbin/runuser';
const PREFIX = ['-u', 'dhexct528dec24', '--', '/usr/bin/env',
  'XDG_RUNTIME_DIR=/run/user/999', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus',
  '/usr/bin/systemctl', '--user'];
const PROPERTIES = ['Id', 'Names', 'Transient', 'ExecStart', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf'];
const DEFAULT_DEPENDENCIES = { Wants: new Set(['basic.target']), Requires: new Set(['app.slice', 'basic.target']),
  Requisite: new Set(), BindsTo: new Set(), PartOf: new Set() };
const timestamp = String.raw`\[(?:n/a|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Za-z][A-Za-z0-9_+\/-]*)\]`;
const execStart = new RegExp(String.raw`^\{ path=/usr/bin/sleep ; argv\[\]=/usr/bin/sleep 180 ; ignore_errors=no ; start_time=${timestamp} ; stop_time=${timestamp} ; pid=(?:0|[1-9]\d{0,9}) ; code=(?:\(null\)|exited|killed|dumped) ; status=\d{1,3}/(?:\d{1,3}|[A-Z][A-Z0-9_]*) \}$`);
const failure = () => Object.assign(new Error('Dummy unit inspection unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });

function run(file, args) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawn(file, args, { shell: false, env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(failure()); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(true); }, 3000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 16384) { child.kill('SIGKILL'); finish(true); }
    });
    child.on('error', () => finish(true));
    child.on('close', code => finish(code !== 0, output));
  });
}

function validate(output, unit, holderWants) {
  if (typeof output !== 'string' || output.length > 16384) throw failure();
  const properties = new Map();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const equals = line.indexOf('=');
    if (equals < 1) throw failure();
    const key = line.slice(0, equals);
    if (!PROPERTIES.includes(key) || properties.has(key)) throw failure();
    properties.set(key, line.slice(equals + 1));
  }
  if (properties.size !== PROPERTIES.length || properties.get('Id') !== unit ||
      properties.get('Names') !== unit || properties.get('Transient') !== 'yes' ||
      !execStart.test(properties.get('ExecStart')) ||
      (holderWants !== undefined && properties.get('Wants') !== holderWants) ||
      ['Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf'].some(key => {
        const value = properties.get(key);
        if (key === 'Wants' && holderWants !== undefined) return false;
        if (value === '') return false;
        const dependencies = value.split(' ');
        return dependencies.some(name => !DEFAULT_DEPENDENCIES[key].has(name)) ||
          new Set(dependencies).size !== dependencies.length;
      })) throw failure();
}

export function createDummySystemdInspector(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Reflect.ownKeys(options).some(key => !['dryRun', 'runner'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) ||
      (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') ||
      (options.dryRun === true ? typeof options.runner !== 'function' : options.runner !== undefined)) throw failure();
  const runner = options.dryRun ? options.runner : run;
  const units = new WeakMap();
  let locked = false;
  let busy = false;
  const mint = holderWants => {
    const capability = Object.freeze(Object.create(null));
    const unit = `dhexbot-cutover-test-${randomUUID()}.service`;
    units.set(capability, { unit, holderWants });
    return Object.freeze({ capability, unit });
  };
  return Object.freeze({
    create() {
      if (locked || busy) throw failure();
      return mint();
    },
    createPair() {
      if (locked || busy) throw failure();
      const target = mint();
      const holder = mint(target.unit);
      if (target.unit === holder.unit) { locked = true; throw failure(); }
      return Object.freeze({ target, holder });
    },
    async inspect(capability) {
      if (locked || busy) { locked = true; throw failure(); }
      const entry = units.get(capability);
      if (!entry) { locked = true; throw failure(); }
      const { unit, holderWants } = entry;
      busy = true;
      let timer;
      try {
        const args = [...PREFIX, 'show', ...PROPERTIES.map(key => `--property=${key}`), '--', unit];
        const output = await Promise.race([
          Promise.resolve().then(() => runner(PROGRAM, args)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(failure()), 3000);
          }),
        ]);
        if (locked) throw failure();
        validate(output, unit, holderWants);
        return Object.freeze({ status: 'metadata-matched', unit });
      } catch {
        locked = true;
        throw failure();
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ status: 'inspection-only', actions: false }));
}
