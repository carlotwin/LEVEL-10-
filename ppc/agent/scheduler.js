// A small cron scheduler for the `schedule` command. Standard 5-field cron
// (minute hour day-of-month month day-of-week) with *, lists, ranges and
// steps, evaluated in PPC_TIMEZONE. Jobs never overlap: one runs at a time.
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 },
];

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron "${expr}" needs 5 fields (minute hour day month weekday).`);
  const out = {};
  parts.forEach((part, i) => {
    const f = FIELDS[i];
    const set = new Set();
    for (const item of part.split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`Cron "${expr}": cannot read "${item}" in the ${f.name} field.`);
      const step = m[4] ? Number(m[4]) : 1;
      const lo = m[1] === '*' ? f.min : Number(m[2]);
      const hi = m[1] === '*' ? f.max : m[3] ? Number(m[3]) : m[4] ? f.max : lo;
      if (lo < f.min || hi > f.max || lo > hi || step < 1) throw new Error(`Cron "${expr}": "${item}" is out of range for ${f.name}.`);
      for (let v = lo; v <= hi; v += step) set.add(f.name === 'dow' && v === 7 ? 0 : v);
    }
    out[f.name] = set;
    out[`${f.name}Star`] = part === '*';
  });
  return out;
}

/** Wall-clock parts of a date in a time zone. */
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, dom: Number(p.day), month: Number(p.month), dow };
}

export function cronMatches(cron, date, timeZone = 'UTC') {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const t = zonedParts(date, timeZone);
  if (!c.minute.has(t.minute) || !c.hour.has(t.hour) || !c.month.has(t.month)) return false;
  // Standard cron: when both day fields are restricted, either may match.
  const domOk = c.dom.has(t.dom);
  const dowOk = c.dow.has(t.dow);
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

export function nextRun(cron, from = new Date(), timeZone = 'UTC') {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const t = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  for (let i = 0; i < 60 * 24 * 370; i += 1) {
    if (cronMatches(c, t, timeZone)) return t;
    t.setTime(t.getTime() + 60000);
  }
  return null;
}

/**
 * Run jobs on their schedules until `signal` aborts.
 * jobs: [{ name, cron, run: async () => {} }]
 */
export async function runScheduler(jobs, { timeZone = 'UTC', log, signal, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const parsed = jobs.map((j) => ({ ...j, c: parseCron(j.cron) }));
  for (const j of parsed) log?.info('schedule', { message: `${j.name}: "${j.cron}" (${timeZone}), next ${nextRun(j.c, now(), timeZone)?.toISOString()}` });
  let lastMinute = -1;
  while (!signal?.aborted) {
    const t = now();
    const minute = Math.floor(t.getTime() / 60000);
    if (minute !== lastMinute) {
      lastMinute = minute;
      for (const j of parsed) {
        if (!cronMatches(j.c, t, timeZone)) continue;
        try {
          log?.info('job_start', { message: j.name });
          await j.run();
          log?.info('job_done', { message: j.name });
        } catch (e) {
          log?.error('job_failed', { message: `${j.name}: ${e.message}` });
        }
      }
    }
    await sleep(Math.max(1000, 60000 - (now().getTime() % 60000) + 50));
  }
}
