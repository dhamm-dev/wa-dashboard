import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiProvider, GeminiError } from '../src/gemini.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const answer = { candidates: [{ content: { parts: [{ text: 'Hello' }, { text: ' world' }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 } };
const create = (fetch, options = {}) => createGeminiProvider({ keys: ['secret-first', 'secret-second'], fetch, ...options });

test('generation sends history and system instruction and reports actual usage', async () => {
  const calls = [];
  const gemini = create(async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json({ error: 'secret-first' }, 401) : json(answer);
  });
  assert.deepEqual(await gemini.generateText({ model: 'models/gemini-2.0-flash', text: 'Question', systemInstruction: 'Be brief', history: [{ role: 'user', text: 'Hi' }, { role: 'model', text: 'Hello' }] }), { text: 'Hello world', usage: { inputTokens: 8, outputTokens: 3 } });
  assert.deepEqual(calls.map(call => call.options.headers['x-goog-api-key']), ['secret-first', 'secret-second']);
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), { systemInstruction: { parts: [{ text: 'Be brief' }] }, contents: [{ role: 'user', parts: [{ text: 'Hi' }] }, { role: 'model', parts: [{ text: 'Hello' }] }, { role: 'user', parts: [{ text: 'Question' }] }] });
  assert.ok(calls.every(call => !call.url.includes('secret')));
});

test('only definitive retryable HTTP responses cause key fallback', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    let calls = 0;
    const gemini = create(async () => ++calls === 1 ? json({}, status) : json(answer));
    await gemini.generateText({ model: 'test', text: 'hi' });
    assert.equal(calls, 2, String(status));
  }
  for (const status of [400, 404, 422]) {
    let calls = 0;
    const gemini = create(async () => { calls++; return json({ error: 'secret-first' }, status); });
    await assert.rejects(gemini.generateText({ model: 'test', text: 'hi' }), error => error.code === 'invalid_request' && error.status === status && !error.retryable && !String(error).includes('secret'));
    assert.equal(calls, 1);
  }
  const exhausted = create(async () => json({ error: 'secret-first' }, 429));
  await assert.rejects(exhausted.generateText({ model: 'test', text: 'hi' }), error => error instanceof GeminiError && error.code === 'rate_limit' && error.status === 429 && !JSON.stringify(error).includes('secret'));
});

test('ambiguous failures, malformed responses and invalid inputs do not trigger fallback', async () => {
  for (const fetch of [async () => { throw new Error('secret-first'); }, async () => new Response('not json'), async () => json({ candidates: [] })]) {
    let calls = 0;
    const gemini = create(async (...args) => { calls++; return fetch(...args); });
    await assert.rejects(gemini.generateText({ model: 'test', text: 'hello' }), error => error instanceof GeminiError && !error.retryable && !String(error).includes('secret'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const gemini = create(async () => { calls++; return new Promise(() => {}); }, { timeoutMs: 10 });
  await assert.rejects(gemini.generateText({ model: 'test', text: 'hello' }), { code: 'timeout' });
  assert.equal(calls, 1);
  for (const model of ['../bad', 'models/a/b', 'x?key=secret', '']) await assert.rejects(gemini.generateText({ model, text: 'hi' }), { code: 'invalid_request' });
  await assert.rejects(gemini.generateText({ model: 'test', text: 'hi', history: [{ role: 'system', text: 'no' }] }), { code: 'invalid_request' });
  await assert.rejects(gemini.generateText({ model: 'test', text: 'x'.repeat(100001) }), { code: 'invalid_request' });
  assert.equal(calls, 1);
});

test('listing paginates and restarts cleanly on a retryable response', async () => {
  const calls = [];
  const gemini = create(async (url, options) => {
    calls.push([url, options.headers['x-goog-api-key']]);
    if (calls.length === 1) return json({ models: [{ name: 'models/old', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'page +1' });
    if (calls.length === 2) return json({}, 429);
    if (calls.length === 3) return json({ models: [{ name: 'models/new', displayName: 'New', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' });
    return json({ models: [{ name: 'models/other', supportedGenerationMethods: ['countTokens'] }] });
  });
  assert.deepEqual(await gemini.listModels(), [{ name: 'models/new', displayName: 'New', supportedGenerationMethods: ['generateContent'] }, { name: 'models/other', displayName: null, supportedGenerationMethods: ['countTokens'] }]);
  assert.match(calls[1][0], /pageToken=page\+%2B1/);
  assert.deepEqual(calls.map(call => call[1]), ['secret-first', 'secret-first', 'secret-second', 'secret-second']);
  assert.ok(calls.every(call => !call[0].includes('secret')));
});

test('bounds pagination and response size; absent usage is null', async () => {
  let calls = 0;
  const loop = create(async () => { calls++; return json({ nextPageToken: 'same' }); });
  await assert.rejects(loop.listModels(), { code: 'invalid_response' });
  assert.equal(calls, 2);
  calls = 0;
  const endless = create(async () => json({ nextPageToken: String(++calls) }));
  await assert.rejects(endless.listModels(), { code: 'pagination_limit' });
  assert.equal(calls, 20);
  const big = create(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(big.listModels(), { code: 'response_too_large' });
  const missing = create(async () => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  assert.deepEqual(await missing.generateText({ model: 'test', text: 'hi' }), { text: 'ok', usage: { inputTokens: null, outputTokens: null } });
});

test('empty system instruction is omitted and limits apply to instructions and history', async () => {
  const bodies = [];
  const gemini = create(async (_url, options) => { bodies.push(JSON.parse(options.body)); return json(answer); });
  await gemini.generateText({ model: 'test', text: 'hi', systemInstruction: '' });
  await gemini.generateText({ model: 'test', text: 'hi' });
  assert.ok(bodies.every(body => !Object.hasOwn(body, 'systemInstruction')));
  await gemini.generateText({ model: 'test', text: 'hi', systemInstruction: 'x'.repeat(16000) });
  await assert.rejects(gemini.generateText({ model: 'test', text: 'hi', systemInstruction: 'x'.repeat(16001) }), { code: 'invalid_request' });
  await assert.rejects(gemini.generateText({ model: 'test', text: 'hi', history: Array.from({ length: 101 }, () => ({ role: 'user', text: 'x' })) }), { code: 'invalid_request' });
  await assert.rejects(gemini.generateText({ model: 'test', text: 'hi', history: [{ role: 'model', text: 'x'.repeat(100000) }] }), { code: 'invalid_request' });
  assert.equal(bodies.length, 3);
});

test('revoked configuration cancels before requests, after responses and before fallback', async () => {
  let current = false;
  let calls = 0;
  const gemini = create(async () => { calls++; current = false; return json({}, 429); }, { isCurrent: async () => current });
  await assert.rejects(gemini.generateText({ model: 'test', text: 'hi' }), { code: 'cancelled' });
  assert.equal(calls, 0);
  current = true;
  await assert.rejects(gemini.generateText({ model: 'test', text: 'hi' }), error => error.code === 'cancelled' && !error.retryable && !String(error).includes('secret'));
  assert.equal(calls, 1);
  current = true;
  const success = create(async () => { current = false; return json(answer); }, { isCurrent: () => current });
  await assert.rejects(success.generateText({ model: 'test', text: 'hi' }), { code: 'cancelled' });
  const failedGuard = create(async () => { throw new Error('should not run'); }, { isCurrent: () => { throw new Error('secret-first'); } });
  await assert.rejects(failedGuard.listModels(), error => error.code === 'cancelled' && !String(error).includes('secret'));
});
