import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryInodes } from '../tools/inventory-inodes.mjs';
import { writerCensus } from '../tools/writer-census.mjs';

test('maps identities losslessly, deduplicating hardlinks by device and inode', async () => {
  const manifest = [
    { path: 'private', device: '9007199254740993', inode: '18446744073709551615' },
    { path: 'hardlink', device: '9007199254740993', inode: '18446744073709551615' },
    { path: 'other device', device: '2', inode: '18446744073709551615' },
    { path: '', device: '0', inode: '0' }
  ];
  const inventory = inventoryInodes(manifest);
  assert.deepEqual(inventory, [
    { dev: 9007199254740993n, ino: 18446744073709551615n },
    { dev: 2n, ino: 18446744073709551615n },
    { dev: 0n, ino: 0n }
  ]);
  const reader = {
    listProcesses: async () => [1, 2],
    listFds: async pid => pid === 2 ? [3] : [],
    processInfo: async () => ({ uid: 1, startTime: 1 }),
    statFd: async () => ({ dev: 9007199254740993n, ino: 18446744073709551615n })
  };
  assert.deepEqual(await writerCensus({ reader, inventory, selfPid: 1, proveNonWriter: async () => false }),
    { complete: true, externalWriters: 1 });
});

test('rejects malformed identities without exposing filenames', () => {
  for (const value of [undefined, null, '', '01', '-1', '+1', ' 1', '1\n', '1.0', '0x10', 1, 1n,
    '18446744073709551616', '9'.repeat(100)]) {
    for (const field of ['device', 'inode']) {
      assert.throws(() => inventoryInodes([{ path: 'private filename', device: '1', inode: '2', [field]: value }]),
        { message: 'Invalid inventory' });
    }
  }
  for (const manifest of [null, {}, [], [null], [1], [{ device: '1' }], new Array(1)]) {
    assert.throws(() => inventoryInodes(manifest), { message: 'Invalid inventory' });
  }
});
