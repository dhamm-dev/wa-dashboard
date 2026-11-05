import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './db.js';
import QRCode from 'qrcode';
import { bindContactEvents, createContactStore } from './wa-contacts.js';

const connections = new Map();
const groupCache = new Map();
let groupRequests = 0;
const logger = { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

export function state(id) {
  const c = connections.get(id);
  return { status: c?.status || 'disconnected', qr: c?.qr || null };
}

export async function connect(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('ID akun tidak valid');
  const existing = connections.get(id);
  if (existing && ['connecting', 'connected', 'qr'].includes(existing.status)) return;
  const entry = { status: 'connecting', qr: null, socket: null, qrVersion: 0, contacts: existing?.contacts || createContactStore() };
  connections.set(id, entry);
  try {
    const dir = join(dataDir, 'sessions', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { state: auth, saveCreds } = await useMultiFileAuthState(dir);
    const socket = makeWASocket({ auth, logger, printQRInTerminal: false, browser: ['WA Dashboard', 'Chrome', '1.0'] });
    entry.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    bindContactEvents(socket.ev, entry.contacts, () => connections.get(id) === entry);
    socket.ev.on('connection.update', async update => {
      if (connections.get(id) !== entry) return;
      if (update.qr && update.connection !== 'open' && update.connection !== 'close') {
        const version = ++entry.qrVersion;
        const qr = await QRCode.toDataURL(update.qr, { scale: 8, margin: 4 });
        if (connections.get(id) === entry && entry.qrVersion === version) { entry.qr = qr; entry.status = 'qr'; }
      }
      if (update.connection === 'open' || update.connection === 'close') entry.qrVersion++;
      if (update.connection === 'open') { entry.status = 'connected'; entry.qr = null; }
      if (update.connection === 'close') {
        entry.status = 'disconnected'; entry.qr = null;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) setTimeout(() => { if (connections.get(id) === entry && entry.status === 'disconnected') connect(id).catch(console.error); }, 5000).unref();
        else entry.status = 'logged_out';
      }
    });
  } catch (err) { entry.status = 'disconnected'; throw err; }
}

export async function repair(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('ID akun tidak valid');
  const entry = connections.get(id);
  if (entry?.status !== 'logged_out') throw new Error('Tautkan ulang hanya tersedia untuk sesi yang sudah keluar');
  connections.delete(id);
  entry.socket?.end();
  await rm(join(dataDir, 'sessions', id), { recursive: true, force: true });
  await connect(id);
}

export function socketFor(id) {
  const c = connections.get(id);
  if (!c || c.status !== 'connected') throw new Error('Akun WhatsApp tidak terhubung');
  return c.socket;
}

export function whatsappContacts(id) {
  return connections.get(id)?.contacts.list() || [];
}

export async function groups(id) {
  const socket = socketFor(id);
  const cached = groupCache.get(id);
  if (cached && cached.socket === socket && (cached.pending || cached.until > Date.now())) return cached.promise;
  if (groupRequests >= 4) throw new Error('Terlalu banyak permintaan grup. Coba lagi nanti.');
  groupRequests++;
  const entry = { socket, until: 0, pending: true, promise: null };
  const promise = Promise.resolve().then(() => socket.groupFetchAllParticipating()).then(all => Object.values(all).map(g => ({ jid: g.id, name: g.subject || g.id })).sort((a, b) => a.name.localeCompare(b.name))).finally(() => { groupRequests--; entry.pending = false; entry.until = Date.now() + 60000; });
  entry.promise = promise;
  groupCache.set(id, entry);
  if (groupCache.size > 100) groupCache.delete(groupCache.keys().next().value);
  try { return await promise; } catch (err) { if (groupCache.get(id)?.promise === promise) groupCache.delete(id); throw err; }
}
