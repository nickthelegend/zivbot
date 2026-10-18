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

  // clean stage: a brand-new user — zero chats, Ziv just said hello
  await js(`document.querySelector('.app.with-right') && document.querySelector('button[title="Dot details"]')?.click()`);
  await openConv('Ziv');
  await sleep(2500);

  // s01 — first run: onboarding
  mark('s01');
  await sleep(2500);
  await typeInto('.composer textarea', 'Nick', 90);
  await sleep(400);
  await js(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await waitFor(`[...document.querySelectorAll('.options-card button')].some(b => b.textContent.includes('Ziv'))`, 20000);
  await sleep(2200);
  await js(`(() => { const b = [...document.querySelectorAll('.options-card button')].find(b => b.textContent.trim().endsWith('Ziv')); b?.click(); })()`);
  await waitFor(`!!document.querySelector('.connector-wrap .google-btn')`, 20000);
  await sleep(1500);
  await js(`document.querySelector('.connector-wrap')?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
  await sleep(3000);

  // s02 — Sign in with Google (you pick the account in the browser)
  mark('s02');
  await js(`document.querySelector('.connector-wrap .google-btn')?.click()`);
  console.log('>>> GOOGLE: finish the consent in your browser', await js(`!!document.querySelector('.connector-wrap .google-btn')`));
  await waitFor(`[...document.querySelectorAll('.connector-card')].some(c => c.textContent.includes('Google') && c.textContent.includes('Connected'))`, 900000);
  await sleep(2000);
  await js(`document.querySelector('.connector-wrap')?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
  await sleep(2500);

  // s03 — Sign in with GitHub
  mark('s03');
  await js(`(() => { const b = [...document.querySelectorAll('.connector-wrap button')].find(b => b.textContent.includes('Sign in with GitHub')); b?.click(); })()`);
  console.log('>>> GITHUB: finish the sign-in in your browser');
  await waitFor(`[...document.querySelectorAll('.connector-card')].some(c => c.textContent.includes('Signed in as @'))`, 900000);
  await waitFor(`[...document.querySelectorAll('.bot-row')].some(r => /repositories into your graph/.test(r.textContent))`, 300000);
  await sleep(1500);
  await scrollChatBottom();
  await sleep(4000);

  // s03 — the graph and its schema
  mark('s04');
  await click('.graph-pulse');
  await sleep(6500);
  await click('.seg.big button', 'Schema');
  await sleep(5500);

  // s04 — FalkorDB algorithms on my real collaborators
  mark('s05');
  await click('.seg.big button', 'Algorithms');
  await sleep(1500);
  await click('.algo-presets button', 'Most central people');
  await sleep(4500);
  await click('.algo-presets button', 'Real working groups');
  await sleep(4500);

  // s05 — a question, answered by the graph planner
  mark('s06');
  await openConv('Ziv');
  await sleep(1000);
  await pickModel('Auto');
  await ask("Which emails haven't I replied to?");
  await slowScroll(240, 4);
  await sleep(2000);

  // s06 — show path
  mark('s07');
  await js(`(() => { const l = [...document.querySelectorAll('.trace-link')]; l[l.length - 1]?.click(); })()`);
  await sleep(2500);
  await js(`[...document.querySelectorAll('.drawer .query-row')][0]?.click()`);
  await sleep(3000);
  await slowScroll(300, 4, '.drawer');
  await sleep(2000);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(800);

  // s07 — pick the model: Codex on my ChatGPT plan
  mark('s08');
  await pickModel('Codex');
  await ask("What's failing in CI across my repos this week?", 2000);
  await slowScroll(300, 4);
  await sleep(2500);

  // s08 — or Claude on my Claude plan
  mark('s09');
  await pickModel('Claude Sonnet');
  await ask('Who works with me on loom, and what do we share?', 2000);
  await slowScroll(260, 4);
  await sleep(2500);

  // s09 — act: a draft reply, waiting for approval
  mark('s10');
  await pickModel('Auto');
  await ask('Draft a reply to Nivesh Gajengi', 2000);
  await js(`(() => { const d = [...document.querySelectorAll('.draft-card')].pop(); d?.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(5000);

  // s10 — make a Ziv
  mark('s11');
  await js(`document.querySelector('.side-actions button[title="New"]')?.click()`);
  await sleep(800);
  await click('.menu button', 'New Ziv');
  await sleep(1500);
  await click('.preset-grid .preset', 'Ledger');
  await sleep(4500);

  // s11 — the phone: Anywhere pairing QR
  mark('s12');
  await js(`window.dispatchEvent(new Event('zivbot:pair'))`);
  await sleep(7000);
  await js(`document.querySelector('.modal-backdrop')?.click()`);
  await sleep(500);

  // s12 — a real Codex session using ZivBot over MCP
  mark('s14');
  const term = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>
    body{margin:0;background:#0d0c0b;color:#e8e2da;font:15px/1.55 'JetBrains Mono',ui-monospace,Menlo,monospace;padding:34px 40px}
    .bar{display:flex;gap:8px;margin-bottom:22px}.bar i{width:12px;height:12px;border-radius:50%;background:#3a3633;display:block}
    .p{color:#ff8a3d}.dim{color:#8b847c}.ok{color:#7ee2a8}.mcp{color:#9ec5ff}pre{white-space:pre-wrap;margin:0}
  </style></head><body><div class="bar"><i></i><i></i><i></i></div><pre id="o"></pre></body></html>`)}`;
  await win.loadURL(term);
  await sleep(500);
  const add = (line, cls = '') => js(`(() => { const o = document.getElementById('o'); const s = document.createElement('span'); s.className = ${JSON.stringify(cls)}; s.textContent = ${JSON.stringify(line + '\n')}; o.appendChild(s); window.scrollTo(0, document.body.scrollHeight); })()`);
  const cmd = `codex exec -c 'mcp_servers.zivbot.url="${BASE}/mcp?user=…"' "Use zivbot's triage tool. What needs me today?"`;
  await add('$ ' + cmd, 'p');
  await add('');
  await new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--skip-git-repo-check', '-m', process.env.ZIV_CODEX_MODEL || 'gpt-5.6-terra',
      '-c', `mcp_servers.zivbot.url="${BASE}/mcp?user=${user}"`, '-c', 'mcp_servers.zivbot.default_tools_approval_mode="approve"',
      "Use the zivbot MCP server's triage tool. Then answer in 3 short lines: what needs me today."],
    { cwd: out, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf) => {
      for (const line of String(buf).split('\n')) {
        const l = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        if (!l || /skill|SKILL|hook:|MallocStackLogging|tokens used|^[\d,]+$|^codex\(\d+\)|^(workdir|model|provider|approval|sandbox|reasoning|session id|user|-{3,}|OpenAI Codex)/.test(l)) continue;
        void add(l, /^mcp:/.test(l) ? 'mcp' : /completed|succeeded/.test(l) ? 'ok' : /^codex$/.test(l) ? 'dim' : '');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', resolve);
  });
  await sleep(3500);

  rec = false;
  await sleep(300);
  mark('end');
  fs.writeFileSync(path.join(out, 'markers.json'), JSON.stringify({ fps: FPS, markers }, null, 1));
  app.quit();
});
