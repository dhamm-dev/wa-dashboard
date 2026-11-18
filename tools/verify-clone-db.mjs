import { DatabaseSync } from 'node:sqlite';
import { copyDbScratch } from './copy-db-scratch.mjs';
import { safeInventory, inodeGuard } from './safe-inventory.mjs';
import * as fs from 'node:fs/promises';

const failure = () => Object.assign(new Error('Verification failed; a private scratch copy may remain'), { code: 'EVERIFY' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const content = entries => entries.map(({ path, type, size, sha256 }) => ({ path, type, ...(type === 'regular' ? { size, sha256 } : {}) }));
const mutable = new Set(['dashboard.sqlite', 'dashboard.sqlite-shm']);

// The guard is a caller assertion, not a lock or proof of cross-process quiescence.
// The caller must keep both trees private and quiescent for the entire operation.
export async function verifyCloneDb(options = {}) {
  const { source, destination, isQuiescent, expectedPaths, maxDepth, maxFiles, maxEntries, maxBytes, forbiddenInodes, onBeforeOpen } = options;
  let bounds;
  const scan = root => safeInventory({ root, callerGuardAndRescan: true, ...bounds });
  let before;
  let result;
  let scratch;
  let failed = false;
  try {
    const guard = inodeGuard(forbiddenInodes, onBeforeOpen);
    bounds = { maxDepth, maxFiles, maxEntries, maxBytes, forbiddenInodes: guard.inodes, onBeforeOpen };
    if (typeof isQuiescent !== 'function' || !Array.isArray(expectedPaths) ||
        !expectedPaths.includes('dashboard.sqlite') || new Set(expectedPaths).size !== expectedPaths.length ||
        expectedPaths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\0') ||
          p.split('/').some(part => !part || part === '.' || part === '..'))) throw failure();
    if (await isQuiescent() !== true) throw failure();
    before = await scan(source);
    if (!same(before.slice(1).map(x => x.path).sort(), [...expectedPaths].sort()) ||
        !before.some(x => x.path === 'dashboard.sqlite' && x.type === 'regular')) throw failure();
    scratch = await copyDbScratch({ source, destination, manifest: before, forbiddenInodes: guard.inodes, onBeforeOpen });
    const scratchBefore = await scan(destination);
    const selected = before.filter(x => !x.path || ['dashboard.sqlite', 'dashboard.sqlite-wal', 'dashboard.sqlite-shm'].includes(x.path));
    if (!same(content(selected), content(scratchBefore))) throw failure();
    if (await isQuiescent() !== true) throw failure();
    let db;
    try {
      const dbStat = await fs.lstat(scratch.dbPath, { bigint: true });
      await guard.before(scratch.dbPath, dbStat);
      db = new DatabaseSync(scratch.dbPath, { readOnly: true });
      const dbAfter = await fs.lstat(scratch.dbPath, { bigint: true });
      guard.check(dbAfter);
      if (dbStat.dev !== dbAfter.dev || dbStat.ino !== dbAfter.ino) throw failure();
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
      const integrity = db.prepare('PRAGMA integrity_check(1)').all();
      if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw failure();
      const fk = db.prepare('PRAGMA foreign_key_check').iterate();
      try { if (!fk.next().done) throw failure(); } finally { fk.return(); }
      const counts = {};
      for (const table of ['accounts', 'schedules']) {
        const schema = db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(table);
        if (!schema || schema.type !== 'table') throw failure();
        const statement = db.prepare(`SELECT count(*) AS count FROM "${table}"`);
        statement.setReadBigInts(true);
        counts[table] = statement.get().count.toString();
      }
      result = { counts };
    } finally { if (db) db.close(); }
    const scratchAfter = await scan(destination);
    const fixed = entries => content(entries.filter(x => x.path && !mutable.has(x.path)));
    if (!scratchAfter.some(x => x.path === 'dashboard.sqlite' && x.type === 'regular') ||
        !same(fixed(scratchBefore), fixed(scratchAfter)) ||
        scratchAfter.some(x => mutable.has(x.path) && x.type !== 'regular')) throw failure();
    await scratch.verify();
  } catch { failed = true; }
  finally { if (scratch) await scratch.close(); }
  if (before) {
    try {
      if (await isQuiescent() !== true || !same(before, await scan(source)) || await isQuiescent() !== true) failed = true;
    } catch { failed = true; }
  }
  if (failed) throw failure();
  return result;
}
