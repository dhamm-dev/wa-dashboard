import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { botSecretKey, decryptBotSecret, encryptBotSecret } from '../src/bot-secret.js';

test('bot encryption key requires canonical base64 encoding of exactly 32 bytes', () => {
  const encoded = randomBytes(32).toString('base64');
  assert.equal(botSecretKey(encoded).length, 32);
  for (const invalid of ['', 'x', randomBytes(31).toString('base64'), encoded.slice(0, -1), `${'A'.repeat(42)}B=`]) {
    assert.throws(() => botSecretKey(invalid), error => !error.message.includes(invalid || 'x'));
  }
});

test('encrypted provider keys are randomized and bound to account and key identity', () => {
  const key = randomBytes(32), secret = 'provider-secret';
  const account = '11111111-1111-4111-8111-111111111111';
  const keyId = '22222222-2222-4222-8222-222222222222';
  const first = encryptBotSecret(secret, account, keyId, key);
  const second = encryptBotSecret(secret, account, keyId, key);
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(Buffer.from(secret)), false);
  assert.equal(decryptBotSecret(first, account, keyId, key), secret);
  assert.throws(() => decryptBotSecret(first, 'another-account', keyId, key));
  assert.throws(() => decryptBotSecret(first, account, 'another-key', key));
  assert.throws(() => decryptBotSecret(first, account, keyId, randomBytes(32)));
  for (const offset of [0, 1, 13, 29]) {
    const tampered = Buffer.from(first);
    tampered[offset] ^= 1;
    assert.throws(() => decryptBotSecret(tampered, account, keyId, key));
  }
});
