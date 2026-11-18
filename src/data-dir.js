import { mkdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const requestedDataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(requestedDataDir, { recursive: true, mode: 0o700 });
export const dataDir = realpathSync(requestedDataDir);
const publicDir = realpathSync(fileURLToPath(new URL('../public/', import.meta.url)));
const publicRelative = relative(publicDir, dataDir);
if (!publicRelative || (!publicRelative.startsWith('..' + '/') && publicRelative !== '..' && !isAbsolute(publicRelative))) throw new Error('DATA_DIR tidak boleh berada di direktori publik');
