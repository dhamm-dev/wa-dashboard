const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 100000;
const MAX_PAGES = 20;
const MAX_MODELS = 2000;

export class GeminiError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const invalidRequest = () => new GeminiError('invalid_request', 'Invalid Gemini request.');
const invalidResponse = () => new GeminiError('invalid_response', 'Invalid Gemini response.');

function modelId(model) {
  if (typeof model !== 'string' || !/^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) throw invalidRequest();
  return model.replace(/^models\//, '');
}

function statusError(status) {
  if (status === 401 || status === 403) return new GeminiError('authentication', 'Gemini rejected the API key.', { status, retryable: true });
  if (status === 429) return new GeminiError('rate_limit', 'Gemini rate or quota limit reached.', { status, retryable: true });
  if (status >= 500 && status <= 599) return new GeminiError('provider_error', 'Gemini provider error.', { status, retryable: true });
  return new GeminiError('invalid_request', 'Gemini rejected the request.', { status });
}

async function readJson(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) throw new GeminiError('response_too_large', 'Gemini response exceeded the size limit.');
  if (!response.body || typeof response.body.getReader !== 'function') throw invalidResponse();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new GeminiError('response_too_large', 'Gemini response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidResponse();
  }
}

export function createGeminiProvider({ keys, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, isCurrent = () => true } = {}) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 50 || keys.some(key => typeof key !== 'string' || !key.trim() || key.length > 4096 || /[^\x20-\x7e]/.test(key)) || typeof fetchImpl !== 'function' || typeof isCurrent !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw invalidRequest();
  const apiKeys = [...keys];

  async function checkCurrent() {
    let current;
    try { current = await isCurrent(); } catch { current = false; }
    if (current !== true) throw new GeminiError('cancelled', 'Gemini request cancelled.');
  }

  async function request(path, key, body) {
    await checkCurrent();
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new GeminiError('timeout', 'Gemini request timed out.'));
        controller.abort();
      }, timeoutMs);
    });
    const operation = (async () => {
      let response;
      try {
        const current = isCurrent();
        if ((current && typeof current.then === 'function' ? await current : current) !== true) throw new GeminiError('cancelled', 'Gemini request cancelled.');
        response = await fetchImpl(BASE + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'x-goog-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error', signal: controller.signal
        });
      } catch (error) {
        if (error instanceof GeminiError && error.code === 'cancelled') throw error;
        throw new GeminiError('network_error', 'Gemini network request failed.');
      }
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw invalidResponse();
      if (response.status < 200 || response.status >= 300) {
        if (response.body?.cancel) void response.body.cancel().catch(() => {});
        throw statusError(response.status);
      }
      try { return await readJson(response); } catch (error) {
        if (error instanceof GeminiError) throw error;
        throw new GeminiError('network_error', 'Gemini response could not be read.');
      }
    })();
    try {
      const result = await Promise.race([operation, timeout]);
      await checkCurrent();
      return result;
    } catch (error) {
      await checkCurrent();
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function withKeys(action) {
    for (let i = 0; i < apiKeys.length; i++) {
      await checkCurrent();
      try {
        const result = await action(apiKeys[i]);
        await checkCurrent();
        return result;
      } catch (error) {
        await checkCurrent();
        if (!(error instanceof GeminiError) || !error.retryable || i === apiKeys.length - 1) throw error;
      }
    }
  }

  async function listModels() {
    return withKeys(async key => {
      const models = [];
      const tokens = new Set();
      let token;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ pageSize: '100' });
        if (token) query.set('pageToken', token);
        const data = await request(`/models?${query}`, key);
        if (!data || typeof data !== 'object' || Array.isArray(data) || (data.models !== undefined && !Array.isArray(data.models))) throw invalidResponse();
        for (const model of data.models ?? []) {
          if (!model || typeof model.name !== 'string' || !Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.every(method => typeof method === 'string')) throw invalidResponse();
          let id;
          try { id = modelId(model.name); } catch { throw invalidResponse(); }
          if (models.length >= MAX_MODELS) throw new GeminiError('pagination_limit', 'Gemini model list exceeded the limit.');
          models.push({ name: `models/${id}`, displayName: typeof model.displayName === 'string' ? model.displayName.slice(0, 512) : null, supportedGenerationMethods: model.supportedGenerationMethods });
        }
        token = data.nextPageToken;
        if (token === undefined || token === '') return models;
        if (typeof token !== 'string' || token.length > 2048 || tokens.has(token)) throw invalidResponse();
        tokens.add(token);
      }
      throw new GeminiError('pagination_limit', 'Gemini model list exceeded the limit.');
    });
  }

  async function generateText({ model, text, systemInstruction, history = [] } = {}) {
    const id = modelId(model);
    if (typeof text !== 'string' || !text.trim() || !Array.isArray(history) || history.length > 100 || (systemInstruction !== undefined && (typeof systemInstruction !== 'string' || systemInstruction.length > 16000))) throw invalidRequest();
    let length = text.length + (systemInstruction?.length ?? 0);
    const contents = history.map(item => {
      if (!item || !['user', 'model'].includes(item.role) || typeof item.text !== 'string' || !item.text.trim()) throw invalidRequest();
      length += item.text.length;
      return { role: item.role, parts: [{ text: item.text }] };
    });
    if (length > MAX_TEXT_LENGTH) throw invalidRequest();
    contents.push({ role: 'user', parts: [{ text }] });
    const body = { contents, ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}) };
    const data = await withKeys(key => request(`/models/${encodeURIComponent(id)}:generateContent`, key, body));
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0 || parts.some(part => !part || typeof part.text !== 'string')) throw invalidResponse();
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { text: parts.map(part => part.text).join(''), usage: { inputTokens: count(data.usageMetadata?.promptTokenCount), outputTokens: count(data.usageMetadata?.candidatesTokenCount) } };
  }

  return { listModels, generateText };
}
