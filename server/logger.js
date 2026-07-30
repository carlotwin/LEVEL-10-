// Structured per-run / per-row logger. Writes JSONL to the data dir and mirrors
// a compact line to the console. Kept dependency-free.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './data/paths.js';

const LOG_FILE = () => path.join(dataDir(), 'run.log.jsonl');

function write(entry) {
  const rec = { ts: new Date().toISOString(), ...entry };
  try {
    fs.appendFileSync(LOG_FILE(), JSON.stringify(rec) + '\n');
  } catch {
    /* logging must never crash the run */
  }
  return rec;
}

export const logger = {
  info: (event, data = {}) => write({ level: 'info', event, ...data }),
  warn: (event, data = {}) => write({ level: 'warn', event, ...data }),
  error: (event, data = {}) => write({ level: 'error', event, ...data }),
  row: (contactId, disposition, data = {}) =>
    write({ level: 'row', event: 'row_processed', contactId, disposition, ...data }),
  read: (limit = 500) => {
    try {
      const text = fs.readFileSync(LOG_FILE(), 'utf8').trim();
      if (!text) return [];
      const lines = text.split('\n');
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  },
};
