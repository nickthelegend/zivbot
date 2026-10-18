// Record the demo video from the real, running app, on a user signed in with real Google + GitHub:
//   npx electron scripts/record-real.cjs <userId> <outDir>
// The API must be serving dist on :8787 with FalkorDB up, and <userId> must have finished
// naming (onboarding) but not connected anything yet. Frames go to <outDir>/frames, scene
// start frames to <outDir>/markers.json; make-video.mjs cuts and voices them.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [user, out] = process.argv.slice(-2);
const BASE = process.env.ZIV_BASE || 'http://localhost:8787';
const FPS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, backgroundColor: '#100f0e', webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  await win.loadURL(`${BASE}/?pair=${user}`);
  await sleep(3000);
  const js = (code) => win.webContents.executeJavaScript(code);

  // ---- frame capture loop
  let n = 0;
  let rec = true;
  const markers = [];
  (async () => {
    while (rec) {
      const t0 = Date.now();
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, 'frames', `${String(n).padStart(6, '0')}.jpg`), img.toJPEG(90));
      n++;
      await sleep(Math.max(0, 1000 / FPS - (Date.now() - t0)));
    }
  })();
  const mark = (id) => { markers.push({ id, frame: n }); console.log('scene', id, 'at frame', n); };

  // ---- helpers that act like a person
  const click = (sel, text) => js(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => !${JSON.stringify(text || '')} || e.textContent.includes(${JSON.stringify(text || '')})); const el = els[els.length - 1]; if (el) { el.scrollIntoView({ block: 'nearest' }); el.click(); } return !!el; })()`);
  const openConv = (name) => js(`(() => { const b = document.querySelector('.conv[aria-label="Open ${name}"]'); b?.click(); return !!b; })()`);
  const waitFor = async (cond, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(250); } return false; };
  const scrollChatBottom = () => js(`(() => { const m = document.querySelector('.messages'); if (m) m.scrollTo({ top: m.scrollHeight, behavior: 'smooth' }); })()`);
  const typeInto = async (sel, text, perChar = 28) => {
    for (let i = 1; i <= text.length; i++) {
      await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return; el.focus(); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)}.slice(0, ${i})); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(perChar);
    }
  };
  const botCount = () => js(`document.querySelectorAll('.bot-row:not(.thinking)').length`);
  const ask = async (q, settle = 1500) => {
    const before = await botCount();
    await typeInto('.composer textarea', q);
    await sleep(300);
    await js(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await waitFor(`document.querySelectorAll('.bot-row:not(.thinking)').length > ${before} && !document.querySelector('.bot-row.thinking')`, 240000);
    await sleep(settle);
    // frame the question at the top, then let the answer scroll in
    await js(`(() => { const rows = [...document.querySelectorAll('.user-row')]; const r = rows[rows.length - 1]; if (r) r.scrollIntoView({ block: 'start', behavior: 'smooth' }); })()`);
    await sleep(1200);
  };
  const slowScroll = async (px, steps = 6, sel = '.messages') => { for (let i = 0; i < steps; i++) { await js(`document.querySelector(${JSON.stringify(sel)})?.scrollBy({ top: ${px / steps}, behavior: 'smooth' })`); await sleep(450); } };

  const pickModel = async (name) => {
    await js(`document.querySelector('.model-pick .chip-btn')?.click()`);
    await sleep(1800);
    await js(`(() => { const b = [...document.querySelectorAll('.model-menu button')].find(x => x.querySelector('.model-name')?.textContent === ${JSON.stringify(name)}); b?.click(); })()`);
    await sleep(900);
  };

  // clean stage: chat centred, Ziv open
  await js(`document.querySelector('.app.with-right') && document.querySelector('button[title="Dot details"]')?.click()`);
  await openConv('Ziv');
  await sleep(1500);

  // s05 — a question, answered by the graph planner
  mark('s05');
  await openConv('Ziv');
  await sleep(1000);
  await pickModel('Auto');
  await ask("Which emails haven't I replied to?");
  await slowScroll(240, 4);
  await sleep(2000);

  // s06 — show path
  mark('s06');
  await js(`(() => { const l = [...document.querySelectorAll('.trace-link')]; l[l.length - 1]?.click(); })()`);
  await sleep(2500);
  await js(`[...document.querySelectorAll('.drawer .query-row')][0]?.click()`);
  await sleep(3000);
  await slowScroll(300, 4, '.drawer');
  await sleep(2000);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(800);

  rec = false;
  await sleep(300);
  mark('end');
  fs.writeFileSync(path.join(out, 'markers.json'), JSON.stringify({ fps: FPS, markers }, null, 1));
  app.quit();
});
