import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('account polling preserves the QR and ignores stale responses and logout', async () => {
  const nodes = new Map();
  function node() {
    return { children: [], value: '', dataset: {}, addEventListener() {}, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, set textContent(value) { this.text = value; }, get textContent() { return this.text; } };
  }
  const document = { documentElement: node(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  const pending = [];
  const fetch = () => new Promise(resolve => pending.push(data => resolve({ ok: true, json: async () => data })));
  const context = vm.createContext({ document, fetch, FormData, localStorage: { getItem() { return 'light'; } }, matchMedia() { return { matches: false, addEventListener() {} }; } });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('async function loadDestinations()')), context);
  vm.runInContext('showDashboard(true)', context);
  const sample = qr => [{ id: '1', name: 'A', status: 'qr', qr }];
  const first = vm.runInContext('loadAccounts()', context); pending.shift()(sample('data:image/png;base64,first')); await first;
  const list = document.getElementById('accounts-list');
  const image = list.children[0].children[2];
  assert.equal(image.width, 320);
  assert.equal(image.src, 'data:image/png;base64,first');
  const same = vm.runInContext('loadAccounts()', context); pending.shift()(sample(image.src)); await same;
  assert.equal(list.children[0].children[2], image);
  const older = vm.runInContext('loadAccounts()', context);
  const newer = vm.runInContext('loadAccounts()', context);
  const resolveOlder = pending.shift(); pending.shift()(sample('data:image/png;base64,new')); await newer;
  resolveOlder(sample('data:image/png;base64,old')); await older;
  assert.equal(list.children[0].children[2].src, 'data:image/png;base64,new');
  const afterLogout = vm.runInContext('loadAccounts()', context);
  vm.runInContext('showDashboard(false)', context);
  pending.shift()(sample('data:image/png;base64,private')); await assert.rejects(afterLogout, /Sesi berubah/);
  assert.equal(list.children.length, 0);
});
