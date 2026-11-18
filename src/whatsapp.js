import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, db } from './db.js';
import QRCode from 'qrcode';
import { bindContactEvents, createContactStore } from './wa-contacts.js';
import { createFencedAuthStore } from './fenced-auth-store.js';
import { createBotRuntime } from './bot-runtime.js';
import { privatePreview } from './private-preview.js';

const logger = { level: 'silent', child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

export function createWhatsAppManager({ makeSocket = makeWASocket, createStore = createFencedAuthStore, makeDir = mkdir, removeDir = rm, root = dataDir, toQR = QRCode.toDataURL, retryDelay = 5000, onError = console.error, botRuntime = null } = {}) {
  const accounts = new Map();
  const groupCache = new Map();
  let groupRequests = 0;
  const manager = id => {
    if (!validId(id)) throw new Error('ID akun tidak valid');
    if (!accounts.has(id)) accounts.set(id, { blocked: false, current: null, entries: new Set(), repair: null, pairingUntil: 0 });
    return accounts.get(id);
  };
  const current = (m, entry) => !m.blocked && m.current === entry && !entry.retired;
  const report = error => { try { onError(error); } catch {} };

  function retire(m, entry) {
    if (entry.retiring) return entry.retiring;
    entry.retired = true;
    entry.qr = null;
    clearTimeout(entry.timer);
    const firstFence = entry.store?.fence();
    entry.retiring = (async () => {
      await firstFence;
      try { await entry.start; } catch {}
      await entry.store?.fence();
      if (entry.socket) await entry.socket.end();
      if (entry.pairing) await entry.pairing.catch(() => {});
      m.entries.delete(entry);
    })();
    return entry.retiring;
  }

  async function fenceAccount(id) {
    const m = manager(id);
    m.blocked = true;
    m.current = null;
    groupCache.delete(id);
    const retired = [...m.entries].map(entry => retire(m, entry));
    await Promise.all(retired);
    if (m.repair) await m.repair;
  }

  function state(id) {
    const c = accounts.get(id)?.current;
    return { status: c?.status || 'disconnected', qr: c?.qr || null };
  }

  async function connect(id) {
    const m = manager(id);
    if (m.blocked || m.repair) throw new Error('Akun tidak tersedia');
    const previous = m.current;
    if (previous && ['connecting', 'connected', 'qr'].includes(previous.status)) return previous.start;
    if (previous?.status === 'logged_out') throw new Error('Tautkan ulang diperlukan');
    const entry = { status: 'connecting', qr: null, socket: null, store: null, qrVersion: 0, connectionVersion: 0, retired: false, contacts: previous?.contacts || createContactStore() };
    m.current = entry;
    m.entries.add(entry);
    entry.start = (async () => {
      try {
        if (previous) await retire(m, previous);
        if (!current(m, entry)) return;
        const dir = join(root, 'sessions', id);
        await makeDir(dir, { recursive: true, mode: 0o700 });
        if (!current(m, entry)) return;
        entry.store = await createStore(dir);
        if (!current(m, entry)) { await entry.store.fence(); return; }
        const socket = makeSocket({ auth: entry.store.state, logger, printQRInTerminal: false, browser: ['WA Dashboard', 'Chrome', '1.0'] });
        entry.socket = socket;
        socket.ev.on('creds.update', () => {
          if (!current(m, entry)) return;
          entry.store.saveCreds().catch(error => {
            if (!current(m, entry)) return;
            report(new Error('Gagal menyimpan kredensial WhatsApp'));
            fenceAccount(id).catch(report);
          });
        });
        bindContactEvents(socket.ev, entry.contacts, () => current(m, entry));
        if (botRuntime) socket.ev.on('messages.upsert', upsert => {
          if (!current(m, entry) || entry.status !== 'connected' || upsert?.type !== 'notify' || !Array.isArray(upsert.messages)) return;
          const version = entry.connectionVersion;
          for (const message of upsert.messages.slice(0, 100)) void botRuntime.handle(id, socket, () => current(m, entry) && entry.status === 'connected' && entry.connectionVersion === version, upsert, message);
        });
        socket.ev.on('connection.update', update => {
          if (!current(m, entry)) return;
          if (update.qr && update.connection !== 'open' && update.connection !== 'close') {
            const version = ++entry.qrVersion;
            Promise.resolve().then(() => toQR(update.qr, { scale: 8, margin: 4 })).then(qr => {
              if (current(m, entry) && entry.qrVersion === version) { entry.qr = qr; entry.status = 'qr'; }
            }).catch(report);
          }
          if (update.connection === 'open' || update.connection === 'close') { entry.qrVersion++; entry.connectionVersion++; }
          if (update.connection === 'open') { entry.status = 'connected'; entry.qr = null; }
          if (update.connection === 'close') {
            entry.status = 'disconnected'; entry.qr = null;
            const code = update.lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
              entry.timer = setTimeout(() => { if (current(m, entry) && entry.status === 'disconnected') Promise.resolve().then(() => connect(id)).catch(report); }, retryDelay);
              entry.timer.unref();
            } else entry.status = 'logged_out';
          }
        });
      } catch (error) {
        entry.status = 'disconnected';
        m.blocked = true;
        m.current = null;
        if (entry.store) await entry.store.fence();
        if (entry.socket) await entry.socket.end();
        throw error;
      }
    })();
    return entry.start;
  }

  function repair(id) {
    if (privatePreview) throw new Error('Tautkan ulang tidak tersedia selama private preview');
    const m = manager(id);
    if (m.blocked || m.repair) throw new Error('Akun tidak tersedia');
    const entry = m.current;
    if (entry?.status !== 'logged_out') throw new Error('Tautkan ulang hanya tersedia untuk sesi yang sudah keluar');
    m.current = null;
    groupCache.delete(id);
    const work = (async () => {
      await retire(m, entry);
      if (m.blocked) return;
      await removeDir(join(root, 'sessions', id), { recursive: true, force: true });
    })();
    m.repair = work;
    return work.then(() => {
      m.repair = null;
      if (!m.blocked) return connect(id);
    }, error => { m.repair = null; m.blocked = true; throw error; });
  }

  function socketFor(id) {
    const m = accounts.get(id);
    const c = m?.current;
    if (!c || !current(m, c) || c.status !== 'connected') throw new Error('Akun WhatsApp tidak terhubung');
    return c.socket;
  }
  async function pairingCode(id, phone) {
    if (typeof phone !== 'string' || !/^[1-9][0-9]{5,14}$/.test(phone)) throw new Error('Nomor telepon tidak valid');
    const m = manager(id), entry = m.current;
    if (!entry || !current(m, entry) || entry.status !== 'qr' || entry.store?.state?.creds?.registered !== false || typeof entry.socket?.requestPairingCode !== 'function') throw new Error('Akun belum siap untuk kode pairing');
    if (entry.pairing || m.pairingUntil > Date.now()) throw new Error('Terlalu banyak permintaan kode pairing');
    m.pairingUntil = Date.now() + 60000;
    const work = (async () => {
      try {
        const code = await entry.socket.requestPairingCode(phone);
        if (!current(m, entry) || entry.status !== 'qr' || entry.store.state.creds.registered !== false || typeof code !== 'string' || !/^[A-Z0-9]{8}$/.test(code)) throw new Error();
        return code;
      } catch { throw new Error('Kode pairing tidak tersedia'); }
    })();
    entry.pairing = work;
    try { return await work; } finally { if (entry.pairing === work) entry.pairing = null; }
  }
  function whatsappContacts(id) { return accounts.get(id)?.current?.contacts.list() || []; }
  async function groups(id) {
    const socket = socketFor(id);
    const cached = groupCache.get(id);
    if (cached && cached.socket === socket && (cached.pending || cached.until > Date.now())) return cached.promise;
    if (groupRequests >= 4) throw new Error('Terlalu banyak permintaan grup. Coba lagi nanti.');
    groupRequests++;
    const entry = { socket, until: 0, pending: true, promise: null };
    const promise = Promise.resolve().then(() => socket.groupFetchAllParticipating()).then(all => {
      if (socketFor(id) !== socket) throw new Error('Akun WhatsApp tidak terhubung');
      return Object.values(all).map(g => ({ jid: g.id, name: g.subject || g.id })).sort((a, b) => a.name.localeCompare(b.name));
    }).finally(() => { groupRequests--; entry.pending = false; entry.until = Date.now() + 60000; });
    entry.promise = promise;
    groupCache.set(id, entry);
    if (groupCache.size > 100) groupCache.delete(groupCache.keys().next().value);
    try { return await promise; } catch (error) { if (groupCache.get(id)?.promise === promise) groupCache.delete(id); throw error; }
  }
  return { connect, fenceAccount, groups, pairingCode, repair, socketFor, state, whatsappContacts };
}

export const { connect, fenceAccount, groups, pairingCode, repair, socketFor, state, whatsappContacts } = createWhatsAppManager({ botRuntime: createBotRuntime({ db }) });
