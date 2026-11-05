import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('schedule controls follow delivery mode and reject past times before upload', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', files: [], handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, focus() { this.focused = true; } });
    return nodes.get(id);
  };
  const errors = [], requests = [];
  const context = vm.createContext({ $: get, Date, Number, FormData, accounts: [], run: fn => Promise.resolve().then(fn).catch(e => errors.push(e.message)), api: (...args) => requests.push(args), post: (...args) => requests.push(args) });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf("$('repeat').addEventListener"), source.indexOf("$('account-form').addEventListener")), context);
  vm.runInContext(source.slice(source.indexOf("$('message-form').addEventListener"), source.indexOf('run(async () => { try { const session')), context);
  get('repeat').value = 'weekly';
  get('repeat').handlers.change();
  assert.equal(get('schedule-time').hidden, false);
  assert.equal(get('at').required, true);
  get('at').value = '2000-01-01T12:00';
  get('file').files = [new Blob(['test'])];
  get('message-form').handlers.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(errors[0], /akan datang/);
  assert.equal(get('schedule-options').open, true);
  assert.equal(get('at').focused, true);
  assert.equal(requests.length, 0);
  get('repeat').value = 'now';
  get('repeat').handlers.change();
  assert.equal(get('schedule-time').hidden, true);
  assert.equal(get('at').required, false);
});

test('message result dialog follows mocked request outcomes and closes', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', files: [], handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  let resolveRequest, rejectRequest;
  const notifications = [];
  const context = vm.createContext({ $: get, Date, Number, FormData, accounts: [], active: true, sessionVersion: 1,
    run: fn => Promise.resolve().then(fn), post: () => new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; }),
    addNotification: (...args) => notifications.push(args), loadSchedules: async () => {}, loadHistory: async () => {} });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function messageResult('), source.indexOf('run(async () => { try { const session')), context);
  const submit = async outcome => {
    get('message').value = 'Isi';
    get('message-form').handlers.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(get('message-result').open, true);
    if (outcome instanceof Error) rejectRequest(outcome); else resolveRequest(outcome);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(get('message-result').open, true);
  };
  get('repeat').value = 'now';
  await submit({ status: 'success' });
  assert.match(get('message-result-detail').textContent, /bukan bukti diterima atau dibaca/);
  assert.equal(get('message-result-check').hidden, false);
  get('message-result-close').handlers.click();
  assert.equal(get('message-result').open, false);
  await submit({ status: 'failed', detail: 'Koneksi terputus' });
  assert.match(get('message-result-title').textContent, /gagal/i);
  assert.equal(get('message-result-check').hidden, true);
  assert.equal(get('message').value, 'Isi');
  get('message-result-close').handlers.click();
  await submit(new Error('Jaringan gagal'));
  assert.match(get('message-result-detail').textContent, /Jaringan gagal/);
  assert.equal(get('message-result-check').hidden, true);
  get('message-result-close').handlers.click();
  get('repeat').value = 'once'; get('at').value = '2099-01-01T12:00';
  await submit({ status: 'scheduled' });
  assert.match(get('message-result-title').textContent, /Jadwal disimpan/);
  assert.equal(get('message-result-check').hidden, false);
  assert.equal(notifications.length, 1);
});
