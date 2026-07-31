// Electron desktop wrapper for the Level 10 SMS Outreach dashboard.
//
// Turns the web dashboard into a double-click Windows app: it starts the Express
// server in the background (using Electron's bundled Node — no separate Node.js
// install needed), waits for it, then shows the dashboard in its own window.
// No terminal, no "npm start", no localhost to remember.
//
// The REI automation (Playwright) still opens its own visible browser window so
// the one-time REI login / 2FA works exactly as before.

const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = `http://localhost:${PORT}`;

let serverProc = null;
let mainWindow = null;
let quitting = false;
let lastStart = 0;

const APP_ROOT = path.join(__dirname, '..');

function startServer() {
  lastStart = Date.now();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(PORT),
    // Writable folder for browser profile/login, job state, ledger, logs, and
    // the app's settings.json. The install dir is read-only.
    LEVEL10_DATA_DIR: app.getPath('userData'),
  };
  if (app.isPackaged) {
    env.PLAYWRIGHT_BROWSERS_PATH = '0'; // Chromium ships inside the app
  }
  const entry = path.join(APP_ROOT, 'server', 'index.js');
  serverProc = spawn(process.execPath, [entry], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let outBuf = '';
  const tee = (d) => { outBuf = (outBuf + String(d)).slice(-4000); };
  serverProc.stdout.on('data', (d) => { process.stdout.write(`[server] ${d}`); tee(d); });
  serverProc.stderr.on('data', (d) => { process.stderr.write(`[server] ${d}`); tee(d); });

  serverProc.on('exit', (code) => {
    serverProc = null;
    if (quitting) return;
    // Clean exit (code 0 / null) = an in-app "Save & Restart" — relaunch server.
    if (code === 0 || code === null) {
      startServer();
      if (mainWindow && !mainWindow.isDestroyed()) {
        setTimeout(() => waitForServer((ok) => ok && mainWindow.loadURL(BASE_URL)), 400);
      }
      return;
    }
    // Crashed. If it died almost immediately, show the error; else try once more.
    const fast = Date.now() - lastStart < 4000;
    if (fast && mainWindow && !mainWindow.isDestroyed()) {
      const tail = (outBuf || '(no output)').split('\n').slice(-24).join('\n');
      dialog.showErrorBox('Level 10 SMS Outreach — engine stopped',
        `The engine stopped (code ${code}).\n\n----- DETAILS -----\n${tail}\n-------------------\n\nPlease screenshot this and send it.`);
    } else {
      startServer();
    }
  });
}

function waitForServer(cb, attempt = 0) {
  const req = http.get(BASE_URL, () => cb(true));
  req.on('error', () => {
    if (attempt > 150) return cb(false);
    setTimeout(() => waitForServer(cb, attempt + 1), 200);
  });
  req.setTimeout(1500, () => req.destroy());
}

// REI/contact links open in an in-app browser window with ONE persistent
// session, so a REI login done once is remembered for every later link.
let linkWindow = null;
function openInAppBrowser(url) {
  if (linkWindow && !linkWindow.isDestroyed()) { linkWindow.loadURL(url); linkWindow.focus(); return; }
  linkWindow = new BrowserWindow({
    width: 1200, height: 850, title: 'Level 10 — Web', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:level10-web', contextIsolation: true, nodeIntegration: false },
  });
  linkWindow.on('closed', () => (linkWindow = null));
  linkWindow.loadURL(url);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 640,
    backgroundColor: '#0e1117', title: 'Level 10 SMS Outreach', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE_URL)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) { openInAppBrowser(url); return { action: 'deny' }; }
    return { action: 'deny' };
  });
  const loading = `data:text/html,${encodeURIComponent(
    `<body style="margin:0;background:#0e1117;color:#e6edf7;font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><div style="font-size:22px;margin-bottom:8px">Level 10 SMS Outreach</div><div style="opacity:.7">Starting…</div></div></body>`
  )}`;
  mainWindow.loadURL(loading);
  waitForServer((ok) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (ok) mainWindow.loadURL(BASE_URL);
    else dialog.showErrorBox('Could not start', 'The dashboard did not start in time. Please close and reopen the app.');
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    startServer();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

function stopServer() { quitting = true; if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; } }
app.on('window-all-closed', () => { stopServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopServer);
app.on('quit', stopServer);
