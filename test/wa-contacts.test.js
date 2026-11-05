import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bindContactEvents, createContactStore } from '../src/wa-contacts.js';

test('contact events retain only usable phone JIDs and remain isolated per account', () => {
  const a = createContactStore(), b = createContactStore();
  a.update([{ id: '62812345678@s.whatsapp.net', name: 'Ayu' }, { id: '12345@lid', phoneNumber: '62812345679@s.whatsapp.net', notify: 'Budi' }, { id: '33333@lid', name: 'Unknown' }]);
  a.update([{ id: '62812345678@s.whatsapp.net', status: 'online' }]);
  assert.deepEqual(a.list(), [{ jid: '62812345679@s.whatsapp.net', name: 'Budi' }, { jid: '62812345678@s.whatsapp.net', name: 'Ayu' }]);
  assert.deepEqual(b.list(), []);
});

test('mock socket events populate the store and an obsolete socket cannot update it', () => {
  const events = new EventEmitter(), store = createContactStore();
  let current = true;
  bindContactEvents(events, store, () => current);
  events.emit('messaging-history.set', { contacts: [{ id: '62812345678@s.whatsapp.net', name: 'Ayu' }] });
  events.emit('contacts.upsert', [{ id: '62812345679@s.whatsapp.net', notify: 'Budi' }]);
  events.emit('contacts.update', [{ id: '62812345678@s.whatsapp.net', name: 'Nama baru' }]);
  current = false;
  events.emit('contacts.update', [{ id: '62812345678@s.whatsapp.net', name: 'Usang' }]);
  assert.equal(store.list().find(c => c.jid === '62812345678@s.whatsapp.net').name, 'Nama baru');
  assert.equal(store.list().length, 2);
});
