import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('navigation and polling preserve cursor, deduplicate and reject stale sessions', async () => {
  const nodes = new Map();
  const links = ['pesan', 'jadwal', 'riwayat', 'akun', 'kontak', 'template'].map(id => ({ href: `#${id}`, attrs: {}, getAttribute() { return this.href; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } }));
  const node = () => ({ children: [], addEventListener() {}, replaceChildren() { this.children = []; }, set textContent(v) { this.text = v; }, get textContent() { return this.text; } });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const calls = [];
  const pages = [];
  const context = vm.createContext({
    $: get, document: { querySelectorAll: () => links }, window: { addEventListener() {} }, location: { hash: '#jadwal' },
    api: url => { calls.push(url); return new Promise((resolve, reject) => pages.push({ resolve, reject })); },
    row: (list, title, details) => list.children.push({ title, details }), notice() {}, date: s => s
  });
  vm.runInContext("let active=true, sessionVersion=1, eventCursor=7, eventPolling=false, notifications=[], accounts=[{id:'a',name:'A'}];", context);
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const views ='), source.indexOf("$('login-form').addEventListener")), context);
  assert.equal(get('jadwal').hidden, false);
  assert.equal(get('pesan').hidden, true);
  assert.equal(links[1].attrs['aria-current'], 'page');
  context.location.hash = '#riwayat'; vm.runInContext('renderView()', context);
  assert.equal(get('riwayat').hidden, false);
  assert.equal(links[2].attrs['aria-current'], 'page');
  for (const id of ['pesan', 'jadwal', 'riwayat', 'akun', 'kontak', 'template']) {
    context.location.hash = `#${id}`; vm.runInContext('renderView()', context);
    assert.deepEqual(['pesan', 'jadwal', 'riwayat', 'akun', 'kontak', 'template'].filter(view => !get(view).hidden), [id]);
  }
  context.location.hash = '#unknown'; vm.runInContext('renderView()', context);
  assert.equal(get('pesan').hidden, false);
  const first = vm.runInContext('pollEvents()', context);
  await vm.runInContext('pollEvents()', context);
  assert.equal(calls.length, 1);
  pages.shift().resolve({ cursor: 8, hasMore: true, events: [{ id: 'x', account_id: 'a', jid: 'nomor', scheduled_at: 'waktu', status: 'success' }] });
  await new Promise(resolve => setImmediate(resolve));
  pages.shift().resolve({ cursor: 9, hasMore: false, events: [{ id: 'y', account_id: 'a', jid: 'nomor', scheduled_at: 'waktu', status: 'missed' }] });
  await first;
  assert.equal(get('notification-list').children.length, 2);
  assert.match(calls[1], /cursor=8/);
  const failed = vm.runInContext('pollEvents()', context); pages.shift().reject(new Error('offline')); await failed;
  const retry = vm.runInContext('pollEvents()', context);
  assert.match(calls.at(-1), /cursor=9/);
  pages.shift().resolve({ cursor: 9, hasMore: false, events: [] }); await retry;
  assert.equal(get('notification-list').children.length, 2);
  const stale = vm.runInContext('pollEvents()', context);
  vm.runInContext('active=false; sessionVersion++; notifications=[]', context);
  pages.shift().resolve({ cursor: 10, hasMore: false, events: [{ id: 'z', status: 'failed' }] }); await stale;
  assert.equal(vm.runInContext('notifications.length', context), 0);
});
