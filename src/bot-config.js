import express from 'express';
import { randomUUID } from 'node:crypto';
import { botSecretKey, encryptBotSecret, decryptBotSecret } from './bot-secret.js';
import { createGeminiProvider } from './gemini.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const modelPattern = /^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const commandPattern = /^[a-z][a-z0-9_-]{0,31}$/;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.trim() === value && /^[\x20-\x7e]+$/.test(value);
const invalid = res => res.status(400).json({ error: 'Permintaan tidak valid' });

function normalizePhones(values) {
  if (!Array.isArray(values) || values.length > 50) return null;
  const phones = [];
  for (const value of values) {
    if (typeof value !== 'string' || !/^\+?[0-9 ()-]+$/.test(value)) return null;
    const phone = value.replace(/[+ ()-]/g, '');
    if (!/^[1-9][0-9]{5,14}$/.test(phone) || phones.includes(phone)) return null;
    phones.push(phone);
  }
  return phones;
}

function validCommands(values) {
  return Array.isArray(values) && values.length <= 100 && values.every(value => typeof value === 'string' && commandPattern.test(value)) && new Set(values).size === values.length;
}

export function botConfigRouter({ db, provider = createGeminiProvider, masterKey = () => botSecretKey() }) {
  const router = express.Router({ mergeParams: true });
  const requests = new Map();
  const modelRequests = new Map();
  const owned = req => Boolean(db.prepare(`SELECT 1 FROM accounts a JOIN users u ON u.id=a.owner_id
    WHERE a.id=? AND a.owner_id=? AND a.role='bot' AND u.role='admin'
    AND (u.google_sub IS NULL OR NOT EXISTS (SELECT 1 FROM revoked_google_subs r WHERE r.google_sub=u.google_sub))`).get(req.params.id, req.user.id));
  const generation = id => db.prepare('SELECT generation FROM bot_config_generation WHERE account_id=?').get(id)?.generation ?? 0;
  const keys = id => db.prepare('SELECT id,priority,ciphertext FROM bot_keys WHERE account_id=? ORDER BY priority').all(id);
  const consume = (map, id, maximum) => {
    const now = Date.now();
    for (const [key, entry] of map) if (entry.until <= now) map.delete(key);
    const entry = map.get(id);
    if (entry?.count >= maximum || (!entry && map.size >= 10000)) return false;
    if (entry) entry.count++; else map.set(id, { count: 1, until: now + 60000 });
    return true;
  };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Permintaan ditolak' });
    if (!consume(requests, req.user.id, 120)) return res.status(429).json({ error: 'Terlalu banyak permintaan' });
    if (!owned(req)) return res.status(404).json({ error: 'Akun bot tidak ditemukan' });
    next();
  });

  router.get('/', (req, res) => {
    const row = db.prepare('SELECT model,instruction,enabled,admin_phones,commands FROM bot_config WHERE account_id=?').get(req.params.id);
    const phones = row ? JSON.parse(row.admin_phones) : [];
    const commands = row ? JSON.parse(row.commands) : [];
    const normalized = normalizePhones(phones);
    if (!normalized || normalized.some((phone, i) => phone !== phones[i]) || !validCommands(commands) || (row && (typeof row.model !== 'string' || (row.model !== '' && !modelPattern.test(row.model)) || typeof row.instruction !== 'string' || row.instruction.length > 16000 || ![0, 1].includes(row.enabled)))) throw new Error();
    res.json({ provider: 'gemini', model: row?.model ?? '', systemInstruction: row?.instruction ?? '', enabled: Boolean(row?.enabled), adminPhones: phones, enabledCommands: commands, keys: keys(req.params.id).map(({ id, priority }) => ({ id, priority })) });
  });

  router.put('/', (req, res) => {
    const body = req.body;
    if (!exact(body, ['model', 'systemInstruction', 'enabled', 'adminPhones', 'enabledCommands']) || typeof body.model !== 'string' || (body.model !== '' && !modelPattern.test(body.model)) || typeof body.systemInstruction !== 'string' || body.systemInstruction.length > 16000 || typeof body.enabled !== 'boolean' || !validCommands(body.enabledCommands)) return invalid(res);
    const phones = normalizePhones(body.adminPhones);
    if (!phones) return invalid(res);
    db.prepare(`INSERT INTO bot_config(account_id,model,instruction,enabled,admin_phones,commands) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET model=excluded.model,instruction=excluded.instruction,enabled=excluded.enabled,admin_phones=excluded.admin_phones,commands=excluded.commands`).run(req.params.id, body.model.replace(/^models\//, ''), body.systemInstruction, Number(body.enabled), JSON.stringify(phones), JSON.stringify(body.enabledCommands));
    res.json({ ok: true });
  });

  router.post('/keys', (req, res) => {
    if (!exact(req.body, ['key']) || !validKey(req.body.key)) return invalid(res);
    const current = keys(req.params.id);
    if (current.length >= 50) return invalid(res);
    const id = randomUUID();
    try {
      const encrypted = encryptBotSecret(req.body.key, req.params.id, id, masterKey());
      db.prepare('INSERT INTO bot_keys(id,account_id,ciphertext,priority) VALUES (?,?,?,?)').run(id, req.params.id, encrypted, current.length ? current[current.length - 1].priority + 1 : 0);
      res.status(201).json({ id });
    } catch { res.status(503).json({ error: 'Kunci bot tidak tersedia' }); }
  });

  router.put('/keys/order', (req, res) => {
    if (!exact(req.body, ['ids']) || !Array.isArray(req.body.ids)) return invalid(res);
    const ids = req.body.ids;
    const current = keys(req.params.id);
    if (ids.length !== current.length || ids.some(id => typeof id !== 'string' || !uuid.test(id)) || new Set(ids).size !== ids.length || ids.some(id => !current.some(row => row.id === id))) return invalid(res);
    db.exec('BEGIN IMMEDIATE');
    try {
      const shift = current.reduce((max, row) => Math.max(max, row.priority), 0) + ids.length + 1;
      db.prepare('UPDATE bot_keys SET priority=priority+? WHERE account_id=?').run(shift, req.params.id);
      const update = db.prepare('UPDATE bot_keys SET priority=? WHERE account_id=? AND id=?');
      ids.forEach((id, index) => update.run(index, req.params.id, id));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    res.json({ ok: true });
  });

  router.put('/keys/:keyId', (req, res) => {
    if (!uuid.test(req.params.keyId) || !exact(req.body, ['key']) || !validKey(req.body.key)) return invalid(res);
    if (!keys(req.params.id).some(row => row.id === req.params.keyId)) return res.status(404).json({ error: 'Kunci tidak ditemukan' });
    try {
      const encrypted = encryptBotSecret(req.body.key, req.params.id, req.params.keyId, masterKey());
      db.prepare('UPDATE bot_keys SET ciphertext=? WHERE id=? AND account_id=?').run(encrypted, req.params.keyId, req.params.id);
      res.json({ ok: true });
    } catch { res.status(503).json({ error: 'Kunci bot tidak tersedia' }); }
  });

  router.delete('/keys/:keyId', (req, res) => {
    if (!uuid.test(req.params.keyId)) return invalid(res);
    if (!db.prepare('DELETE FROM bot_keys WHERE id=? AND account_id=?').run(req.params.keyId, req.params.id).changes) return res.status(404).json({ error: 'Kunci tidak ditemukan' });
    res.json({ ok: true });
  });

  router.post('/models', async (req, res) => {
    if (!exact(req.body, [])) return invalid(res);
    if (!consume(modelRequests, req.user.id, 10)) return res.status(429).json({ error: 'Terlalu banyak permintaan' });
    const current = keys(req.params.id);
    if (!current.length) return res.status(409).json({ error: 'Kunci bot belum tersedia' });
    const version = generation(req.params.id);
    const isCurrent = () => owned(req) && generation(req.params.id) === version;
    try {
      const master = masterKey();
      const secrets = current.map(row => decryptBotSecret(Buffer.from(row.ciphertext), req.params.id, row.id, master));
      if (secrets.some(secret => !validKey(secret))) throw new Error();
      const models = await provider({ keys: secrets, isCurrent }).listModels();
      if (!isCurrent()) return res.status(409).json({ error: 'Akun atau kunci berubah' });
      const serialized = JSON.stringify(models);
      if (!Array.isArray(models) || typeof serialized !== 'string' || secrets.some(secret => serialized.includes(secret))) throw new Error();
      res.json({ provider: 'gemini', models });
    } catch {
      if (!isCurrent()) return res.status(409).json({ error: 'Akun atau kunci berubah' });
      res.status(502).json({ error: 'Daftar model tidak tersedia' });
    }
  });

  router.use((err, req, res, next) => res.status(500).json({ error: 'Konfigurasi bot tidak tersedia' }));
  return router;
}
