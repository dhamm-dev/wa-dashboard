import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:3000';
const CALLBACK = 'https://wa.dhexx.my.id/api/google/android/callback';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function validateAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('URL otorisasi tidak valid');
  let url;
  try { url = new URL(value); } catch { throw new Error('URL otorisasi tidak valid'); }
  const keys = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];
  if (url.origin !== 'https://accounts.google.com' || url.username || url.password || url.pathname !== '/o/oauth2/v2/auth' || url.hash ||
      [...url.searchParams.keys()].length !== keys.length || keys.some(key => url.searchParams.getAll(key).length !== 1) ||
      url.searchParams.get('redirect_uri') !== CALLBACK || url.searchParams.get('response_type') !== 'code' ||
      url.searchParams.get('scope') !== 'openid email' || url.searchParams.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9._-]{1,255}$/.test(url.searchParams.get('client_id')) ||
      !['state', 'nonce', 'code_challenge'].every(key => validToken(url.searchParams.get(key)))) throw new Error('URL otorisasi tidak valid');
  return url.toString();
}

export async function linkProductionAdmin({ password, request = fetch, now = Date.now, delay = sleep, output = console.log }) {
  if (typeof password !== 'string' || !password) throw new Error('ADMIN_PASSWORD tidak tersedia di environment');
  const deadline = now() + 300000;
  let cookie = '';
  async function post(path, body) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('Batas waktu 5 menit habis');
    let response, data;
    try {
      response = await request(BASE + path, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(remaining, 10000)),
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-dashboard-request': '1', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body)
      });
      if (!response.ok || response.redirected) throw new Error();
      if (Number(response.headers.get('content-length')) > 16384 || !response.body) throw new Error();
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('Permintaan produksi gagal atau respons tidak valid'); }
    const sessions = response.headers.getSetCookie().filter(value => /^connect\.sid=/i.test(value));
    if (sessions.length > 1) throw new Error('Cookie sesi tidak valid');
    if (sessions.length) {
      const value = sessions[0];
      if (!/;\s*secure(?:;|$)/i.test(value) || !/^connect\.sid=[^;\s]+/i.test(value)) throw new Error('Cookie sesi tidak aman');
      cookie = value.split(';', 1)[0];
    }
    return data;
  }
  const login = await post('/api/login', { password });
  password = undefined;
  if (login?.ok !== true || !cookie) throw new Error('Login admin gagal');
  const secret = randomBytes(32).toString('base64url');
  const started = await post('/api/google/android/start', { purpose: 'link', secret });
  if (!validToken(started?.id)) throw new Error('Transaksi produksi tidak valid');
  const url = validateAuthorizationUrl(started.authorizationUrl);
  output('URL berikut sensitif. Buka sendiri di browser dan jangan bagikan atau simpan:');
  output(url);
  output('Masuk dengan akun Google yang email terverifikasinya sama dengan email admin produksi. Menunggu callback (maksimal 5 menit)...');
  while (now() < deadline) {
    await delay(Math.min(2000, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const result = await post('/api/google/android/poll', { id: started.id, secret });
    if (result?.status === 'complete') { output('Akun Google berhasil ditautkan ke admin produksi.'); return; }
    if (result?.status !== 'pending') throw new Error('Status transaksi tidak valid');
  }
  throw new Error('Batas waktu 5 menit habis; callback mungkin sudah menautkan akun sebelum polling selesai');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const password = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  if (process.argv.length !== 2) {
    console.error('Jangan gunakan argumen; ADMIN_PASSWORD harus tersedia di environment.');
    process.exitCode = 1;
  } else if (!process.stdout.isTTY) {
    console.error('Jalankan pada terminal pribadi; output tidak boleh dialihkan.');
    process.exitCode = 1;
  } else {
    try { await linkProductionAdmin({ password }); }
    catch (error) {
      const safeErrors = new Set([
        'ADMIN_PASSWORD tidak tersedia di environment', 'Batas waktu 5 menit habis',
        'Permintaan produksi gagal atau respons tidak valid', 'Cookie sesi tidak valid', 'Cookie sesi tidak aman',
        'Login admin gagal', 'Transaksi produksi tidak valid', 'URL otorisasi tidak valid', 'Status transaksi tidak valid',
        'Batas waktu 5 menit habis; callback mungkin sudah menautkan akun sebelum polling selesai'
      ]);
      console.error(safeErrors.has(error?.message) ? error.message : 'Bootstrap produksi gagal.');
      process.exitCode = 1;
    }
  }
}
