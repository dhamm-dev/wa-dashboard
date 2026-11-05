import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('destination results stay scoped to the selected account and support filtering', async () => {
  const nodes = new Map();
  function node() {
    return {
      children: [], value: '', dataset: {}, attributes: {}, handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; },
      contains(other) { return other === this || this.children.includes(other); },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      querySelector() { return null; },
      set textContent(value) { this.text = value; }, get textContent() { return this.text; }
    };
  }
  const document = { documentElement: node(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  const pending = [];
  const fetch = url => new Promise(resolve => pending.push({ url, resolve: data => resolve({ ok: true, json: async () => data }) }));
  const context = vm.createContext({ document, fetch, FormData, localStorage: { getItem: () => 'light' }, matchMedia: () => ({ matches: false, addEventListener() {} }) });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('async function loadTemplates()')), context);
  vm.runInContext('showDashboard(true)', context);
  document.getElementById('destination-type').value = 'contact';
  document.getElementById('account').value = 'a';
  const old = vm.runInContext('loadDestinations()', context);
  document.getElementById('account').value = 'b';
  const current = vm.runInContext('loadDestinations()', context);
  assert.match(pending[1].url, /accountId=b/);
  pending[1].resolve([{ id: 'b1', name: 'Budi', jid: '62812345678@s.whatsapp.net' }]);
  await current;
  pending[0].resolve([{ id: 'a1', name: 'Ayu', jid: '62812345679@s.whatsapp.net' }]);
  await old;
  const list = document.getElementById('destination-list');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[1].children[0].textContent, 'Budi');
  list.children[0].handlers.click();
  assert.equal(document.getElementById('destination').value, '62812345678@s.whatsapp.net');
  assert.equal(document.getElementById('destination-dropdown').open, false);
  assert.equal(document.getElementById('destination-trigger').focused, true);
  assert.match(document.getElementById('destination-selected').textContent, /Budi.*62812345678/);
  document.getElementById('destination-type').value = 'group';
  vm.runInContext('changeDestinationType()', context);
  assert.equal(document.getElementById('destination').value, '');
  assert.match(document.getElementById('destination-selected').textContent, /Pilihan tujuan dihapus/);
  document.getElementById('destination-type').value = 'contact';
  vm.runInContext('changeDestinationType()', context);
  list.children[0].handlers.click();
  assert.equal(document.getElementById('destination').value, '62812345678@s.whatsapp.net');
  document.getElementById('destination-search').value = 'tidak cocok';
  vm.runInContext('renderDestinations()', context);
  assert.equal(list.children.length, 0);
  vm.runInContext('openDestinationList()', context);
  assert.equal(document.getElementById('destination-search').value, '');
  assert.equal(list.children.length, 1);
  const dropdown = document.getElementById('destination-dropdown');
  dropdown.open = true;
  context.event = { key: 'Escape', preventDefault() { this.prevented = true; } };
  vm.runInContext('destinationKeydown(event)', context);
  assert.equal(context.event.prevented, true);
  assert.equal(dropdown.open, false);
  dropdown.open = true;
  context.event = { relatedTarget: document.getElementById('number') };
  vm.runInContext('destinationFocusout(event)', context);
  assert.equal(dropdown.open, false);
  document.getElementById('account').value = 'a';
  const next = vm.runInContext('loadDestinations()', context);
  assert.equal(document.getElementById('destination').value, '');
  assert.equal(document.getElementById('destination-selected').textContent, 'Belum ada tujuan dipilih.');
  pending[2].resolve([]); await next;
});

test('contact failure does not hide groups and local names override WhatsApp contacts', async () => {
  const nodes = new Map();
  function node() { return { children: [], value: '', dataset: {}, handlers: {}, addEventListener(n, f) { this.handlers[n] = f; }, setAttribute() {}, append(...c) { this.children.push(...c); }, replaceChildren() { this.children = []; }, querySelector() { return null; }, set textContent(v) { this.text = v; }, get textContent() { return this.text; } }; }
  const document = { documentElement: node(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node };
  let failLocal = true;
  const fetch = async url => {
    if (url.includes('/api/contacts?') && failLocal) return { ok: false, json: async () => ({ error: 'failure' }) };
    const data = url.includes('/api/contacts?') ? [{ id: '1', jid: '62812345678@s.whatsapp.net', name: 'Lokal' }] : url.includes('whatsapp-contacts') ? [{ jid: '62812345678@s.whatsapp.net', name: 'WA' }] : [{ jid: '123456@g.us', name: 'Tim' }];
    return { ok: true, json: async () => data };
  };
  const context = vm.createContext({ document, fetch, FormData, localStorage: { getItem: () => 'light' }, matchMedia: () => ({ matches: false, addEventListener() {} }) });
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('async function loadTemplates()')), context);
  vm.runInContext("showDashboard(true); accounts = [{id:'a', status:'connected'}]", context);
  document.getElementById('account').value = 'a';
  document.getElementById('destination-type').value = 'group';
  await vm.runInContext('loadDestinations()', context);
  assert.equal(document.getElementById('destination-list').children[0].children[1].children[0].textContent, 'Tim');
  document.getElementById('destination-type').value = 'contact';
  vm.runInContext('renderDestinations()', context);
  assert.match(document.getElementById('destination-status').textContent, /kontak gagal dimuat/);
  failLocal = false;
  await vm.runInContext('loadDestinations()', context);
  assert.equal(document.getElementById('destination-list').children.length, 1);
  assert.equal(document.getElementById('destination-list').children[0].children[1].children[0].textContent, 'Lokal');
});
