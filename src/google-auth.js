import { createPublicKey, verify } from 'node:crypto';

const jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';
const decode = part => {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Token tidak valid');
  return Buffer.from(part, 'base64url');
};

export async function verifyGoogleToken(token, { audience, nonce, fetchKeys = fetch, now = Date.now() }) {
  if (!audience || typeof token !== 'string' || token.length > 16384) throw new Error('Token tidak valid');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Token tidak valid');
  const header = JSON.parse(decode(parts[0]));
  const claims = JSON.parse(decode(parts[1]));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit !== undefined) throw new Error('Token tidak valid');
  const response = await fetchKeys(jwksUrl, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Kunci Google tidak tersedia');
  if (!response.body) throw new Error('Kunci Google tidak valid');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) { await reader.cancel(); throw new Error('Kunci Google tidak valid'); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const { keys } = JSON.parse(text);
  if (!Array.isArray(keys)) throw new Error('Kunci Google tidak valid');
  const matches = keys.filter(k => k.kid === header.kid && k.kty === 'RSA' && k.use === 'sig' && (!k.alg || k.alg === 'RS256'));
  if (matches.length !== 1 || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: matches[0], format: 'jwk' }), decode(parts[2]))) throw new Error('Signature tidak valid');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== audience || (claims.azp !== undefined && claims.azp !== audience) || !Number.isSafeInteger(claims.exp) || claims.exp <= now / 1000 || !Number.isSafeInteger(claims.iat) || claims.iat > now / 1000 + 60 || typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub) || claims.nonce !== nonce) throw new Error('Klaim tidak valid');
  return claims;
}
