import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProcReader } from './proc-reader.mjs';
import { createUserSystemctlRunner } from './user-systemctl-runner.mjs';
import { writerCensus } from './writer-census.mjs';
import { safeInventory } from './safe-inventory.mjs';
import { inventoryInodes } from './inventory-inodes.mjs';

const app = '/home/dhexweb/wa-dashboard';
const data = `${app}/data`;
const database = `${data}/dashboard.sqlite`;
const release = '/home/dhexweb/dhexbot-preview-release-37ec9a3cc5828208/app';
const preview = '/home/dhexweb/dhexbot-preview-release-05aee121be1701ab/config/preview.env';
const apkHash = 'e09b6e7a5aa35ebe014783d0dabccf6f8dc0d69d74a700691a53ba38023eaaae';
export const expectedReleaseManifest = 'fccafcb1e529995c9d59c49a898ed945eba9b6dbe47188789e70eef29b3e4633';
const googleClient = '906779767123-3dcfo6nunh5j3l8hkqqc877ecae62m0f.apps.googleusercontent.com';
const unit = 'wa-dashboard.service';
const props = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'Job', 'InvocationID', 'WorkingDirectory', 'DropInPaths'];
const names = ['root', 'service', 'data', 'preview', 'release', 'apk', 'schedules', 'dataWriters', 'stable'];

export function parseProperties(text) {
  if (typeof text !== 'string' || text.length > 65536) throw new Error('Invalid service metadata');
  const fields = Object.create(null);
  for (const line of text.split('\n')) {
    if (!line) continue;
    const index = line.indexOf('=');
    const name = line.slice(0, index);
    if (index < 1 || !props.includes(name) || Object.hasOwn(fields, name)) throw new Error('Invalid service metadata');
    fields[name] = line.slice(index + 1);
  }
  if (props.some(name => !Object.hasOwn(fields, name))) throw new Error('Invalid service metadata');
  return fields;
}

export function activeService(fields) {
  return fields.Id === unit && fields.LoadState === 'loaded' && fields.ActiveState === 'active' &&
    fields.SubState === 'running' && /^[1-9][0-9]*$/.test(fields.MainPID) &&
    (fields.Job === '' || fields.Job === '0') && Boolean(fields.InvocationID) &&
    fields.WorkingDirectory === app && fields.DropInPaths === '';
}

export function hasExactAssignment(buffer, name, expected) {
  const prefix = Buffer.from(`${name}=`);
  const target = Buffer.from(`${name}=${expected}`);
  let start = 0;
  let matches = 0;
  let exact = false;
  while (start < buffer.length) {
    const end = buffer.indexOf(10, start);
    const lineEnd = end === -1 ? buffer.length : end;
    const actualEnd = lineEnd > start && buffer[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
    const line = buffer.subarray(start, actualEnd);
    if (line.subarray(0, prefix.length).equals(prefix)) { matches++; exact = line.equals(target); }
    start = end === -1 ? buffer.length : end + 1;
  }
  return matches === 1 && exact;
}

function assignment(buffer, name) {
  const prefix = Buffer.from(`${name}=`);
  let start = 0;
  let result = null;
  while (start < buffer.length) {
    const end = buffer.indexOf(10, start);
    const lineEnd = end === -1 ? buffer.length : end;
    const actualEnd = lineEnd > start && buffer[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
    const line = buffer.subarray(start, actualEnd);
    if (line.subarray(0, prefix.length).equals(prefix)) {
      if (result !== null) return null;
      result = line.subarray(prefix.length);
    }
    start = end === -1 ? buffer.length : end + 1;
  }
  return result;
}

export function validPreviewConfig(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const secret = assignment(buffer, 'GOOGLE_CLIENT_SECRET');
  const master = assignment(buffer, 'BOT_SECRET_ENCRYPTION_KEY');
  if (!secret || secret.length < 12 || secret.length > 256 ||
      ![...secret].every(byte => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) ||
        (byte >= 97 && byte <= 122) || byte === 45 || byte === 95) ||
      !master || master.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(master.toString('ascii'))) return false;
  const decoded = Buffer.from(master.toString('ascii'), 'base64');
  const validMaster = decoded.length === 32 && decoded.toString('base64') === master.toString('ascii');
  decoded.fill(0);
  return validMaster && hasExactAssignment(buffer, 'DHEXBOT_PRIVATE_PREVIEW', '1') &&
    hasExactAssignment(buffer, 'DHEXBOT_PUBLIC_SIGNUP', '0') &&
    hasExactAssignment(buffer, 'COOKIE_SECURE', 'true') && hasExactAssignment(buffer, 'TRUST_PROXY', '1') &&
    hasExactAssignment(buffer, 'GOOGLE_CLIENT_ID', googleClient) &&
    hasExactAssignment(buffer, 'GOOGLE_ANDROID_REDIRECT_URI', 'https://wa.dhexx.my.id/api/google/android/callback');
}

export function containsEnvironment(buffer, assignment) {
  const needle = Buffer.from(`${assignment}\0`);
  let index = buffer.indexOf(needle);
  while (index !== -1) {
    if (index === 0 || buffer[index - 1] === 0) return true;
    index = buffer.indexOf(needle, index + 1);
  }
  return false;
}

export async function readOwnedFile(path, maximum, mode) {
  let handle;
  const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'uid', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || await realpath(path) !== path) throw new Error();
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== 1000n ||
        (mode !== undefined && (before.mode & 0o777n) !== BigInt(mode)) || before.size > BigInt(maximum)) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(before, await handle.stat({ bigint: true }))) throw new Error();
    const chunks = [];
    const buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw new Error();
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (BigInt(total) !== before.size || !same(before, await handle.stat({ bigint: true })) ||
        !same(before, await lstat(path, { bigint: true }))) throw new Error();
    return Buffer.concat(chunks);
  } catch {
    throw new Error('Required file unavailable');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export function manifestDigest(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.some(entry =>
    !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
    !/^(?:src\/[a-z0-9-]+\.js|public\/(?:index\.html|app\.js|style\.css)|package(?:-lock)?\.json|tools\/link-production-admin\.mjs)$/.test(entry[0]) ||
    typeof entry[1] !== 'string' || !/^[0-9a-f]{64}$/.test(entry[1]))) throw new Error('Invalid release manifest');
  const sorted = entries.map(entry => [...entry]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (new Set(sorted.map(entry => entry[0])).size !== sorted.length) throw new Error('Invalid release manifest');
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

async function releaseDigest(root) {
  const source = await readdir(`${root}/src`);
  if (source.some(name => !/^[a-z0-9-]+\.js$/.test(name))) throw new Error('Invalid release source');
  const paths = [...source.map(name => `src/${name}`), 'public/index.html', 'public/app.js', 'public/style.css',
    'package.json', 'package-lock.json', 'tools/link-production-admin.mjs'];
  const entries = [];
  for (const file of paths) entries.push([file, createHash('sha256').update(await readOwnedFile(`${root}/${file}`, 4 * 1024 * 1024)).digest('hex')]);
  return manifestDigest(entries);
}

async function selfDoesNotHold(targets) {
  const target = new Set(targets.map(({ dev, ino }) => `${dev}:${ino}`));
  const { readdir } = await import('node:fs/promises');
  for (const fd of await readdir('/proc/self/fd')) {
    if (!/^[0-9]+$/.test(fd)) continue;
    try {
      const info = await stat(`/proc/self/fd/${fd}`, { bigint: true });
      if (target.has(`${info.dev}:${info.ino}`)) return false;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
  }
  return true;
}

export async function inspectProduction() {
  const checks = Object.fromEntries(names.map(name => [name, false]));
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) return { ok: false, checks };
  checks.root = true;
  try {
    const run = createUserSystemctlRunner();
    const show = async () => parseProperties((await run(['--user', 'show', ...props.map(name => `--property=${name}`), '--', unit])).stdout);
    const first = await show();
    if (!activeService(first)) return { ok: false, checks };
    const pid = Number(first.MainPID);
    if (!Number.isSafeInteger(pid)) return { ok: false, checks };
    const cwd = await realpath(`/proc/${pid}/cwd`);
    const cmdline = await readFile(`/proc/${pid}/cmdline`);
    const environ = await readFile(`/proc/${pid}/environ`);
    checks.service = cwd === app && cmdline.equals(Buffer.from(`/usr/bin/node\0${app}/src/server.js\0`)) &&
      containsEnvironment(environ, `DATA_DIR=${data}`);
    environ.fill(0);
    if (!checks.service) return { ok: false, checks };
    const dataInfo = await lstat(data);
    checks.data = dataInfo.isDirectory() && !dataInfo.isSymbolicLink() && dataInfo.uid === 1000 && await realpath(data) === data;
    if (!checks.data) return { ok: false, checks };
    const config = await readOwnedFile(preview, 32768, 0o600);
    checks.preview = validPreviewConfig(config);
    config.fill(0);
    if (!checks.preview) return { ok: false, checks };
    checks.release = await releaseDigest(release) === expectedReleaseManifest;
    if (!checks.release) return { ok: false, checks };
    const apk = `${release}/public/dhexbot-dev.apk`;
    checks.apk = createHash('sha256').update(await readOwnedFile(apk, 64 * 1024 * 1024)).digest('hex') === apkHash;
    if (!checks.apk) return { ok: false, checks };
    const databaseBefore = await lstat(database, { bigint: true });
    if (!databaseBefore.isFile() || databaseBefore.isSymbolicLink() || databaseBefore.nlink !== 1n ||
        databaseBefore.uid !== 1000n || await realpath(database) !== database) return { ok: false, checks };
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(database, { readOnly: true });
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
      for (const name of ['schedules', 'history']) {
        if (db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(name)?.type !== 'table') throw new Error('Invalid database schema');
      }
      const cutoff = new Date(Date.now() + 15 * 60000).toISOString();
      const due = db.prepare('SELECT count(*) AS n FROM schedules WHERE enabled=1 AND next_at IS NOT NULL AND (next_at<=? OR julianday(next_at) IS NULL)').get(cutoff).n;
      const pending = db.prepare("SELECT count(*) AS n FROM history WHERE status='pending'").get().n;
      checks.schedules = due === 0 && pending === 0;
    } finally { db?.close(); }
    const databaseAfter = await lstat(database, { bigint: true });
    if (databaseAfter.dev !== databaseBefore.dev || databaseAfter.ino !== databaseBefore.ino ||
        !databaseAfter.isFile() || databaseAfter.nlink !== 1n) return { ok: false, checks };
    if (!checks.schedules) return { ok: false, checks };
    const manifest = await safeInventory({ root: data, callerGuardAndRescan: true });
    const targets = inventoryInodes(manifest);
    const reader = createProcReader();
    const info = await reader.processInfo(pid);
    if (info.uid !== 1000) return { ok: false, checks };
    const census = await writerCensus({ reader, inventory: targets, selfPid: process.pid,
      expectedHolder: { pid, uid: info.uid, startTime: info.startTime }, skipSelfIfProven: true,
      proveNonWriter: other => other === process.pid ? selfDoesNotHold(targets) : false,
      limits: { timeoutMs: 15000 } });
    checks.dataWriters = census.complete === true && census.externalWriters === 1 && census.expectedIsSoleHolder === true;
    const last = await show();
    const after = await safeInventory({ root: data, callerGuardAndRescan: true });
    const lastInfo = await reader.processInfo(pid);
    checks.stable = activeService(last) && last.MainPID === first.MainPID && last.InvocationID === first.InvocationID &&
      lastInfo.uid === info.uid && lastInfo.startTime === info.startTime &&
      JSON.stringify(manifest) === JSON.stringify(after);
  } catch {}
  return { ok: names.every(name => checks[name]), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || !['--inspect', '--manifest'].includes(process.argv[2])) {
    process.stdout.write('READ_ONLY_INSPECTION_OR_MANIFEST_ONLY\n');
    process.exitCode = 2;
  } else if (process.argv[2] === '--manifest') {
    try { process.stdout.write(`${await releaseDigest(path.resolve(fileURLToPath(new URL('..', import.meta.url))))}\n`); }
    catch { process.stdout.write('MANIFEST_UNAVAILABLE\n'); process.exitCode = 1; }
  } else {
    const result = await inspectProduction();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
