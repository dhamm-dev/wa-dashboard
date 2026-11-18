import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function setup(fetch) {
  const nodes = new Map(), events = {};
  const $ = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  const window = { addEventListener(name, fn) { events[name] = fn; } };
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('let signupAllowed'), source.indexOf('const date =')), { $, window, fetch, AbortSignal });
  return { $, events };
}

test('signup stays closed on failed or malformed responses and opens only for true', async () => {
  for (const [response, enabled] of [[{ ok: true, json: async () => ({ publicSignup: true }) }, true], [{ ok: true, json: async () => ({ publicSignup: 'true' }) }, false], [{ ok: false }, false], [null, false]]) {
    const ui = await setup(async () => { if (!response) throw new Error(); return response; });
    await ui.events.pageshow();
    assert.equal(ui.$('register').hidden, !enabled);
    assert.equal(ui.$('register').disabled, !enabled);
    assert.equal(ui.$('signup-status').textContent, enabled ? '' : 'Pendaftaran publik belum tersedia.');
  }
});

test('late responses cannot reopen signup after navigation or a newer request', async () => {
  const pending = [];
  const ui = await setup(() => new Promise(resolve => pending.push(resolve)));
  const first = ui.events.pageshow();
  ui.events.pagehide();
  const second = ui.events.pageshow();
  pending[1]({ ok: true, json: async () => ({ publicSignup: false }) });
  await second;
  pending[0]({ ok: true, json: async () => ({ publicSignup: true }) });
  await first;
  assert.equal(ui.$('register').hidden, true);
});
