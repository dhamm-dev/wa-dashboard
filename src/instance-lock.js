import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dataDir } from './data-dir.js';

const lock = new DatabaseSync(join(dataDir, 'instance-lock.sqlite'));
try { lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE'); }
catch (error) { lock.close(); throw new Error('DATA_DIR sedang digunakan atau tidak dapat dikunci', { cause: error }); }
export { lock };
