// A small stand-in for REI BlackBook, for testing the crawler: sign-in page,
// optional verification-code (MFA) step or CAPTCHA, a paginated contacts
// list and contact pages whose fields are read by label. Fictional data only.
import { createServer } from 'node:http';

export function createMockReiSite({ contacts = 5, perPage = 3, mfa = false, captcha = false, broken = false } = {}) {
  const hits = [];
  const people = Array.from({ length: contacts }, (_, i) => ({
    id: String(1001 + i), name: `Demo Seller ${i + 1}`, phone: `(415) 555-01${String(i).padStart(2, '0')}`, email: `demo${i + 1}@example.com`,
    address: `${10 + i} Demo Street, ${i % 2 ? 'Oakland' : 'San Jose'}, CA 9${5100 + i}`, status: ['Qualified', 'New Lead', 'Under Contract', 'Dead', 'Appointment Set'][i % 5],
    source: i % 2 ? 'Direct Mail' : 'Google Ads', motivation: i % 3 ? 'Needs repairs, sell as is' : 'Inherited from mom', created: `09/${10 + i}/2026`, gclid: i % 2 ? '' : `GC${i}`,
  }));
  const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>REI BlackBook (mock)</title></head><body>${body}</body></html>`;
  const loginForm = (error = '') => page(`
    <h1>Sign in</h1>${error ? `<p class="error">${error}</p>` : ''}
    <form method="post" action="/services/account/login">
      <input type="email" name="email" placeholder="Email"><input type="password" name="password" placeholder="Password">
      <button type="submit">Log In</button>
    </form>${captcha ? '<div class="g-recaptcha"><iframe src="/recaptcha/anchor" title="reCAPTCHA"></iframe></div>' : ''}`);
  const authed = (req) => /(^|;\s*)sid=valid/.test(req.headers.cookie || '');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push({ path: url.pathname + url.search, at: Date.now(), method: req.method });
    const send = (code, html, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
    if (url.pathname === '/services/account/login' && req.method === 'POST') {
      const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
      const f = new URLSearchParams(body);
      if (f.get('email') === 'team@example.com' && f.get('password') === 'right-password') {
        return send(302, '', { location: mfa ? '/verify' : '/contacts', 'set-cookie': mfa ? 'pending=1; Path=/' : 'sid=valid; Path=/; HttpOnly' });
      }
      return send(200, loginForm('Invalid email or password'));
    }
    if (url.pathname === '/services/account/login') return send(200, loginForm());
    if (url.pathname === '/verify') return send(200, page('<h1>Check your phone</h1><p>Enter the verification code we sent you.</p><input autocomplete="one-time-code" name="code">'));
    if (url.pathname.startsWith('/recaptcha')) return send(200, page('<p>challenge</p>'));
    if (!authed(req)) return send(302, '', { location: '/services/account/login' });
    const nav = '<nav><a href="/contacts">Contacts</a> <a href="/campaigns">Campaigns</a></nav>';
    if (url.pathname === '/contacts') {
      const p = Number(url.searchParams.get('page') || 1);
      const slice = people.slice((p - 1) * perPage, p * perPage);
      const more = p * perPage < people.length;
      return send(200, page(`${nav}<input placeholder="Search By Name, Phone, Email">
        <table><thead><tr><th>Name</th><th>Property Address</th><th>Phone</th><th>Email</th><th>Tags</th></tr></thead><tbody>
        ${slice.map((c) => `<tr><td><a href="/contacts/${c.id}">${c.name}</a></td><td>${c.address}</td><td>${c.phone}</td><td>${c.email}</td><td>${c.source === 'Google Ads' ? 'PPC' : ''}</td></tr>`).join('')}
        </tbody></table>${more ? `<a aria-label="Next page" href="/contacts?page=${p + 1}">Next</a>` : ''}`));
    }
    const m = /^\/contacts\/(\d+)$/.exec(url.pathname);
    if (m) {
      const c = people.find((x) => x.id === m[1]);
      if (!c) return send(404, page('Not found'));
      const row = (label, value) => `<div class="row"><p class="label">${label}</p><p class="value">${value}</p></div>`;
      return send(200, page(`${nav}<h2>${c.name}</h2><section class="about">
        ${row('Name', c.name)}${row('Phone (Mobile)', c.phone)}${row('Email', c.email)}${row('Property Address', c.address)}
        ${row(broken ? 'Status of lead' : 'Lead Status', c.status)}${row('Lead Source', c.source)}${row('Motivation', c.motivation)}
        ${row('Created', c.created)}${c.gclid ? row('GCLID', c.gclid) : ''}</section>
        <span class="chakra-badge tagTheme-blue">${c.source === 'Google Ads' ? 'PPC' : 'Mail'}</span>`));
    }
    return send(404, page('Not found'));
  });
  return { server, hits, people };
}
