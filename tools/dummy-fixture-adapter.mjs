import * as nativeFs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as sqlite from 'node:sqlite';

const home = '/home/dhexct528dec24';
const pattern = /^\/home\/dhexct528dec24\/\.dummy-db-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/;
const fail = () => Object.assign(new Error('Dummy DB operation unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });
const safe = (n, min = 0) => Number.isSafeInteger(n) && n >= min;

export function createDummyFixtureAdapter(options = {}) {
  const fs = options.fs ?? nativeFs;
  const Database = options.Database ?? sqlite.DatabaseSync;
  const backup = options.backup ?? sqlite.backup;
  const getuid = options.getuid ?? process.getuid;
  const created = new Map();
  const c = fs.constants;
  const checkFile = s => {
    if (!s.isFile() || s.uid !== 999 || s.gid !== 983 || (s.mode & 0o7777) !== 0o600 ||
        s.nlink !== 1 || !safe(s.dev) || !safe(s.ino, 1)) throw fail();
  };
  const checkHome = s => {
    if (!s.isDirectory() || s.uid !== 999 || (s.mode & 0o7777) !== 0o700) throw fail();
  };
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const stable = (a, b) => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  return async request => {
    let dir, fd, db, tmp, scratch, scratchFile, scratchName, scratchIdentity, scratchDirIdentity;
    const cleanScratch = () => {
      if (scratch !== undefined && scratchIdentity) {
        for (const name of ['fixture.sqlite-journal', 'fixture.sqlite-wal', 'fixture.sqlite-shm', 'fixture.sqlite']) {
          const p = `/proc/self/fd/${scratch}/${name}`;
          let s;
          try { s = fs.lstatSync(p); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || (name === 'fixture.sqlite' && !same(s, scratchIdentity))) throw fail();
          fs.unlinkSync(p);
        }
      }
      if (scratchFile !== undefined) { fs.closeSync(scratchFile); scratchFile = undefined; }
      if (scratch !== undefined) { fs.closeSync(scratch); scratch = undefined; }
      if (tmp !== undefined && scratchName && scratchDirIdentity) {
        const p = `/proc/self/fd/${tmp}/${scratchName}`;
        const s = fs.lstatSync(p);
        if (!s.isDirectory() || !same(s, scratchDirIdentity)) throw fail();
        fs.rmdirSync(p);
        scratchDirIdentity = undefined;
      }
      if (tmp !== undefined) { fs.closeSync(tmp); tmp = undefined; }
    };
    try {
      if (!request || request.synthetic !== true || typeof request.path !== 'string' || !pattern.test(request.path) ||
          !['create-fixture', 'hash'].includes(request.kind)) throw fail();
      if (request.kind === 'create-fixture' && (request.account?.name !== 'dhexct528dec24' ||
          request.account.uid !== 999 || request.account.gid !== 983 || getuid() !== 0 || created.has(request.path))) throw fail();
      const parent = fs.lstatSync('/home');
      if (!parent.isDirectory()) throw fail();
      const beforeHome = fs.lstatSync(home);
      checkHome(beforeHome);
      dir = fs.openSync(home, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
      checkHome(fs.fstatSync(dir));
      if (!same(beforeHome, fs.fstatSync(dir))) throw fail();
      const local = `/proc/self/fd/${dir}/${request.path.slice(home.length + 1)}`;
      if (request.kind === 'create-fixture') {
        if (typeof backup !== 'function') throw fail();
        fd = fs.openSync(local, c.O_CREAT | c.O_EXCL | c.O_RDWR | c.O_NOFOLLOW, 0o600);
        fs.fchownSync(fd, 999, 983);
        checkFile(fs.fstatSync(fd));
        const tmpStat = fs.lstatSync('/tmp');
        if (!tmpStat.isDirectory() || tmpStat.uid !== 0 || (tmpStat.mode & 0o1000) === 0) throw fail();
        tmp = fs.openSync('/tmp', c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
        if (!same(tmpStat, fs.fstatSync(tmp))) throw fail();
        scratchName = `dummy-sqlite-${randomUUID()}`;
        const scratchPath = `/proc/self/fd/${tmp}/${scratchName}`;
        fs.mkdirSync(scratchPath, 0o700);
        const scratchStat = fs.lstatSync(scratchPath);
        if (!scratchStat.isDirectory() || scratchStat.uid !== 0 || (scratchStat.mode & 0o7777) !== 0o700) throw fail();
        scratchDirIdentity = { dev: scratchStat.dev, ino: scratchStat.ino };
        scratch = fs.openSync(scratchPath, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
        if (!same(scratchStat, fs.fstatSync(scratch))) throw fail();
        const backupPath = `/proc/self/fd/${scratch}/fixture.sqlite`;
        scratchFile = fs.openSync(backupPath, c.O_CREAT | c.O_EXCL | c.O_RDWR | c.O_NOFOLLOW, 0o600);
        const initialScratch = fs.fstatSync(scratchFile);
        if (!initialScratch.isFile() || initialScratch.uid !== 0 || initialScratch.nlink !== 1 ||
            (initialScratch.mode & 0o7777) !== 0o600) throw fail();
        scratchIdentity = { dev: initialScratch.dev, ino: initialScratch.ino };
        db = new Database(':memory:');
        db.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO fixture VALUES (1, 'synthetic');");
        await backup(db, backupPath);
        db.close();
        db = undefined;
        const backupStat = fs.fstatSync(scratchFile);
        const backupNamed = fs.lstatSync(backupPath);
        if (!backupStat.isFile() || !backupNamed.isFile() || backupStat.uid !== 0 || backupNamed.uid !== 0 ||
            backupStat.nlink !== 1 || backupNamed.nlink !== 1 || (backupNamed.mode & 0o7777) !== 0o600 ||
            (backupStat.mode & 0o7777) !== 0o600 || !same(backupStat, scratchIdentity) ||
            !stable(backupStat, backupNamed) || !safe(backupStat.size, 1) ||
            fs.readdirSync(`/proc/self/fd/${scratch}`).join(',') !== 'fixture.sqlite') throw fail();
        const buffer = Buffer.alloc(65536);
        let offset = 0;
        while (offset < backupStat.size) {
          const count = fs.readSync(scratchFile, buffer, 0, Math.min(buffer.length, backupStat.size - offset), offset);
          if (!safe(count, 1) || count > buffer.length) throw fail();
          let written = 0;
          while (written < count) {
            const n = fs.writeSync(fd, buffer, written, count - written, offset + written);
            if (!safe(n, 1) || n > count - written) throw fail();
            written += n;
          }
          offset += count;
        }
        if (!stable(backupStat, fs.fstatSync(scratchFile)) || !stable(backupStat, fs.lstatSync(backupPath))) throw fail();
        const stat = fs.fstatSync(fd);
        checkFile(stat);
        const named = fs.lstatSync(local);
        checkFile(named);
        if (!same(stat, named)) throw fail();
        cleanScratch();
        created.set(request.path, { dev: stat.dev, ino: stat.ino });
        return { synthetic: true, path: request.path, dev: stat.dev, ino: stat.ino, uid: 999, gid: 983,
          mode: 0o600, regular: true, symlink: false, sqlite: true };
      }
      const identity = created.get(request.path);
      if (!identity || !request.identity || !same(identity, request.identity)) throw fail();
      const named = fs.lstatSync(local);
      checkFile(named);
      if (!same(named, identity)) throw fail();
      fd = fs.openSync(local, c.O_RDONLY | c.O_NOFOLLOW);
      const before = fs.fstatSync(fd);
      checkFile(before);
      if (!same(before, identity) || !stable(named, before)) throw fail();
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(65536);
      let position = 0;
      for (;;) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, position);
        if (!safe(n) || n > buffer.length) throw fail();
        if (!n) break;
        hash.update(buffer.subarray(0, n));
        position += n;
        if (!safe(position) || position > before.size) throw fail();
      }
      const after = fs.fstatSync(fd);
      const namedAfter = fs.lstatSync(local);
      checkFile(after);
      checkFile(namedAfter);
      if (position !== before.size || !stable(before, after) || !stable(after, namedAfter)) throw fail();
      return { synthetic: true, path: request.path, ...identity, sha256: hash.digest('hex') };
    } catch {
      throw fail();
    } finally {
      if (db) { try { db.close(); } catch {} }
      try { cleanScratch(); } catch {}
      if (scratchFile !== undefined) { try { fs.closeSync(scratchFile); } catch {} }
      if (scratch !== undefined) { try { fs.closeSync(scratch); } catch {} }
      if (tmp !== undefined) { try { fs.closeSync(tmp); } catch {} }
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (dir !== undefined) { try { fs.closeSync(dir); } catch {} }
    }
  };
}
