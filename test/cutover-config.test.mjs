import test from 'node:test';
import assert from 'node:assert/strict';
import { createCutoverConfig } from '../tools/cutover-config.mjs';

test('preview configuration applies the clone after the original and private environment files', () => {
  const config = createCutoverConfig('0123456789abcdef0123456789abcdef');
  assert.match(config.clone, /\/data-0123456789abcdef0123456789abcdef$/);
  assert.equal(config.previewEnvironment, `DATA_DIR=${config.clone}\nHOST=127.0.0.1\nPORT=3000\n`);
  const lines = config.previewDropin.trim().split('\n');
  assert.deepEqual(lines.filter(line => line.startsWith('EnvironmentFile=')), [
    'EnvironmentFile=',
    'EnvironmentFile=/home/dhexweb/wa-dashboard/.env',
    'EnvironmentFile=/home/dhexweb/dhexbot-preview-release-05aee121be1701ab/config/preview.env',
    `EnvironmentFile=${config.cutoverEnv}`,
  ]);
  assert.ok(lines.includes('UnsetEnvironment=DHEXBOT_SAFE_BOOT'));
  assert.ok(lines.includes('ExecStart=/usr/bin/node /home/dhexweb/dhexbot-preview-release-37ec9a3cc5828208/app/src/server.js'));
});

test('rollback configuration returns both source and data to their original locations', () => {
  const config = createCutoverConfig('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(config.rollbackEnvironment, 'DATA_DIR=/home/dhexweb/wa-dashboard/data\nHOST=127.0.0.1\nPORT=3000\n');
  assert.match(config.rollbackDropin, /WorkingDirectory=\/home\/dhexweb\/wa-dashboard\n/);
  assert.match(config.rollbackDropin, /ExecStart=\/usr\/bin\/node \/home\/dhexweb\/wa-dashboard\/src\/server\.js\n/);
  assert.ok(config.rollbackDropin.includes(`EnvironmentFile=${config.rollbackEnv}\n`));
  assert.ok(!config.rollbackDropin.includes('config/preview.env'));
  assert.ok(config.rollbackDropin.includes('UnsetEnvironment=DHEXBOT_SAFE_BOOT\n'));
});

test('identifiers cannot change the generated paths or inject systemd settings', () => {
  for (const value of ['', '../data', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}\nExecStart=x`, null, 1]) {
    assert.throws(() => createCutoverConfig(value), TypeError);
  }
});
