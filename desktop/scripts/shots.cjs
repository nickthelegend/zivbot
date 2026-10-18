// Capture README screenshots of a running ZivBot (API serving dist on :8787):
//   npx electron scripts/shots.cjs <userId> <outDir>
// The user should have finished onboarding and connected the demo workspace.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [user, out] = process.argv.slice(-2);
const BASE = process.env.ZIV_SHOTS_BASE || 'http://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, backgroundColor: '#141414', webPreferences: { offscreen: true } });
  await win.loadURL(`${BASE}/?pair=${user}`);
  await sleep(3500);
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { await sleep(900); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG()); console.log('saved', name); };
  const click = (sel, text) => js(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => !${JSON.stringify(text || '')} || e.textContent.includes(${JSON.stringify(text || '')})); const el = els[els.length - 1]; if (el) el.click(); return !!el; })()`);
  const conv = await js(`fetch('/api/state', { headers: { 'x-ziv-user': ${JSON.stringify(user)} } }).then(r => r.json()).then(s => s.dots[0].conv)`);
  // ask Ziv something, then frame the question and the top of the answer
  const ask = async (q, name, wait = 4500) => {
    await js(`fetch('/api/conversations/${conv}/messages', { method: 'POST', headers: { 'x-ziv-user': ${JSON.stringify(user)}, 'content-type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(q)} }) })`);
    await sleep(wait);
    await js(`(() => { const rows = [...document.querySelectorAll('.user-row')].filter(e => e.textContent.trim() === ${JSON.stringify(q)}); const r = rows[rows.length - 1]; if (r) r.scrollIntoView({ block: 'start' }); else document.querySelector('.messages').scrollTop = 1e9; document.querySelector('.messages').scrollTop -= 60; })()`);
    await shot(name);
  };

  await click('.conv', 'Ziv');
  await sleep(1500);
  const only = process.env.ZIV_SHOTS_ONLY;
  if (only !== 'mobile') {
  await ask('What needs me today?', 'chat');
  await click('.trace-link');
  await sleep(1800);
  await shot('trace');
  await js(`document.querySelector('.drawer-backdrop')?.click()`);
  await ask("What's blocking the EU launch?", 'critical-path');
  await ask('What if Hana is out next week?', 'what-if');
  await ask('Which customers are at risk?', 'customer-health');
  await ask('The customer portal is slow', 'diagnose');
  await ask('Should we delay the EU launch?', 'decide');
  await ask('How many open P1s?', 'count');

  await js(`(() => { const ta = document.querySelector('.composer textarea'); ta.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, '@'); ta.setSelectionRange(1, 1); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(700);
  await shot('mentions');
  await js(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  await click('.graph-pulse');
  await sleep(5000);
  await shot('graph');
  await click('.seg.big button', 'Insights');
  await sleep(2500);
  await shot('insights');
  await click('.seg.big button', 'Algorithms');
  await sleep(2500);
  await click('.algo-presets button', 'Systems everything leans on');
  await sleep(2500);
  await shot('algorithms');
  await click('.seg.big button', 'Schema');
  await sleep(4000);
  await shot('schema');

  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`);
  await sleep(600);
  await js(`(() => { const i = document.querySelector('.p-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'brightwave'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(1200);
  await shot('palette');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`);
  await click('.conv', 'Ziv');
  await sleep(800);
  await click('.connect-pill');
  await sleep(1000);
  await shot('connect');
  await js(`document.querySelector('.modal-backdrop')?.click()`);

  }

  // phone width: the chat, on the critical-path answer
  await js(`document.querySelector('.app.with-right') && document.querySelector('button[title="Dot details"]')?.click()`);
  win.setSize(390, 844);
  await sleep(1500);
  await click('.conv', 'Ziv');
  await sleep(1200);
  await js(`(() => { const rows = [...document.querySelectorAll('.user-row')].filter(e => e.textContent.includes('blocking the EU')); rows[rows.length - 1]?.scrollIntoView({ block: 'start' }); })()`);
  await shot('mobile');
  app.quit();
});
