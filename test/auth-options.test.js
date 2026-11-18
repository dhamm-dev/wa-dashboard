import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('public auth options reflect signup policy without authentication or secrets', async () => {
  for (const [preview, signup, enabled] of [[undefined, undefined, false], ['', '1', true], ['1', '1', false], ['', 'true', false]]) {
    const dir = mkdtempSync(join(tmpdir(), 'auth-options-'));
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'x', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters' };
    delete env.DHEXBOT_PRIVATE_PREVIEW; delete env.DHEXBOT_PUBLIC_SIGNUP;
    if (preview !== undefined) env.DHEXBOT_PRIVATE_PREVIEW = preview;
    if (signup !== undefined) env.DHEXBOT_PUBLIC_SIGNUP = signup;
    const child = spawn(process.execPath, ['src/server.js'], { env, stdio: 'ignore' });
    try {
      let response;
      for (let i = 0; i < 100; i++) {
        try { response = await fetch(`http://127.0.0.1:${port}/api/auth/options`); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      assert.ok(response);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { publicSignup: enabled });
    } finally {
      child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
