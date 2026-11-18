import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function botSecretKey(value = process.env.BOT_SECRET_ENCRYPTION_KEY) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('BOT_SECRET_ENCRYPTION_KEY harus berupa base64 untuk 32 byte');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('BOT_SECRET_ENCRYPTION_KEY harus berupa base64 untuk 32 byte');
  return key;
}

function context(accountId, keyId) {
  if (typeof accountId !== 'string' || !accountId || typeof keyId !== 'string' || !keyId) throw new Error('Konteks kunci bot tidak valid');
  return Buffer.from(JSON.stringify(['bot-secret-v1', accountId, keyId]));
}

export function encryptBotSecret(secret, accountId, keyId, key = botSecretKey()) {
  if (typeof secret !== 'string' || !secret) throw new Error('Kunci provider tidak valid');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(context(accountId, keyId));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBotSecret(value, accountId, keyId, key = botSecretKey()) {
  try {
    if (!Buffer.isBuffer(value) || value.length < 30 || value[0] !== 1) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13));
    decipher.setAAD(context(accountId, keyId));
    decipher.setAuthTag(value.subarray(13, 29));
    return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Kunci provider tidak dapat didekripsi');
  }
}
