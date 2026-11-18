import { spawn } from 'node:child_process';

const unit = 'wa-dashboard.service';
const properties = new Set([
  'Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'Job',
  'InvocationID', 'Result', 'ControlGroup', 'WorkingDirectory', 'FragmentPath', 'DropInPaths',
]);
const failure = () => Object.assign(new Error('Service operation unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });

function allowed(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) return false;
  if (args.length === 2 && args[0] === '--user' && args[1] === 'daemon-reload') return true;
  if (args.length === 4 && args[0] === '--user' && ['start', 'stop'].includes(args[1]) && args[2] === '--' && args[3] === unit) return true;
  if (args.length < 5 || args[0] !== '--user' || args[1] !== 'show' || args.at(-2) !== '--' || args.at(-1) !== unit) return false;
  const requested = args.slice(2, -2);
  return requested.every(arg => arg.startsWith('--property=') && properties.has(arg.slice(11))) &&
    new Set(requested).size === requested.length;
}

export function createUserSystemctlRunner({ spawnProcess = spawn, getUid = process.geteuid, timeoutMs = 30000 } = {}) {
  if (typeof spawnProcess !== 'function' || typeof getUid !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw failure();
  return (args, { signal } = {}) => new Promise((resolve, reject) => {
    if (!allowed(args) || getUid() !== 0 || signal?.aborted) return reject(failure());
    let child;
    try {
      child = spawnProcess('/usr/sbin/runuser', [
        '-u', 'dhexweb', '--', '/usr/bin/env', 'HOME=/home/dhexweb',
        'XDG_RUNTIME_DIR=/run/user/1000', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
        '/usr/bin/systemctl', ...args,
      ], { shell: false, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return reject(failure()); }
    let output = '';
    let settled = false;
    let timer;
    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!ok) reject(failure()); else resolve({ code, stdout: output });
    };
    const abort = () => {
      try { child.kill('SIGTERM'); } catch {}
      finish(false);
    };
    timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      output += chunk;
      if (output.length > 65536) abort();
    });
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0 && !signal?.aborted && output.length <= 65536, code));
    if (signal?.aborted) abort();
  });
}
