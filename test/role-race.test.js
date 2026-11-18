import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('role endpoint fences reserved sends before dispatch and preserves in-flight and restart semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-role-race-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    let release, entered, sent = 0;
    let gate = new Promise(r => { release = r; });
    let waiting = new Promise(r => { entered = r; });
    const socket = { groupFetchAllParticipating: async () => { entered(); await gate; return { '12345@g.us': {} }; }, sendMessage: async () => { sent++; } };
    mock.module(new URL('./src/whatsapp.js', import.meta.url), { namedExports: {
      connect: async () => {}, fenceAccount: async () => {}, groups: async () => [], pairingCode: async () => '', repair: async () => {},
      socketFor: () => socket, state: () => ({ status: 'connected' }), whatsappContacts: () => []
    } });
    async function run() {
      const { db } = await import('./src/db.js');
      await import('./src/server.js');
      const base = 'http://127.0.0.1:' + process.env.PORT;
      for (let i = 0; i < 100; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 20)); } }
      const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
      assert.equal(login.status, 200);
      const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-dashboard-request': '1' };
      const role = (expectedRole, role) => fetch(base + '/api/accounts/a/role', { method: 'PUT', headers, body: JSON.stringify({ expectedRole, role }) });
      db.exec("INSERT INTO accounts(id,name,owner_id) VALUES ('a','A','legacy-admin')");
      const { tick } = await import('./src/worker.js');
      const now = Date.now() + 60000, due = new Date(now).toISOString();
      const insert = db.prepare("INSERT INTO schedules(id,account_id,jid,text,repeat,next_at,created_at) VALUES (?,'a','12345@g.us','x','once',?,?)");
      insert.run('s', due, due);
      const running = tick({ now });
      await waiting;
      assert.equal(db.prepare("SELECT status FROM history").get().status, 'pending');
      assert.equal((await role('ordinary', 'bot')).status, 200);
      assert.equal((await role('bot', 'ordinary')).status, 200);
      release(); await running;
      assert.equal(sent, 0);
      const result = db.prepare('SELECT status,detail FROM history').get();
      assert.equal(result.status, 'failed'); assert.match(result.detail, /dibatalkan/);
      assert.equal(db.prepare('SELECT count(*) n FROM history_events').get().n, 1);
      assert.equal(db.prepare("SELECT enabled FROM schedules WHERE id='s'").get().enabled, 0);
      gate = Promise.resolve();
      let finishSend, dispatched;
      const inFlight = new Promise(r => { finishSend = r; });
      const dispatchStarted = new Promise(r => { dispatched = r; });
      socket.sendMessage = async () => { sent++; dispatched(); await inFlight; };
      insert.run('s2', due, due);
      const running2 = tick({ now });
      await dispatchStarted;
      assert.equal((await role('ordinary', 'bot')).status, 200);
      finishSend(); await running2;
      assert.equal(sent, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM history WHERE status='success' AND scheduled_at IS NOT NULL").get().n, 1);
      socket.sendMessage = async () => { sent++; };
      const manual = await fetch(base + '/api/messages', { method: 'POST', headers, body: JSON.stringify({ accountId: 'a', jid: '12345@g.us', text: 'x' }) });
      assert.equal((await manual.json()).status, 'success'); assert.equal(sent, 2);
      db.prepare("INSERT INTO history VALUES ('pending','a','12345@g.us','x',?,?, 'pending','')").run(due, due);
    }
    run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  `;
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters' };
  try {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const restart = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { db } = await import('./src/db.js');
      const { recoverPending } = await import('./src/sender.js');
      recoverPending();
      assert.equal(db.prepare("SELECT role FROM accounts WHERE id='a'").get().role, 'bot');
      assert.equal(db.prepare("SELECT enabled FROM schedules WHERE id='s'").get().enabled, 0);
      assert.equal(db.prepare("SELECT status FROM history WHERE id='pending'").get().status, 'failed');
      assert.match(db.prepare("SELECT detail FROM history WHERE id='pending'").get().detail, /tidak dicoba ulang/);
      db.close();
    `], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(restart.status, 0, restart.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
