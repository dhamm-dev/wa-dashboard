import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

test('startup requires a non-empty password and a session secret of at least 32 characters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-config-'));
  try {
    for (const [password, secret] of [[undefined, 's'.repeat(32)], ['', 's'.repeat(32)], ['x', undefined], ['x', ''], ['x', 's'.repeat(31)]]) {
      const env = { ...process.env, DATA_DIR: dir, ADMIN_PASSWORD: password, SESSION_SECRET: secret };
      if (password === undefined) delete env.ADMIN_PASSWORD;
      if (secret === undefined) delete env.SESSION_SECRET;
      const result = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /ADMIN_PASSWORD wajib diisi dan SESSION_SECRET minimal 32 karakter wajib diatur/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('login, CSRF guard, templates, filters and upload validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-server-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { await fetch(base); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(ready, output);
    assert.equal((await fetch(`${base}/api/templates`)).status, 401);
    assert.equal((await fetch(`${base}/api/accounts`)).status, 401);
    assert.equal((await fetch(`${base}/api/accounts/a/groups`)).status, 401);
    assert.equal((await fetch(`${base}/api/accounts/a/whatsapp-contacts`)).status, 401);
    assert.equal((await fetch(`${base}/api/contacts?accountId=a`)).status, 401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, 'content-type': 'application/json' };
    const accounts = await fetch(`${base}/api/accounts`, { headers });
    assert.equal(accounts.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/api/templates`, { method: 'POST', headers, body: '{}' })).status, 403);
    headers['x-dashboard-request'] = '1';
    assert.equal((await fetch(`${base}/api/templates`, { method: 'POST', headers, body: JSON.stringify({ name: 'Pengingat', text: 'Pesan' }) })).status, 201);
    const templates = await (await fetch(`${base}/api/templates`, { headers })).json();
    assert.equal(templates[0].text, 'Pesan');
    assert.deepEqual(await (await fetch(`${base}/api/history?status=failed`, { headers })).json(), []);
    assert.equal((await fetch(`${base}/api/messages`, { method: 'POST', headers, body: JSON.stringify({ accountId: '../x', jid: 'invalid', text: 'x' }) })).status, 400);
    const body = new FormData(); body.append('accountId', '../x'); body.append('file', new Blob(['bad'], { type: 'application/pdf' }), 'x.pdf');
    assert.equal((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body })).status, 400);
    const seed = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    seed.prepare('INSERT INTO accounts VALUES (?,?)').run('a', 'A');
    seed.prepare('INSERT INTO accounts VALUES (?,?)').run('b', 'B');
    const hist = seed.prepare('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)');
    const event = seed.prepare('INSERT INTO history_events(history_id) VALUES (?)');
    for (let i = 0; i < 205; i++) { hist.run(`event-${i}`, i % 2 ? 'a' : 'b', '62812345678@s.whatsapp.net', 'pesan', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'missed', 'terlewat'); event.run(`event-${i}`); }
    seed.close();
    const baseline = await (await fetch(`${base}/api/history-events`, { headers })).json();
    assert.equal(baseline.cursor, 205);
    assert.deepEqual(baseline.events, []);
    const page1 = await (await fetch(`${base}/api/history-events?cursor=0`, { headers })).json();
    const page2 = await (await fetch(`${base}/api/history-events?cursor=${page1.cursor}`, { headers })).json();
    const page3 = await (await fetch(`${base}/api/history-events?cursor=${page2.cursor}`, { headers })).json();
    assert.deepEqual([page1.events.length, page2.events.length, page3.events.length], [100, 100, 5]);
    assert.deepEqual([page1.hasMore, page2.hasMore, page3.hasMore], [true, true, false]);
    assert.equal(new Set([...page1.events, ...page2.events, ...page3.events].map(e => e.id)).size, 205);
    assert.equal((await fetch(`${base}/api/history-events?cursor=-1`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/history-events?cursor=0`)).status, 401);
    const contacts = await fetch(`${base}/api/contacts?accountId=a`, { headers });
    assert.equal(contacts.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await contacts.json(), []);
    const waContacts = await fetch(`${base}/api/accounts/a/whatsapp-contacts`, { headers });
    assert.equal(waContacts.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await waContacts.json(), []);
    assert.equal((await fetch(`${base}/api/accounts/missing/whatsapp-contacts`, { headers })).status, 400);
    const bad = new FormData(); bad.append('accountId', 'a'); bad.append('file', new Blob(['bad'], { type: 'application/pdf' }), 'x.pdf');
    assert.equal((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body: bad })).status, 400);
    const good = new FormData(); good.append('accountId', 'a'); good.append('file', new Blob(['%PDF-test'], { type: 'application/octet-stream' }), '../../danger.pdf');
    const upload = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body: good });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.ok(uploaded.name.endsWith('.pdf'));
    assert.ok(!uploaded.name.includes('/'));
    assert.equal((await fetch(`${base}/uploads/${uploaded.id}`, { headers })).status, 404);
    const textFile = new FormData(); textFile.append('accountId', 'a'); textFile.append('file', new Blob(['isi teks'], { type: 'application/octet-stream' }), 'catatan.txt');
    assert.equal((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body: textFile })).status, 201);
    const doc = new FormData(); doc.append('accountId', 'a'); doc.append('file', new Blob([new Uint8Array([0x50,0x4b,0x03,0x04])]), 'dokumen.docx');
    assert.equal((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body: doc })).status, 201);
    const exe = new FormData(); exe.append('accountId', 'a'); exe.append('file', new Blob(['MZ executable']), 'run.exe');
    assert.equal((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body: exe })).status, 400);
    const tooLarge = new FormData(); tooLarge.append('accountId', 'a'); tooLarge.append('file', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), 'besar.txt');
    assert.equal((await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie, 'x-dashboard-request': '1' }, body: tooLarge })).status, 400);
    assert.equal((await fetch(`${base}/api/messages`, { method: 'POST', headers, body: JSON.stringify({ accountId: 'b', jid: '62812345678@s.whatsapp.net', attachmentId: uploaded.id }) })).status, 400);
    const sent = await (await fetch(`${base}/api/messages`, { method: 'POST', headers, body: JSON.stringify({ accountId: 'a', jid: '62812345678@s.whatsapp.net', text: 'uji' }) })).json();
    assert.equal(sent.status, 'failed');
    const failed = await (await fetch(`${base}/api/history?accountId=a&status=failed`, { headers })).json();
    assert.equal(failed.length, 1);
    const request = (path, method, data) => fetch(`${base}${path}`, { method, headers, body: JSON.stringify(data) });
    const future = new Date(Date.now() + 10 * 86400000 + 7 * 3600000).toISOString().slice(0, 16);
    const datePart = future.slice(0, 10);
    assert.equal((await request('/api/messages', 'POST', { accountId: 'a', jid: '62812345678@s.whatsapp.net', text: 'jadwal', repeat: 'weekly', at: future, attachmentId: uploaded.id })).status, 201);
    let list = await (await fetch(`${base}/api/schedules?accountId=a&destination=123&status=active&from=${datePart}&to=${datePart}`, { headers })).json();
    assert.equal(list.length, 1);
    const id = list[0].id;
    assert.equal((await request(`/api/schedules/${id}/enabled`, 'POST', { revision: list[0].revision, enabled: false })).status, 200);
    assert.equal((await request(`/api/schedules/${id}/enabled`, 'POST', { revision: list[0].revision, enabled: true })).status, 409);
    list = await (await fetch(`${base}/api/schedules?status=inactive`, { headers })).json();
    assert.equal(list.length, 1);
    const edited = { revision: list[0].revision, accountId: 'b', jid: '62812345679@s.whatsapp.net', text: 'ubah', repeat: 'once', at: future, attachmentId: uploaded.id };
    assert.equal((await request(`/api/schedules/${id}`, 'PUT', edited)).status, 400);
    edited.attachmentId = null;
    assert.equal((await request(`/api/schedules/${id}`, 'PUT', edited)).status, 200);
    list = await (await fetch(`${base}/api/schedules?accountId=b&destination=679&status=inactive`, { headers })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].text, 'ubah');
    assert.equal((await request(`/api/schedules/${id}/enabled`, 'POST', { revision: list[0].revision, enabled: true })).status, 200);
    list = await (await fetch(`${base}/api/schedules?status=active`, { headers })).json();
    assert.equal(list.length, 1);
    assert.equal((await request(`/api/schedules/${id}`, 'DELETE', { revision: list[0].revision })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/schedules`, { headers })).json(), []);
    assert.equal((await request(`/api/schedules/${id}`, 'DELETE', { revision: list[0].revision })).status, 404);
    const paused = new DatabaseSync(join(dir, 'dashboard.sqlite'));
    const past = new Date(Date.now() - 15 * 86400000).toISOString();
    const insert = paused.prepare('INSERT INTO schedules(id,account_id,jid,text,repeat,next_at,created_at,enabled) VALUES (?,?,?,?,?,?,?,0)');
    insert.run('old-weekly', 'a', '62812345678@s.whatsapp.net', 'x', 'weekly', past, past);
    insert.run('old-once', 'a', '62812345678@s.whatsapp.net', 'x', 'once', past, past);
    insert.run('old-null', 'a', '62812345678@s.whatsapp.net', 'x', 'once', null, past);
    paused.close();
    assert.equal((await request('/api/schedules/old-weekly/enabled', 'POST', { revision: 0, enabled: true })).status, 200);
    assert.equal((await request('/api/schedules/old-once/enabled', 'POST', { revision: 0, enabled: true })).status, 400);
    assert.equal((await request('/api/schedules/old-null/enabled', 'POST', { revision: 0, enabled: true })).status, 400);
    const resumed = await (await fetch(`${base}/api/schedules?status=active`, { headers })).json();
    assert.equal(resumed.length, 1);
    assert.ok(Date.parse(resumed[0].next_at) > Date.now());
    assert.equal((await (await fetch(`${base}/api/history?accountId=a&status=failed`, { headers })).json()).length, 1);
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
