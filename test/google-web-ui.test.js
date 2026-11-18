import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function setup(reply) {
  const nodes = new Map(), calls = [], timers = [], events = {};
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { addEventListener(type, fn) { this[type] = fn; } });
    return nodes.get(id);
  };
  const popup = { location: { replace(url) { popup.url = url; } }, close() { this.closed = true; } };
  const document = { querySelectorAll() { return []; } };
  const window = { isSecureContext: true, crypto: { getRandomValues(bytes) { bytes.fill(7); } }, open() { return popup; }, addEventListener(type, fn) { events[type] = fn; } };
  const context = vm.createContext({ $, window, document, signupAllowed: false, location: { protocol: 'https:', origin: 'https://dashboard.test' }, URL, Uint8Array, Date, Number, String, AbortSignal, btoa: value => Buffer.from(value, 'binary').toString('base64'), setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, post: async (url, body) => { calls.push({ url, body: { ...body } }); return reply(url); }, enterSession: async () => { calls.push({ url: 'me' }); } });
  function $(id) { return get(id); }
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf("if (typeof window !== 'undefined') {"), source.indexOf('async function loadAccounts()')), context);
  return { get, popup, calls, timers, events };
}

const token = 'a'.repeat(43);
function start(callback = 'https://dashboard.test/api/google/android/callback') {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: 'client', redirect_uri: callback, response_type: 'code', scope: 'openid email', state: token, nonce: token, code_challenge: token, code_challenge_method: 'S256' });
  return { id: token, authorizationUrl: url.href, expiresIn: 300, pollInterval: 2 };
}

test('Google popup uses a fresh secret, polls pending then completes once', async () => {
  let polls = 0;
  const ui = await setup(url => url.endsWith('/start') ? start() : { status: ++polls === 1 ? 'pending' : 'complete' });
  await ui.get('google-login').click();
  assert.match(ui.popup.url, /^https:\/\/accounts\.google\.com\//);
  assert.equal(ui.popup.opener, null);
  assert.match(ui.calls[0].body.secret, /^[A-Za-z0-9_-]{43}$/);
  await ui.timers.shift()();
  await ui.timers.shift()();
  assert.equal(ui.calls.filter(call => call.url.endsWith('/poll')).length, 2);
  assert.equal(ui.calls.at(-1).url, 'me');
  assert.equal(ui.popup.closed, true);
});

test('Google popup rejects foreign callbacks and never retries an ambiguous poll', async () => {
  const bad = await setup(() => start('https://elsewhere.test/api/google/android/callback'));
  await bad.get('google-login').click();
  assert.equal(bad.popup.url, undefined);
  assert.equal(bad.popup.closed, true);
  assert.equal(bad.calls.length, 1);
  const ui = await setup(url => { if (url.endsWith('/start')) return start(); throw new Error('network'); });
  await ui.get('google-login').click();
  await ui.timers.shift()();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.timers.length, 0);
  assert.match(ui.get('google-status').textContent, /tidak dapat dipastikan/);
});

test('cancel and page navigation stop a pending Google flow', async () => {
  const ui = await setup(() => start());
  await ui.get('google-login').click();
  ui.get('google-cancel').click();
  await ui.timers.shift()();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.popup.closed, true);
  const other = await setup(() => start());
  await other.get('google-login').click();
  other.events.pagehide();
  await other.timers.shift()();
  assert.equal(other.calls.length, 1);
});
