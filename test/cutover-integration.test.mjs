import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { runCutover } from '../tools/cutover-machine.mjs';
import { safeInventory } from '../tools/safe-inventory.mjs';
import { safeClone } from '../tools/safe-clone.mjs';
import { verifyCloneDb } from '../tools/verify-clone-db.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const scan = root => safeInventory({ root, callerGuardAndRescan: true });
const content = entries => entries.map(({ path, type, size, sha256 }) => ({ path, type, size, sha256 }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('synthetic cutover and failure recovery', async t => {
  // Retained deliberately: all contents are synthetic, and no files are removed.
  const parent = await fs.mkdtemp(path.join(project, '.cutover-integration-'));
  for (const scenario of ['success', 'before-copy', 'during-copy', 'after-copy', 'validation',
    'safe-stop', 'dropin', 'preview-health', 'preview-stop']) {
    await t.test(scenario, async () => {
      const root = path.join(parent, scenario);
      await fs.mkdir(root, { mode: 0o700 });
      const source = path.join(root, 'original');
      const clone = path.join(root, 'clone');
      const scratch = path.join(root, 'scratch');
      await fs.mkdir(source, { mode: 0o700 });
      await fs.mkdir(path.join(source, 'sessions'));
      await fs.writeFile(path.join(source, 'sessions', 'fake-session'), 'synthetic session');
      const db = new DatabaseSync(path.join(source, 'dashboard.sqlite'));
      db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE schedules(id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), jid TEXT NOT NULL,
          text TEXT NOT NULL, attachment_id TEXT, repeat TEXT NOT NULL, next_at TEXT, created_at TEXT NOT NULL);
        INSERT INTO accounts VALUES ('fixture', 'Fixture');
        INSERT INTO schedules VALUES ('schedule', 'fixture', 'fake', 'fake', NULL, 'once', NULL, '2020');`);
      db.close();
      const original = await scan(source);
      const calls = [];
      const live = new Set(['old']);
      let refs = 'old';
      let child;
      let exited;
      let stderr = '';
      let safeHealth = false;
      const start = name => { assert.equal(live.size, 0, `overlap starting ${name}`); live.add(name); };
      const stopChild = async () => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        if (exited) await exited;
        live.delete('safe');
      };
      const ops = {
        preflight: async () => { assert.deepEqual(await scan(source), original); },
        stopOld: async () => { assert.ok(live.delete('old')); },
        clone: async () => {
          if (scenario === 'before-copy') throw Error('injected');
          await safeClone({ source, destination: clone, isQuiescent: async () => live.size === 0,
            onChunk: scenario === 'during-copy' ? async () => { throw Error('injected'); } : undefined });
          assert.deepEqual(content(await scan(clone)), content(original));
          if (scenario === 'after-copy') throw Error('injected');
        },
        validate: async () => {
          const expectedPaths = (await scan(clone)).slice(1).map(entry => entry.path);
          const result = await verifyCloneDb({ source: clone, destination: scratch, expectedPaths,
            isQuiescent: async () => live.size === 0 });
          assert.deepEqual(result.counts, { accounts: '1', schedules: '1' });
          if (scenario === 'validation') throw Error('injected');
        },
        startSafe: async () => {
          start('safe');
          const port = await freePort();
          const script = `import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module';
            net.Socket.prototype.connect = () => { throw Error('outbound socket'); }; syncBuiltinESMExports();
            globalThis.fetch = () => { throw Error('outbound fetch'); }; await import('./src/server.js');`;
          child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            cwd: project, env: { PATH: process.env.PATH, HOME: root, DATA_DIR: clone, HOST: '127.0.0.1',
              PORT: String(port), DHEXBOT_SAFE_BOOT: '1', DHEXBOT_PRIVATE_PREVIEW: '1' },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          child.stderr.on('data', chunk => { stderr += chunk; });
          exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
          let response;
          for (let i = 0; i < 150 && child.exitCode === null && child.signalCode === null; i++) {
            try { response = await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await delay(50); }
          }
          assert.ok(response, `safe boot failed: ${stderr}`);
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), { safeBoot: true });
          safeHealth = true;
        },
        stopSafe: async () => {
          if (scenario === 'safe-stop') throw Object.assign(Error('unknown termination'), { code: 'OPERATION_UNCONFIRMED' });
          await stopChild();
        },
        installPreview: async () => { refs = 'preview'; if (scenario === 'dropin') throw Error('injected'); },
        startPreview: async () => { assert.equal(refs, 'preview'); start('preview'); },
        health: async () => { if (scenario === 'preview-health' || scenario === 'preview-stop') throw Error('injected'); },
        stopPreview: async () => {
          if (scenario === 'preview-stop') throw Object.assign(Error('unknown termination'), { code: 'OPERATION_UNCONFIRMED' });
          assert.ok(live.delete('preview'));
        },
        restoreOld: async () => { refs = 'old'; },
        startOld: async () => { assert.equal(refs, 'old'); start('old'); },
      };
      const wrapped = Object.fromEntries(Object.entries(ops).map(([name, fn]) => [name, async context => {
        calls.push(name); await fn(context);
      }]));
      try {
        const result = await runCutover(wrapped, { timeoutMs: 15000 });
        const expected = {
          success: ['preflight','stopOld','clone','validate','startSafe','stopSafe','installPreview','startPreview','health'],
          'before-copy': ['preflight','stopOld','clone','startOld'],
          'during-copy': ['preflight','stopOld','clone','startOld'],
          'after-copy': ['preflight','stopOld','clone','startOld'],
          validation: ['preflight','stopOld','clone','validate','startOld'],
          'safe-stop': ['preflight','stopOld','clone','validate','startSafe','stopSafe'],
          dropin: ['preflight','stopOld','clone','validate','startSafe','stopSafe','installPreview','restoreOld','startOld'],
          'preview-health': ['preflight','stopOld','clone','validate','startSafe','stopSafe','installPreview','startPreview','health','stopPreview','restoreOld','startOld'],
          'preview-stop': ['preflight','stopOld','clone','validate','startSafe','stopSafe','installPreview','startPreview','health','stopPreview'],
        };
        assert.deepEqual(calls, expected[scenario]);
        assert.equal(result.status, scenario === 'success' ? 'completed' :
          ['safe-stop', 'preview-stop'].includes(scenario) ? 'unconfirmed' : 'rolled-back');
        assert.deepEqual([...live], [scenario === 'success' || scenario === 'preview-stop' ? 'preview' : scenario === 'safe-stop' ? 'safe' : 'old']);
        assert.deepEqual(await scan(source), original);
        assert.equal(await fs.readFile(path.join(source, 'sessions', 'fake-session'), 'utf8'), 'synthetic session');
        if (!['before-copy', 'during-copy'].includes(scenario)) {
          assert.equal(await fs.readFile(path.join(clone, 'sessions', 'fake-session'), 'utf8'), 'synthetic session');
        }
        if (safeHealth) {
          const migrated = new DatabaseSync(path.join(clone, 'dashboard.sqlite'), { readOnly: true });
          try { assert.ok(migrated.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'owner_id')); }
          finally { migrated.close(); }
          assert.deepEqual(await scan(source), original);
          assert.notDeepEqual(content(await scan(clone)), content(original));
        }
      } finally {
        await stopChild();
      }
    });
  }
});
