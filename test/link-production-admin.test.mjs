import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkProductionAdmin, validateAuthorizationUrl } from '../tools/link-production-admin.mjs';

const token = 'a'.repeat(43);
function authorizationUrl() {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({
    client_id: 'client.apps.googleusercontent.com', redirect_uri: 'https://wa.dhexx.my.id/api/google/android/callback',
    response_type: 'code', scope: 'openid email', state: token, nonce: token,
    code_challenge: token, code_challenge_method: 'S256'
  })) url.searchParams.set(key, value);
  return url;
}
function response(data, cookie) {
  return new Response(JSON.stringify(data), { headers: cookie ? { 'set-cookie': cookie } : {} });
}

test('authorization URL accepts only the exact production Google flow', () => {
  const valid = authorizationUrl();
  assert.equal(validateAuthorizationUrl(valid.toString()), valid.toString());
  for (const mutate of [
    u => u.searchParams.set('redirect_uri', 'https://wa-staging.dhexx.my.id/api/google/android/callback'),
    u => u.searchParams.set('redirect_uri', 'http://wa.dhexx.my.id/api/google/android/callback'),
    u => { u.hostname = 'accounts.google.com.example.com'; },
    u => u.searchParams.append('state', token),
    u => u.searchParams.set('code_challenge_method', 'plain'),
    u => u.searchParams.set('nonce', 'invalid'),
    u => u.searchParams.set('extra', 'value'),
    u => { u.hash = '#fragment'; }
  ]) {
    const url = authorizationUrl();
    mutate(url);
    assert.throws(() => validateAuthorizationUrl(url.toString()));
  }
});

test('authenticated link and polling use only production loopback, keeping secrets out of output', async () => {
  const calls = [], output = [], url = authorizationUrl().toString();
  const request = async (address, options) => {
    calls.push({ address, options, body: JSON.parse(options.body) });
    if (calls.length === 1) return response({ ok: true }, 'connect.sid=synthetic-session; Path=/; HttpOnly; Secure');
    if (calls.length === 2) return response({ id: token, authorizationUrl: url });
    return response({ status: calls.length === 3 ? 'pending' : 'complete' });
  };
  await linkProductionAdmin({ password: 'synthetic-password', request, delay: async () => {}, output: line => output.push(line) });
  assert.deepEqual(calls.map(call => call.address), [
    'http://127.0.0.1:3000/api/login', 'http://127.0.0.1:3000/api/google/android/start',
    'http://127.0.0.1:3000/api/google/android/poll', 'http://127.0.0.1:3000/api/google/android/poll'
  ]);
  assert.deepEqual(calls[0].body, { password: 'synthetic-password' });
  assert.equal(calls[0].options.headers.cookie, undefined);
  assert.equal(calls[1].options.headers.cookie, 'connect.sid=synthetic-session');
  assert.equal(calls[1].body.purpose, 'link');
  assert.match(calls[1].body.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(calls[2].body, { id: token, secret: calls[1].body.secret });
  assert.equal(output.filter(line => line === url).length, 1);
  assert.doesNotMatch(output.join('\n'), /synthetic-password|synthetic-session/);
  assert.ok(!output.join('\n').includes(calls[1].body.secret));
});

test('failed authentication and invalid production URL never expose a URL or poll', async () => {
  for (const mode of ['login', 'url']) {
    let count = 0;
    const output = [];
    const request = async () => {
      count++;
      if (count === 1) return response({ ok: mode !== 'login' }, 'connect.sid=session; Secure');
      const url = authorizationUrl();
      url.searchParams.set('redirect_uri', 'https://wa-staging.dhexx.my.id/api/google/android/callback');
      return response({ id: token, authorizationUrl: url.toString() });
    };
    await assert.rejects(linkProductionAdmin({ password: 'password', request, output: line => output.push(line) }));
    assert.equal(count, mode === 'login' ? 1 : 2);
    assert.deepEqual(output, []);
  }
});

test('CLI refuses redirected output and arguments before any network request', () => {
  const script = new URL('../tools/link-production-admin.mjs', import.meta.url);
  for (const args of [[], ['unexpected']]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], { env: { ...process.env, ADMIN_PASSWORD: 'synthetic-password' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /synthetic-password|https?:\/\//);
  }
});
