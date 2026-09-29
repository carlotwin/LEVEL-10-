// Encryption for the saved REI BlackBook sign-in (browser cookies). The session
// is only kept when REI_PERSIST_SESSION=true, and then only encrypted with
// AES-256-GCM under PPC_SECRET_KEY (32 bytes, hex or base64). Without a key
// nothing is saved and the next run signs in again.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function parseKey(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(s)) key = Buffer.from(s, 'hex');
  else {
    try { key = Buffer.from(s, 'base64'); } catch { key = null; }
  }
  if (!key || key.length !== 32) throw new Error('PPC_SECRET_KEY must be 32 bytes, as 64 hex characters or base64.');
  return key;
}

export function encryptJson(obj, secret) {
  const key = parseKey(secret);
  if (!key) throw new Error('PPC_SECRET_KEY is not set.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: body.toString('base64') });
}

export function decryptJson(text, secret) {
  const key = parseKey(secret);
  if (!key) throw new Error('PPC_SECRET_KEY is not set.');
  const box = JSON.parse(text);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

/** Saved REI session (Playwright storage state), or null. Never throws. */
export function loadSession(file, secret) {
  try {
    if (!secret || !existsSync(file)) return null;
    return decryptJson(readFileSync(file, 'utf8'), secret);
  } catch {
    return null;
  }
}
export function saveSession(file, state, secret) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encryptJson(state, secret), { mode: 0o600 });
}
export function clearSession(file) {
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
}
