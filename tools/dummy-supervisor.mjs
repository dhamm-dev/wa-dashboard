import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runCutover } from './cutover-machine.mjs';
import { safeClone } from './safe-clone.mjs';
import { verifyCloneDb } from './verify-clone-db.mjs';

const worker = `
  const { DatabaseSync } = require('node:sqlite');
  const net = require('node:net');
  const db = new DatabaseSync('/proc/self/fd/3', { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
  if (db.prepare('SELECT count(*) AS n FROM accounts').get().n !== 1) process.exit(2);
  const server = net.createServer(s => s.end('synthetic-ok\\n'));
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`;
const unconfirmed = () => Object.assign(new Error('Dummy process state unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });

function check(signal) { if (signal?.aborted) throw unconfirmed(); }

function probe(port, signal) {
  return new Promise((resolve, reject) => {
    check(signal);
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    const abort = () => socket.destroy(unconfirmed());
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(1000, () => socket.destroy(unconfirmed()));
    socket.on('data', chunk => { data += chunk; if (data.length > 100) socket.destroy(unconfirmed()); });
    socket.once('error', reject);
    socket.once('close', hadError => {
      signal?.removeEventListener('abort', abort);
      if (!hadError) data === 'synthetic-ok\n' && !signal?.aborted ? resolve() : reject(unconfirmed());
    });
  });
}

// No unit, executable, path, command, environment, or runner is accepted from callers.
export async function runDummySupervisor(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Reflect.ownKeys(options).some(key => !['scenario', 'timeoutMs'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))) {
    throw new TypeError('Invalid dummy harness configuration');
  }
  const { scenario = 'success', timeoutMs = 5000 } = options;
  if (process.platform !== 'linux' || process.getuid() === 0 ||
      !['success', 'health-failure', 'stop-timeout', 'stop-unknown'].includes(scenario) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('Invalid dummy harness configuration');
  if (await fs.realpath('/tmp') !== '/tmp') throw new Error('Private temporary directory unavailable');
  const root = await fs.mkdtemp('/tmp/dhexbot-dummy-');
  await fs.chmod(root, 0o700);
  const source = path.join(root, 'original');
  const clone = path.join(root, 'clone');
  const scratch = path.join(root, 'scratch');
  await fs.mkdir(source, { mode: 0o700 });
  const db = new DatabaseSync(path.join(source, 'dashboard.sqlite'));
  try {
    db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY); CREATE TABLE schedules(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('synthetic'); INSERT INTO schedules VALUES ('synthetic');");
  } finally { db.close(); }

  const names = Object.freeze(Object.fromEntries(['old', 'safe', 'preview'].map(role =>
    [role, `dhexbot-cutover-test-${randomUUID()}.service`])));
  const owned = new Map();
  const events = [];
  let refs = 'old';
  let verified = false;
  let closing = false;
  const idle = () => [...owned.values()].every(entry => entry.exited);
  const requireIdle = () => { if (!idle()) throw unconfirmed(); };

  async function start(role, signal) {
    check(signal);
    if (closing || !Object.hasOwn(names, role)) throw unconfirmed();
    requireIdle();
    if (role !== 'old' && !verified) throw unconfirmed();
    const dir = role === 'old' ? source : clone;
    const fd = await fs.open(path.join(dir, 'dashboard.sqlite'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      check(signal);
      if (closing) throw unconfirmed();
      requireIdle();
      const child = spawn(process.execPath, ['-e', worker], {
        env: {}, stdio: ['ignore', 'ignore', 'ignore', fd.fd, 'ipc'], shell: false,
      });
      const entry = { child, exited: false, port: null };
      owned.set(role, entry);
      events.push({ action: 'start', role, name: names[role], pid: child.pid });
      entry.exit = new Promise(resolve => {
        child.once('error', () => {});
        child.once('close', () => { entry.exited = true; resolve(); });
      });
      await new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(unconfirmed()); };
        const close = () => { cleanup(); reject(unconfirmed()); };
        const message = value => {
          if (!Number.isInteger(value?.port) || value.port < 1 || value.port > 65535) return close();
          entry.port = value.port; cleanup(); resolve();
        };
        const cleanup = () => { signal?.removeEventListener('abort', abort); child.off('close', close); child.off('message', message); };
        signal?.addEventListener('abort', abort, { once: true });
        child.once('close', close); child.once('message', message);
        if (signal?.aborted) abort();
      });
      check(signal);
      await probe(entry.port, signal);
      check(signal);
      if (entry.exited) throw unconfirmed();
    } finally { await fd.close(); }
  }

  async function stop(role, signal) {
    check(signal);
    const entry = owned.get(role);
    if (!entry || entry.exited) throw unconfirmed();
    if (role === 'old' && scenario === 'stop-timeout') {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(unconfirmed()), { once: true }));
    }
    if (role === 'old' && scenario === 'stop-unknown') throw unconfirmed();
    events.push({ action: 'stop', role, name: names[role], pid: entry.child.pid });
    if (!entry.child.kill('SIGTERM')) throw unconfirmed();
    await entry.exit;
    check(signal);
    if (!entry.exited) throw unconfirmed();
  }

  const operations = {
    preflight: async ({ signal }) => { check(signal); if (!owned.get('old') || owned.get('old').exited) throw unconfirmed(); },
    stopOld: ({ signal }) => stop('old', signal),
    clone: async ({ signal }) => { check(signal); requireIdle(); await safeClone({ source, destination: clone, isQuiescent: async () => !signal.aborted && idle() }); check(signal); },
    validate: async ({ signal }) => { check(signal); requireIdle(); const result = await verifyCloneDb({ source: clone, destination: scratch, expectedPaths: ['dashboard.sqlite'], isQuiescent: async () => !signal.aborted && idle() }); check(signal); if (result.counts.accounts !== '1' || result.counts.schedules !== '1') throw new Error('Unexpected synthetic data'); verified = true; },
    startSafe: ({ signal }) => start('safe', signal),
    stopSafe: ({ signal }) => stop('safe', signal),
    installPreview: async ({ signal }) => { check(signal); requireIdle(); refs = 'preview'; },
    startPreview: ({ signal }) => { if (refs !== 'preview') throw unconfirmed(); return start('preview', signal); },
    health: async ({ signal }) => { check(signal); if (scenario === 'health-failure') throw new Error('Synthetic health failure'); const entry = owned.get('preview'); if (!entry || entry.exited) throw unconfirmed(); await probe(entry.port, signal); if (entry.exited) throw unconfirmed(); },
    stopPreview: ({ signal }) => stop('preview', signal),
    restoreOld: async ({ signal }) => { check(signal); requireIdle(); refs = 'old'; },
    startOld: ({ signal }) => { if (refs !== 'old') throw unconfirmed(); return start('old', signal); },
  };
  let result;
  let cleanupConfirmed = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { await start('old', controller.signal); } finally { clearTimeout(timer); }
    result = await runCutover(operations, { timeoutMs });
  } finally {
    closing = true;
    for (const entry of owned.values()) if (!entry.exited) entry.child.kill('SIGKILL');
    let timer;
    await Promise.race([
      Promise.all([...owned.values()].map(entry => entry.exit)),
      new Promise(resolve => { timer = setTimeout(resolve, 2000); }),
    ]);
    clearTimeout(timer);
    cleanupConfirmed = idle();
  }
  return { ...result, root, names, events, cleanupConfirmed, backend: 'direct-child' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('This harness accepts no command-line arguments');
  console.log(JSON.stringify(await runDummySupervisor(), null, 2));
}
