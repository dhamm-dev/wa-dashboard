import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('let apkRequest = 0;'), source.indexOf("if (typeof window === 'object')", source.indexOf('let apkRequest = 0;')));
function setup(fetch) {
  const link = { hidden: true };
  const context = vm.createContext({ $: () => link, fetch });
  vm.runInContext(code, context);
  return { link, check: () => vm.runInContext('checkApkDownload()', context) };
}
const response = (status, type) => ({ status, headers: { get: () => type } });

test('APK display style applies only when the initially hidden link is revealed', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(html, /<a\b[^>]*\bid="apk-download"[^>]*\bhidden\b[^>]*>/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;/);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector, body]) => selector.includes('#apk-download') && /\bdisplay\s*:/.test(body));
  assert.equal(rules.length, 1);
  assert.equal(rules[0][1].trim(), '#apk-download:not([hidden])');
  assert.match(rules[0][2], /\bdisplay:\s*inline-flex\s*;/);
});

test('shows the APK link only for a successful HEAD with an accepted media type', async () => {
  for (const type of ['application/vnd.android.package-archive', 'application/octet-stream; charset=binary']) {
    let request;
    const ui = setup(async (...args) => { request = args; return response(200, type); });
    await ui.check();
    assert.equal(ui.link.hidden, false);
    assert.equal(request[0], '/dhexbot-dev.apk');
    assert.equal(request[1].method, 'HEAD'); assert.equal(request[1].credentials, 'omit'); assert.equal(request[1].redirect, 'error');
  }
  for (const result of [response(404, 'application/octet-stream'), response(200, 'text/html'), response(200, null)]) {
    const ui = setup(async () => result); await ui.check(); assert.equal(ui.link.hidden, true);
  }
  const offline = setup(async () => { throw new Error('offline'); }); await offline.check(); assert.equal(offline.link.hidden, true);
});

test('link stays hidden while checking and ignores an older response', async () => {
  const pending = [];
  const ui = setup(() => new Promise(resolve => pending.push(resolve)));
  const older = ui.check(), newer = ui.check();
  assert.equal(ui.link.hidden, true);
  pending[1](response(404, 'text/html')); await newer;
  pending[0](response(200, 'application/octet-stream')); await older;
  assert.equal(ui.link.hidden, true);
});
