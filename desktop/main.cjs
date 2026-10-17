// ZivBot Desktop — the dots' own computer.
//
// 1. Make sure FalkorDB is up (start the `zivbot-falkordb` Docker container if needed).
// 2. Start the ZivBot server: bundled (packaged app) or `tsx` from the repo (dev).
// 3. Open the GrokBot-style window, with a tray showing what the dots are doing.
// The server listens on the LAN too, so the Android app can pair with this computer.

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, Notification } = require('electron');
const { spawn, execFile } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 8787);
const FALKOR_PORT = 6379;
const DEV = !app.isPackaged;
const REPO = path.resolve(__dirname, '..');
const BUNDLE = DEV ? path.join(__dirname, 'build/app') : path.join(process.resourcesPath, 'app');

let win = null;
let splash = null;
let tray = null;
let server = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (t) => splash && !splash.isDestroyed() && splash.webContents.executeJavaScript(`setStatus(${JSON.stringify(t)})`).catch(() => {});

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function sh(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` } }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` })));
}

async function ensureFalkor() {
  if (await portOpen(FALKOR_PORT)) return true;
  status('Starting FalkorDB…');
  let r = await sh('docker', ['start', 'zivbot-falkordb']);
  if (!r.ok) r = await sh('docker', ['run', '-d', '--name', 'zivbot-falkordb', '-p', '6379:6379', '-v', 'zivbot-falkor:/var/lib/falkordb/data', 'falkordb/falkordb:latest']);
  if (!r.ok && /Cannot connect|daemon/i.test(r.out)) {
    status('Starting Docker…');
    if (process.platform === 'darwin') await sh('open', ['-a', 'Docker']);
    for (let i = 0; i < 60 && !(await sh('docker', ['info'])).ok; i++) await sleep(2000);
    r = await sh('docker', ['start', 'zivbot-falkordb']);
    if (!r.ok) r = await sh('docker', ['run', '-d', '--name', 'zivbot-falkordb', '-p', '6379:6379', '-v', 'zivbot-falkor:/var/lib/falkordb/data', 'falkordb/falkordb:latest']);
  }
  for (let i = 0; i < 40; i++) { if (await portOpen(FALKOR_PORT)) return true; await sleep(500); }
  return false;
}

async function startServer() {
  if (await portOpen(PORT)) return true; // already running (e.g. `npm run dev:api`)
  status('Starting ZivBot…');
  const bundled = fs.existsSync(path.join(BUNDLE, 'server.mjs'));
  const env = { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` };
  if (bundled) {
    server = spawn(process.execPath, [path.join(BUNDLE, 'server.mjs')], { cwd: BUNDLE, env: { ...env, ELECTRON_RUN_AS_NODE: '1', ZIV_ROOT: BUNDLE }, stdio: 'inherit' });
  } else {
    server = spawn('npx', ['tsx', 'server/index.ts'], { cwd: REPO, env, stdio: 'inherit' });
  }
  server.on('exit', (code) => { server = null; if (code && win) status(`ZivBot stopped (${code}).`); });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return true; } catch { /* starting */ }
    await sleep(500);
  }
  return false;
}

function lanUrl() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
  return `http://localhost:${PORT}`;
}
ipcMain.handle('lan-url', () => lanUrl());

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build/trayTemplate.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  if (img.isEmpty()) tray.setTitle('◉ Ziv');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open ZivBot', click: () => { win?.show(); win?.focus(); } },
    { label: `Pair your phone: ${lanUrl()}`, click: () => { win?.show(); win?.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('zivbot:pair'))"); } },
    { label: 'FalkorDB Browser', click: () => shell.openExternal('http://localhost:3000') },
    { type: 'separator' },
    { label: 'Quit ZivBot', role: 'quit' },
  ]);
  tray.setContextMenu(menu());
  tray.setToolTip('ZivBot — your dots are on this computer');
}

async function main() {
  splash = new BrowserWindow({ width: 420, height: 320, frame: false, resizable: false, backgroundColor: '#141414', show: true });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  if (!(await ensureFalkor())) {
    status('ZivBot keeps its memory in FalkorDB, which needs Docker.<br><br>Install Docker Desktop, then run:<br><code>docker run -d --name zivbot-falkordb -p 6379:6379 falkordb/falkordb</code>');
    return;
  }
  if (!(await startServer())) { status('The ZivBot server did not start. Check the terminal output.'); return; }
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#141414',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  win.loadURL(`http://localhost:${PORT}`);
  win.once('ready-to-show', () => { win.show(); splash?.destroy(); splash = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => { if (process.platform === 'darwin' && !app.isQuitting) { e.preventDefault(); win.hide(); } });
  createTray();
  if (Notification.isSupported()) new Notification({ title: 'ZivBot is running', body: 'Your dots keep working while you’re away.' }).show();
}

app.on('before-quit', () => { app.isQuitting = true; server?.kill(); });
app.on('activate', () => { win?.show(); });
app.whenReady().then(main);
