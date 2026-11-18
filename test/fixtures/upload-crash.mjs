import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (process.env.TEST_RECOVERY_CRASH) {
  const original = fs.promises.unlink;
  fs.promises.unlink = async path => {
    await original(path);
    if (typeof path === 'string' && /\/uploads-v2\/[^/]+\/data$/.test(path)) process.exit(92);
  };
  syncBuiltinESMExports();
}

if (process.env.TEST_UPLOAD_CRASH) {
  const original = fs.promises.open;
  fs.promises.open = async (path, ...args) => {
    if (typeof path !== 'string' || !/\/uploads-v2\/[^/]+\/data$/.test(path)) return original(path, ...args);
    if (process.env.TEST_UPLOAD_CRASH === 'before') process.exit(91);
    const file = await original(path, ...args);
    if (process.env.TEST_UPLOAD_CRASH === 'partial') { await file.writeFile('partial'); await file.sync(); process.exit(91); }
    return {
      async writeFile(bytes) { await file.writeFile(bytes); if (process.env.TEST_UPLOAD_CRASH === 'written') process.exit(91); },
      async sync() { await file.sync(); if (process.env.TEST_UPLOAD_CRASH === 'synced') process.exit(91); },
      close: () => file.close()
    };
  };
  syncBuiltinESMExports();
}
