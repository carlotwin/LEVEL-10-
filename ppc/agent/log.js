// Safe logging: JSON lines under data/ppc/logs, printed to the console too.
// Secrets (tokens, keys, passwords, cookies) and personal details (emails,
// phone numbers) are masked before anything is written.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SECRET_KEYS = /(token|secret|password|passwd|authorization|cookie|apikey|api_key|private_key|client_secret|refresh|assertion|session)/i;

export function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._\-~+/]+=*/gi, '$1[redacted]')
      .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]')
      .replace(/1\/\/[A-Za-z0-9._-]{20,}/g, '[redacted]')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted key]')
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
      .replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redact(value.message), code: value.code };
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function createLogger(dataDir, { quiet = false } = {}) {
  const dir = path.join(dataDir, 'logs');
  let file = null;
  try {
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, `agent-${new Date().toISOString().slice(0, 10)}.jsonl`);
  } catch { /* logging to console only */ }
  const write = (level, event, data = {}) => {
    const entry = { at: new Date().toISOString(), level, event, ...redact(data) };
    if (file) {
      try { appendFileSync(file, `${JSON.stringify(entry)}\n`); } catch { /* ignore */ }
    }
    if (!quiet) {
      const line = `${entry.at.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${event}${data.message ? ` · ${redact(data.message)}` : ''}`;
      (level === 'error' ? console.error : console.log)(line);
    }
    return entry;
  };
  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
}
