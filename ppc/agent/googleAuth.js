// One-time Google sign-in for the sync agent: opens Google's consent page,
// receives the answer on a local loopback address, and prints the refresh
// token to put in .env (GOOGLE_ADS_REFRESH_TOKEN). Uses PKCE; the token is
// shown once on screen and never written to a log or file by this script.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export const SCOPES = ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly'];
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function authUrl({ clientId, redirectUri, challenge, state, scopes = SCOPES }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* the link is printed anyway */ }
}

export async function googleAuth({ clientId, clientSecret }, { fetchImpl = fetch, print = console.log, open = true } = {}) {
  if (!clientId || !clientSecret) throw new Error('Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env first (Google Cloud → Credentials → OAuth client, type "Desktop app").');
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const done = (code, text) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text); server.close(); };
      if (url.searchParams.get('state') !== state) { done(400, 'Sign-in check failed. Run the command again.'); reject(new Error('OAuth state mismatch')); return; }
      if (url.searchParams.get('error')) { done(400, `Google said: ${url.searchParams.get('error')}`); reject(new Error(url.searchParams.get('error'))); return; }
      try {
        const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: url.searchParams.get('code'), client_id: clientId, client_secret: clientSecret,
            redirect_uri: `http://127.0.0.1:${server.address().port}/callback`, grant_type: 'authorization_code', code_verifier: verifier,
          }).toString(),
        });
        const json = await tokenRes.json();
        if (!json.refresh_token) throw new Error(json.error_description || json.error || 'no refresh token returned');
        done(200, 'Signed in. You can close this tab and go back to the terminal.');
        resolve(json.refresh_token);
      } catch (e) {
        done(500, `Sign-in failed: ${e.message}`);
        reject(e);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const link = authUrl({ clientId, redirectUri, challenge, state });
      print('Open this link, sign in with the Google account that can see the Google Ads account (and GA4), and allow access:');
      print(link);
      if (open) openBrowser(link);
    });
  });
}
