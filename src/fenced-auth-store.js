import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { privatePreview } from './private-preview.js';

export async function createFencedAuthStore(folder, { fs = filesystem } = {}) {
  const info = await fs.stat(folder).catch(() => undefined);
  if (info && !info.isDirectory()) {
    throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
  }
  if (!info) await fs.mkdir(folder, { recursive: true });

  const path = (file) => join(folder, file.replace(/\//g, '__').replace(/:/g, '-'));
  let terminal = false;
  let tail = Promise.resolve();
  const check = () => {
    if (terminal) throw new Error('auth store is fenced');
  };
  const read = async (file) => {
    check();
    try {
      return JSON.parse(await fs.readFile(path(file), { encoding: 'utf-8' }), BufferJSON.reviver);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const creds = (await read('creds.json')) || initAuthCreds();
  const run = (operation) => {
    if (terminal) return Promise.reject(new Error('auth store is fenced'));
    const result = tail.then(() => {
      check();
      return operation();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const state = {
    creds,
    keys: {
      get: (type, ids) => run(async () => {
        const data = {};
        for (const id of ids) {
          let value = await read(`${type}-${id}.json`);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[id] = value;
        }
        return data;
      }),
      set: (data) => run(async () => {
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const file = path(`${category}-${id}.json`);
            check();
            if (value) {
              await fs.writeFile(file, JSON.stringify(value, BufferJSON.replacer));
            } else if (privatePreview) {
              await fs.writeFile(file, 'null');
            } else {
              try { await fs.unlink(file); } catch (error) {
                if (error.code !== 'ENOENT') throw error;
              }
            }
          }
        }
      })
    }
  };
  return {
    state,
    saveCreds: () => run(() => {
      check();
      const { pairingCode, ...persistedCreds } = creds;
      return fs.writeFile(path('creds.json'), JSON.stringify(persistedCreds, BufferJSON.replacer));
    }),
    fence: () => {
      terminal = true;
      return tail;
    }
  };
}
