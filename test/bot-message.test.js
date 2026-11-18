import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseBotMessage } from '../src/bot-message.js';

const nowMs = 1_700_000_000_000;
const bot = '628111111111@s.whatsapp.net';
const botLid = '987654321@lid';
const user = '628222222222@s.whatsapp.net';
const admin = '628333333333@s.whatsapp.net';
const options = { nowMs, maxAgeMs: 60_000, socketUser: { id: '628111111111:2@s.whatsapp.net', lid: botLid }, adminJids: [admin] };
const event = { type: 'notify' };
const dm = (text, sender = user) => ({ key: { id: 'msg-1', fromMe: false, remoteJid: sender }, messageTimestamp: nowMs / 1000, message: { conversation: text } });
const group = (text, mentionedJid = [bot], sender = user) => ({ key: { id: 'msg-2', fromMe: false, remoteJid: '123456789-123456@g.us', participant: sender }, messageTimestamp: nowMs / 1000, message: { extendedTextMessage: { text, contextInfo: { mentionedJid } } } });
const parse = (message, config = options, upsert = event) => parseBotMessage(upsert, message, config);

test('DM text generates; supported dot commands and unknown commands remain distinct', () => {
  assert.equal(parse(dm(' hello .ping ')).type, 'generate');
  assert.equal(parse(dm(' hello .ping ')).text, 'hello .ping');
  assert.deepEqual(parse(dm('hello')).uncertainty, ['duplicate-delivery']);
  for (const command of ['menu', 'help', 'ping', 'resetai', 'info']) {
    const result = parse(dm(`.${command} argument`));
    assert.equal(result.type, 'command');
    assert.equal(result.command, command);
    assert.equal(result.args, 'argument');
  }
  assert.equal(parse(dm('.PING')).command, 'ping');
  assert.equal(parse(dm('.unknown')).type, 'unknown-command');
  assert.equal(parse(dm('.')).type, 'unknown-command');
  assert.equal(parse(dm('   ')).reason, 'empty-text');
  assert.equal(parse({ ...dm('x'), message: { extendedTextMessage: { text: 'hello' } } }).type, 'generate');
});

test('group requires real bot metadata and a single exact leading mention token', () => {
  const result = parse(group('@628111111111 hello'));
  assert.equal(result.type, 'generate');
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.uncertainty, ['duplicate-delivery', 'mention-text-offset']);
  assert.equal(parse(group('@987654321 .ping', [botLid])).command, 'ping');
  assert.equal(parse(group('@628111111111 hello', [user])).reason, 'not-mentioned');
  assert.equal(parse(group('@628111111111 hello', [])).reason, 'not-mentioned');
  assert.equal(parse(group('@6281111111110 hello')).reason, 'ambiguous-mention-text');
  assert.equal(parse(group('prefix @628111111111 hello')).reason, 'ambiguous-mention-text');
  assert.equal(parse(group('@628111111111 @628111111111 hello')).reason, 'ambiguous-mention-text');
  assert.equal(parse(group('@628111111111')).reason, 'empty-text');
  const simple = group('x'); simple.message = { conversation: '@628111111111 hello' };
  assert.equal(parse(simple).reason, 'not-mentioned');
  assert.equal(parse(group('@628111111111 hello', ['628111111111@evil.example'])).reason, 'not-mentioned');
});

test('admin privilege uses only validated PN sender and PN whitelist', () => {
  for (const command of ['token', 'status']) {
    assert.equal(parse(dm(`.${command}`, admin)).type, 'command');
    assert.equal(parse(dm(`.${command}`, user)).type, 'denied');
    assert.equal(parse(group(`@628111111111 .${command}`, [bot], admin)).type, 'command');
    assert.equal(parse(group(`@628111111111 .${command}`, [bot], user)).type, 'denied');
  }
  const lid = parse(dm('.token', '628333333333@lid'));
  assert.equal(lid.type, 'denied');
  assert.equal(lid.identityUncertain, true);
  assert.equal(parse(dm('.token', admin), { ...options, adminJids: ['628333333333@lid'] }).type, 'denied');
  for (const spoof of ['628333333333@evil.example', '628333333333@s.whatsapp.net.evil', '628333333333@broadcast']) {
    assert.equal(parse(dm('.token', spoof)).reason, 'invalid-sender');
  }
  assert.equal(parse(group('@628111111111 .token', [bot], '628333333333@lid')).type, 'denied');
});

test('menu has exact title and lists only enabled commands permitted to sender', () => {
  const config = { ...options, enabledCommands: ['menu', 'help', 'token', 'status'] };
  assert.deepEqual(parse(dm('.menu'), config).menu, { title: 'DHEXX MENUS', commands: ['.menu', '.help'] });
  assert.deepEqual(parse(dm('.menu', admin), config).menu, { title: 'DHEXX MENUS', commands: ['.menu', '.help', '.token', '.status'] });
  assert.equal(parse(dm('.ping'), config).type, 'disabled');
  assert.equal(parse(dm('.token', admin), { ...config, enabledCommands: [] }).type, 'disabled');
});

test('history, stale or future events, system, edits and unsupported messages fail closed', () => {
  assert.equal(parse(dm('x'), options, { type: 'append' }).reason, 'not-live-event');
  assert.equal(parse(dm('x'), options, {}).reason, 'not-live-event');
  assert.equal(parse({ ...dm('x'), messageTimestamp: (nowMs - 60_001) / 1000 }).reason, 'outside-time-window');
  assert.equal(parse({ ...dm('x'), messageTimestamp: (nowMs - 60_000) / 1000 }).type, 'generate');
  assert.equal(parse({ ...dm('x'), messageTimestamp: nowMs / 1000 + 1 }).reason, 'outside-time-window');
  assert.equal(parse({ ...dm('x'), messageTimestamp: undefined }).reason, 'invalid-time');
  assert.equal(parse({ ...dm('x'), messageTimestamp: { toNumber: () => nowMs / 1000 } }).type, 'generate');
  assert.equal(parse(dm('x'), { ...options, nowMs: undefined }).reason, 'invalid-time');
  assert.equal(parse({ ...dm('x'), messageStubType: 1 }).reason, 'system-or-edit');
  assert.equal(parse({ ...dm('x'), edited: true }).reason, 'system-or-edit');
  assert.equal(parse({ ...dm('x'), isHistorySync: true }).reason, 'system-or-edit');
  for (const payload of [{ protocolMessage: {} }, { editedMessage: {} }, { imageMessage: { caption: 'hello' } }, { conversation: 'x', protocolMessage: {} }]) {
    assert.equal(parse({ ...dm('x'), message: payload }).reason, 'unsupported-message');
  }
  const ordinary = dm('Please edit this replay'); ordinary.key.id = 'replay-edited-123';
  assert.equal(parse(ordinary).text, 'Please edit this replay');
});

test('self, status and missing identities are ignored', () => {
  assert.equal(parse({ ...dm('x'), key: { ...dm('x').key, fromMe: true } }).reason, 'invalid-key');
  assert.equal(parse(dm('x', bot)).reason, 'self');
  assert.equal(parse(dm('x'), { ...options, socketUser: {} }).reason, 'missing-bot-identity');
  assert.equal(parse(dm('x', 'status@broadcast')).reason, 'invalid-sender');
  const missing = group('@628111111111 hello'); delete missing.key.participant;
  assert.equal(parse(missing).reason, 'invalid-sender');
  assert.equal(parse({ ...dm('x'), key: { ...dm('x').key, id: '' } }).reason, 'invalid-key');
});
