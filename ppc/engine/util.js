// Small, dependency-free helpers shared by the dashboard (browser) and the
// sync agent (Node). Nothing here touches the network or the file system.

/** Round to `places` decimals, keeping null/undefined as null. */
export function round(value, places = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Divide, returning null instead of Infinity/NaN when the denominator is 0. */
export function safeDiv(numerator, denominator) {
  if (!denominator || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return numerator / denominator;
}

export function sum(list, pick = (x) => x) {
  let total = 0;
  for (const item of list) {
    const v = pick(item);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

export function groupBy(list, keyOf) {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    let bucket = map.get(key);
    if (!bucket) map.set(key, (bucket = []));
    bucket.push(item);
  }
  return map;
}

/** Parse a money/number cell: "$1,234.56", "1.234,5" (no), "--", "12%". */
export function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  if (!s || s === '--' || s === '-' || s.toLowerCase() === 'n/a' || s === '< 10') return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()$€£\s,%]/g, '').replace(/^-/, '');
  if (!s || !/^\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Integer counts ("1,204" -> 1204). */
export function toInt(value) {
  const n = toNumber(value);
  return n == null ? null : Math.round(n);
}

export function toBool(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['y', 'yes', 'true', '1', 'x', '✓', 'checked'].includes(s)) return true;
  if (['n', 'no', 'false', '0', 'unchecked'].includes(s)) return false;
  return null;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthOf(name) {
  const s = String(name).toLowerCase();
  return MONTHS[s.slice(0, 4)] ?? MONTHS[s.slice(0, 3)] ?? null;
}

/**
 * Normalize many date spellings to "YYYY-MM-DD" (UTC calendar date).
 * Accepts: 2026-09-01, 2026/9/1, 9/1/2026, "Sep 1, 2026", "Tue, Sep 1, 2026",
 * 20260901, ISO timestamps, Excel serial numbers, Date objects.
 * Returns null when the value is not a recognizable date.
 */
export function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel serial date (days since 1899-12-30).
    const ms = Math.round((value - 25569) * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s.*)?$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(year, +m[1], +m[2]); // US order: month/day/year
  }
  m = /^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s);
  if (m) {
    const month = monthOf(m[1]);
    if (month) return valid(+m[3], month, +m[2]);
  }
  m = /^(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})/i.exec(s);
  if (m) {
    const month = monthOf(m[2]);
    if (month) return valid(+m[3], month, +m[1]);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function valid(y, mo, d) {
  if (!(y > 1990 && y < 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/** Full timestamp to ISO string, or null. Plain dates become midnight UTC. */
export function toTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  const d = toDate(s);
  return d ? `${d}T00:00:00.000Z` : null;
}

export function addDays(dateStr, days) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}

/** Monday of the ISO week containing dateStr. */
export function weekStart(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** Lowercase, trim, collapse spaces, strip surrounding quotes/brackets. */
export function normText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleCase(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** US phone to its last 10 digits, or '' when it is not a phone. */
export function normalizePhone(value) {
  const d = digitsOnly(value);
  if (d.length < 10) return '';
  return d.slice(-10);
}

export function normalizeEmail(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
}

/** A stable, short, non-cryptographic hash (FNV-1a 32-bit) for ids/keys. */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Deterministic id from parts: "kw_1x9ab" etc. */
export function stableId(prefix, ...parts) {
  return `${prefix}_${fnv1a(parts.map((p) => normText(p)).join('|'))}`;
}

async function subtle() {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  const mod = await import('node:crypto');
  return mod.webcrypto.subtle;
}

/**
 * SHA-256 hex of `text`, salted. Used so phone numbers, emails and street
 * addresses can be matched and de-duplicated without storing them. The salt is
 * not a secret; the point is to keep raw contact details out of shared data.
 */
export async function sha256Hex(text, salt = 'twin-ppc/1') {
  if (!text) return '';
  const data = new TextEncoder().encode(`${salt}:${text}`);
  const digest = await (await subtle()).digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Money for people: $1,234 (no cents above $100). */
export function formatMoney(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 100 || abs < 0.005 ? 0 : 2;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${value < 0 ? '−' : ''}$${s}`;
}

export function formatInt(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

export function formatPct(value, digits = 0) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Remove personal details from free text before it is stored or shared:
 * emails, phone numbers, street addresses and long digit runs. Used on the
 * few text fields kept from REI (motivation, lost reason).
 */
export function scrubText(value, maxLength = 120) {
  let t = String(value ?? '');
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]');
  t = t.replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]');
  t = t.replace(/\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z0-9'.-]+\s+){0,3}(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway)\b\.?/gi, '[address]');
  t = t.replace(/\d{5,}/g, '[number]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > maxLength ? `${t.slice(0, maxLength - 1)}…` : t;
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function uniq(list) {
  return [...new Set(list)];
}
