import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function nodes() {
  const map = new Map();
  const get = id => {
    if (!map.has(id)) map.set(id, { value: '', files: [], handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {}, replaceChildren() {}, querySelectorAll() { return []; } });
    return map.get(id);
  };
  return get;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('message upload freezes destination and content and blocks duplicate submission', async () => {
  const $ = nodes(), upload = deferred(), calls = [];
  const context = vm.createContext({ $, Date, Number, FormData, active: true, sessionVersion: 1, accounts: [], run: fn => Promise.resolve().then(fn), api: () => upload.promise, post: async (url, body) => { calls.push({ url, body }); return { status: 'scheduled' }; }, messageResult() {}, addNotification() {}, loadSchedules: async () => {}, loadHistory: async () => {} });
  vm.runInContext(source.slice(source.indexOf("$('message-form').addEventListener"), source.indexOf('run(async () => { try { const session')), context);
  $('account').value = 'account-a'; $('destination').value = 'destination-a'; $('message').value = 'first'; $('repeat').value = 'once'; $('at').value = '2099-01-01T12:00'; $('file').files = [new Blob(['x'])];
  const submit = () => $('message-form').handlers.submit({ preventDefault() {} });
  submit(); await tick(); $('destination').value = 'destination-b'; $('message').value = 'second'; $('at').value = '2099-02-01T12:00'; submit();
  upload.resolve({ id: 'attachment-a' }); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].body.jid, 'destination-a'); assert.equal(calls[0].body.text, 'first'); assert.equal(calls[0].body.at, '2099-01-01T12:00'); assert.equal(calls[0].body.attachmentId, 'attachment-a'); assert.equal($('message').value, 'second');
});

test('schedule upload retains original identity and stops on session change', async () => {
  const $ = nodes(), upload = deferred(), calls = [];
  const context = vm.createContext({ $, FormData, active: true, sessionVersion: 1, editing: { id: 'one', revision: 3, attachment_id: null }, run: fn => Promise.resolve().then(fn), api: async (url, options) => { if (url === '/api/attachments') return upload.promise; calls.push({ url, body: options.body }); }, notice() {}, loadSchedules: async () => {} });
  vm.runInContext(source.slice(source.indexOf("$('schedule-edit-form').addEventListener"), source.indexOf('const botUrl')), context);
  $('edit-account').value = 'account-a'; $('edit-jid').value = 'recipient-a'; $('edit-text').value = 'first'; $('edit-repeat').value = 'once'; $('edit-at').value = '2099-01-01T12:00'; $('edit-file').files = [new Blob(['x'])];
  $('schedule-edit-form').handlers.submit({ preventDefault() {} }); await tick();
  vm.runInContext("editing = { id: 'two', revision: 8 }", context); $('edit-jid').value = 'recipient-b'; upload.resolve({ id: 'attachment-a' }); await tick();
  assert.equal(calls[0].url, '/api/schedules/one'); assert.equal(calls[0].body.revision, 3); assert.equal(calls[0].body.jid, 'recipient-a'); assert.equal(vm.runInContext('editing.id', context), 'two');
  const next = deferred(); context.api = async url => url === '/api/attachments' ? next.promise : calls.push({ url });
  $('schedule-edit-form').handlers.submit({ preventDefault() {} }); await tick(); vm.runInContext('sessionVersion++', context); next.resolve({ id: 'attachment-b' }); await tick(); assert.equal(calls.length, 1);
});

test('model responses cannot cross same-account reselection or session change', async () => {
  const $ = nodes(), pending = [];
  const context = vm.createContext({ $, active: true, sessionVersion: 1, botRequest: 1, botKeys: [], run: fn => Promise.resolve().then(fn), post: () => { const d = deferred(); pending.push(d); return d.promise; }, api: async () => ({}), clearBotKeys() {} });
  vm.runInContext(source.slice(source.indexOf('const botUrl'), source.indexOf('function messageResult')), context);
  $('bot-account').value = 'one'; $('bot-models').handlers.click(); await tick();
  vm.runInContext('botRequest += 2', context); $('bot-model-list').textContent = 'new selection'; pending.shift().resolve({ models: [{ name: 'stale' }] }); await tick(); assert.equal($('bot-model-list').textContent, 'new selection');
  $('bot-models').handlers.click(); await tick(); vm.runInContext('sessionVersion++', context); $('bot-model-list').textContent = 'new session'; pending.shift().reject(new Error('stale')); await tick(); assert.equal($('bot-model-list').textContent, 'new session');
});

test('loading another bot clears both new and replacement key fields immediately', async () => {
  const $ = nodes(), upload = deferred(), replacement = { value: 'unsent-replacement' };
  $('bot-key').value = 'unsent-key'; $('bot-keys').querySelectorAll = () => [replacement]; $('bot-account').value = 'second';
  const context = vm.createContext({ $, active: true, sessionVersion: 1, botRequest: 0, botKeys: [], api: () => upload.promise, run: fn => Promise.resolve().then(fn) });
  vm.runInContext(source.slice(source.indexOf('function clearBotKeys()'), source.indexOf("if (typeof window !== 'undefined')")), context);
  vm.runInContext(source.slice(source.indexOf('const botUrl'), source.indexOf('function messageResult')), context);
  const loading = $('bot-account').handlers.change();
  assert.equal($('bot-key').value, ''); assert.equal(replacement.value, ''); assert.equal($('bot-settings').hidden, true);
  upload.resolve({ model: '', systemInstruction: '', adminPhones: [], enabledCommands: [], enabled: false, keys: [] }); await loading;
});

test('QR rotation preserves pairing result and role change discards stale response', async () => {
  const map = new Map(), requests = [];
  function node() { return { children: [], value: '', dataset: {}, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, querySelectorAll() { return []; } }; }
  const document = { documentElement: node(), getElementById(id) { if (!map.has(id)) map.set(id, node()); return map.get(id); }, createElement: node };
  const context = vm.createContext({ document, FormData, localStorage: { getItem: () => 'light' }, matchMedia: () => ({ matches: false, addEventListener() {} }), fetch: (url, options) => { const d = deferred(); requests.push({ url, options, ...d }); return d.promise; } });
  vm.runInContext(source.slice(0, source.indexOf('async function loadDestinations()')), context);
  vm.runInContext('showDashboard(true)', context);
  const respond = (r, data) => r.resolve({ ok: true, json: async () => data });
  const sample = (qr, role = 'ordinary') => [{ id: 'a', name: 'A', status: 'qr', role, qr }];
  const load = async rows => { const promise = vm.runInContext('loadAccounts()', context); respond(requests.shift(), rows); await promise; };
  await load(sample('first'));
  const entry = vm.runInContext("pairingForms.get('a')", context);
  entry.input.value = '123456'; const submission = entry.form.handlers.submit({ preventDefault() {} }); await tick(); const pairing = requests.shift();
  await load(sample('second')); assert.equal(vm.runInContext("pairingForms.get('a')", context), entry);
  respond(pairing, { code: 'TEST-CODE' }); await submission; assert.match(entry.result.textContent, /TEST-CODE/);
  entry.input.value = '123456'; const pending = entry.form.handlers.submit({ preventDefault() {} }); await tick(); const old = requests.shift();
  await load(sample('third', 'bot')); assert.equal(entry.result.textContent, ''); respond(old, { code: 'STALE' }); await pending; assert.equal(entry.result.textContent, '');
  let refreshes = 0; context.loadDestinations = async () => { refreshes++; }; document.getElementById('account').value = 'a';
  await load([{ id: 'a', name: 'A', status: 'connected', role: 'bot' }]); await tick(); assert.equal(refreshes, 1);
  vm.runInContext('showDashboard(false)', context); assert.equal(vm.runInContext('pairingForms.size', context), 0);
});
