import { parseBotMessage } from './bot-message.js';
import { createGeminiProvider } from './gemini.js';
import { botSecretKey, decryptBotSecret } from './bot-secret.js';

const DAY = 86400000;
const CONTEXT_TTL = 30 * 60000;
const commands = ['menu', 'help', 'ping', 'info', 'resetai', 'token', 'status'];
const adminOnly = new Set(['token', 'status']);
const help = {
  menu: 'Menampilkan daftar perintah yang aktif.',
  help: 'Gunakan .help [command] untuk bantuan per perintah.',
  ping: 'Memeriksa respons bot.',
  info: 'Menampilkan informasi bot.',
  resetai: 'Menghapus konteks AI Anda di chat ini.',
  token: 'Menampilkan pemakaian token sejak proses dimulai. Khusus admin.',
  status: 'Menampilkan status konfigurasi bot. Khusus admin.'
};
const unknown = 'Command tidak diketahui. Ketik .menu untuk melihat daftar command.';
const pn = /^[1-9]\d{5,19}@s\.whatsapp\.net$/;

export function createBotRuntime({ db, provider = createGeminiProvider, masterKey = botSecretKey, now = Date.now, retentionDays = Number(process.env.BOT_RETENTION_DAYS ?? 30) }) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('BOT_RETENTION_DAYS harus 1-3650');
  const rates = new Map(), contexts = new Map(), usage = new Map();
  let active = 0, lastCleanup = 0;
  const configuration = id => db.prepare(`SELECT c.*,a.owner_id,coalesce(g.generation,0) AS generation
    FROM bot_config c JOIN accounts a ON a.id=c.account_id JOIN users u ON u.id=a.owner_id
    LEFT JOIN bot_config_generation g ON g.account_id=a.id
    WHERE a.id=? AND a.role='bot' AND u.role='admin' AND c.enabled=1
    AND (u.google_sub IS NULL OR NOT EXISTS (SELECT 1 FROM revoked_google_subs r WHERE r.google_sub=u.google_sub))`).get(id);
  const keyRows = id => db.prepare('SELECT id,ciphertext FROM bot_keys WHERE account_id=? ORDER BY priority').all(id);
  const expire = () => { const time = now(); for (const [id, entry] of contexts) if (entry.until <= time) contexts.delete(id); };
  const timer = setInterval(expire, 60000);
  timer.unref();

  async function handle(accountId, socket, isCurrent, upsert, message) {
    try {
      if (!isCurrent() || active >= 4) return;
      const key = message?.key;
      const botId = socket.user?.id?.replace(/:\d+@/, '@');
      if (!pn.test(botId ?? '') || !key || typeof key.id !== 'string' || key.id.length > 256 ||
          key.remoteJidAlt != null || key.participantAlt != null || key.senderPn != null || key.senderLid != null ||
          (key.addressingMode != null && key.addressingMode !== 'pn')) return;
      const group = typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@g.us');
      if (!(group ? pn.test((key.participant ?? '').replace(/:\d+@/, '@')) : pn.test(key.remoteJid ?? '') && key.participant == null)) return;
      const row = configuration(accountId);
      if (!row) return;
      const phones = JSON.parse(row.admin_phones), enabled = JSON.parse(row.commands);
      if (!Array.isArray(phones) || !Array.isArray(enabled)) return;
      const decision = parseBotMessage(upsert, message, {
        nowMs: now(), maxAgeMs: 120000, socketUser: socket.user,
        adminJids: phones.filter(value => typeof value === 'string' && /^[1-9]\d{5,14}$/.test(value)).map(value => `${value}@s.whatsapp.net`),
        enabledCommands: enabled.filter(value => commands.includes(value))
      });
      if (decision.type === 'ignore' || !pn.test(decision.senderJid)) return;
      const time = now();
      for (const [id, entry] of rates) if (entry.until <= time) rates.delete(id);
      const rate = rates.get(accountId);
      if (rate?.count >= 20 || (!rate && rates.size >= 10000)) return;
      if (rate) rate.count++; else rates.set(accountId, { count: 1, until: time + 60000 });
      active++;
      try {
        if (!lastCleanup || time - lastCleanup >= 3600000) {
          db.prepare('DELETE FROM bot_message_reservations WHERE reserved_at<=?').run(time - retentionDays * DAY);
          lastCleanup = time;
        }
        const contextId = JSON.stringify([accountId, decision.chatJid, decision.senderJid]);
        expire();
        const existing = contexts.get(contextId);
        const busy = decision.type === 'generate' && row.model && decision.text.length <= 4000 && existing?.generation === row.generation && existing.busy;
        let welcome = false;
        db.exec('BEGIN IMMEDIATE');
        try {
          const inserted = db.prepare('INSERT OR IGNORE INTO bot_message_reservations VALUES (?,?,?,?,?)').run(accountId, decision.chatJid, decision.senderJid, key.id, time).changes;
          if (!inserted) { db.exec('COMMIT'); return; }
          if (!group && !busy) welcome = !!db.prepare('INSERT OR IGNORE INTO bot_welcomes VALUES (?,?,?)').run(accountId, decision.senderJid, time).changes;
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        const current = () => {
          if (!isCurrent()) return false;
          const latest = configuration(accountId);
          return !!latest && latest.owner_id === row.owner_id && latest.generation === row.generation;
        };
        if (busy) {
          if (current()) await socket.sendMessage(decision.chatJid, { text: 'Bot sedang memproses pesan sebelumnya. Pesan ini tidak diproses.' });
          return;
        }
        let context;
        if (decision.type === 'command' && decision.command === 'resetai') contexts.delete(contextId);
        if (decision.type === 'generate' && row.model && decision.text.length <= 4000) {
          context = contexts.get(contextId);
          if (context && context.generation !== row.generation) { contexts.delete(contextId); context = null; }
          if (!context) {
            if (contexts.size >= 500) contexts.delete(contexts.keys().next().value);
            context = { history: [], generation: row.generation, until: time + CONTEXT_TTL, busy: false };
            contexts.set(contextId, context);
          }
          context.busy = true;
        }
        const valid = () => current() && (!context || (contexts.get(contextId) === context && context.until > now()));
        try {
          if (welcome) {
            if (!valid()) return;
            await socket.sendMessage(decision.chatJid, { text: 'WELCOME TO DHEXX CHAT' });
            if (!valid()) return;
          }
          let text = '', secrets = [], generated = false;
          if (decision.type === 'generate') {
            const rows = keyRows(accountId);
            if (!row.model || !rows.length) text = 'AI belum dikonfigurasi.';
            else if (!context) text = 'Pesan terlalu panjang untuk AI.';
            else {
              try {
                const master = masterKey();
                secrets = rows.map(item => decryptBotSecret(Buffer.from(item.ciphertext), accountId, item.id, master));
                if (!valid()) return;
                const result = await provider({ keys: secrets, isCurrent: valid }).generateText({ model: row.model, text: decision.text, systemInstruction: row.instruction, history: context.history.map(item => ({ ...item })) });
                if (!valid()) return;
                if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 4000 || secrets.some(secret => result.text.includes(secret))) throw new Error();
                text = result.text; generated = true;
                const counts = usage.get(accountId) ?? { requests: 0, input: 0, output: 0, missing: 0 };
                counts.requests++;
                for (const [field, value] of [['input', result.usage?.inputTokens], ['output', result.usage?.outputTokens]]) {
                  if (Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(counts[field] + value)) counts[field] += value; else counts.missing++;
                }
                if (usage.size < 10000 || usage.has(accountId)) usage.set(accountId, counts);
              } catch { text = 'AI sedang tidak tersedia.'; }
            }
          } else if (decision.type === 'denied') text = 'Perintah hanya untuk admin.';
          else if (decision.type === 'disabled') text = 'Perintah tidak aktif.';
          else if (decision.type === 'unknown-command') text = unknown;
          else if (decision.command === 'ping') text = 'Pong.';
          else if (decision.command === 'info') text = 'Bot WhatsApp aktif.';
          else if (decision.command === 'resetai') text = 'Konteks AI di chat ini telah dihapus.';
          else if (decision.command === 'menu' || decision.command === 'help') {
            const visible = commands.filter(name => enabled.includes(name) && (decision.isAdmin || !adminOnly.has(name)));
            const target = decision.args.trim().replace(/^\./, '').toLowerCase();
            if (decision.command === 'menu') text = `DHEXX MENUS\n${visible.map(name => `.${name}`).join('\n') || 'Tidak ada perintah aktif.'}`;
            else if (!target) text = 'Gunakan .help [command] untuk bantuan per perintah. Ketik .menu untuk daftar perintah.';
            else text = visible.includes(target) ? `.${target}: ${help[target]}` : unknown;
          } else if (decision.command === 'status') text = `Bot aktif. AI: ${row.model && keyRows(accountId).length ? 'dikonfigurasi' : 'belum dikonfigurasi'}.`;
          else if (decision.command === 'token') {
            const count = usage.get(accountId);
            text = (count ? `Pemakaian sejak proses dimulai: ${count.requests} permintaan, input ${count.input}, output ${count.output}; ${count.missing} nilai tidak tersedia.` : 'Pemakaian sejak proses dimulai: belum ada data.') + ' Sisa kuota tidak tersedia.';
          }
          if (!text || secrets.some(secret => text.includes(secret)) || !valid()) return;
          await socket.sendMessage(decision.chatJid, { text });
          if (generated && valid()) {
            context.history.push({ role: 'user', text: decision.text }, { role: 'model', text });
            context.history = context.history.slice(-10);
            context.until = now() + CONTEXT_TTL;
          }
        } finally { if (context) context.busy = false; }
      } finally { active--; }
    } catch {}
  }
  return { handle };
}
