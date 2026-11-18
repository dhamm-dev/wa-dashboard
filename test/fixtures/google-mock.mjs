const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => url === 'https://www.googleapis.com/oauth2/v3/certs'
  ? Promise.resolve(new Response(JSON.stringify({ keys: [JSON.parse(process.env.TEST_GOOGLE_JWK)] })))
  : realFetch(url, options);
