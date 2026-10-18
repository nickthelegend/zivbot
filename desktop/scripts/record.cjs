// Record the demo video from the real, running app (no mocks):
//   npx electron scripts/record.cjs <userId> <outDir>
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
    await waitFor(`document.querySelectorAll('.bot-row:not(.thinking)').length > ${before} && !document.querySelector('.bot-row.thinking')`, 60000);
    await sleep(settle);
    // frame the question at the top, then let the answer scroll in
    await js(`(() => { const rows = [...document.querySelectorAll('.user-row')]; const r = rows[rows.length - 1]; if (r) r.scrollIntoView({ block: 'start', behavior: 'smooth' }); })()`);
    await sleep(1200);
  };
  const slowScroll = async (px, steps = 6, sel = '.messages') => { for (let i = 0; i < steps; i++) { await js(`document.querySelector(${JSON.stringify(sel)})?.scrollBy({ top: ${px / steps}, behavior: 'smooth' })`); await sleep(450); } };

  // clean stage: chat centred, Ziv open
  await js(`document.querySelector('.app.with-right') && document.querySelector('button[title="Dot details"]')?.click()`);
  await openConv('Ziv');
  await sleep(1500);

  // s01 — the app
  mark('s01');
  await scrollChatBottom();
  await sleep(4000);
  await js(`document.querySelector('.messages').scrollTo({ top: 0, behavior: 'smooth' })`);
  await sleep(3000);
  await scrollChatBottom();
  await sleep(3000);

  // s02 — connect the company, see my subscriptions
  mark('s02');
  await click('.connector-card button.manage', 'Connect');
  await waitFor(`!!document.querySelector('.connector-card') && document.querySelector('.connector-card').textContent.includes('Connected')`, 60000);
  await sleep(2500);
  await scrollChatBottom();
  await sleep(2000);
  await click('.connect-pill');
  await sleep(1500);
  await click('.cat-chips button', 'Agents');
  await sleep(3500);

  // s03 — real public data: FalkorDB's GitHub repo
  mark('s03');
  await click('.cat-chips button', 'All');
  await sleep(400);
  await typeInto('.modal-search input', 'GitHub', 60);
  await sleep(1000);
  await js(`(() => { const r = [...document.querySelectorAll('.app-row')].find(x => x.textContent.includes('public repos')); r?.querySelector('.btn.add')?.click(); })()`);
  await sleep(800);
  await typeInto('.app-config input', 'FalkorDB/FalkorDB', 55);
  await sleep(500);
  await click('.app-config .btn.primary', 'Connect');
  await waitFor(`[...document.querySelectorAll('.app-row')].some(r => r.textContent.includes('public repos') || (r.textContent.includes('GitHub') && r.querySelector('.added')))  && [...document.querySelectorAll('.app-row')].some(r => /GitHub/.test(r.textContent) && r.querySelector('.added'))`, 150000);
  await sleep(3000);
  await click('.modal-backdrop');
  await sleep(800);

  // s04 — the graph and its schema
  mark('s04');
  await click('.graph-pulse');
  await sleep(6000);
  await click('.seg.big button', 'Schema');
  await sleep(6000);

  // s05 — algorithms as tools
  mark('s05');
  await click('.seg.big button', 'Algorithms');
  await sleep(2000);
  await click('.algo-presets button', 'Systems everything leans on');
  await sleep(4500);
  await click('.algo-presets button', 'Real working groups');
  await sleep(4500);

  // s06 — a multi-hop question
  mark('s06');
  await openConv('Ziv');
  await sleep(1200);
  await ask("What's blocking the EU launch?");
  await slowScroll(260, 4);
  await sleep(2500);

  // s07 — show path
  mark('s07');
  await js(`(() => { const l = [...document.querySelectorAll('.trace-link')]; l[l.length - 1]?.click(); })()`);
  await sleep(2500);
  await js(`[...document.querySelectorAll('.drawer .query-row')][1]?.click()`);
  await sleep(3000);
  await slowScroll(320, 4, '.drawer');
  await sleep(2500);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(800);

  // s08 — what if someone is out
  mark('s08');
  await ask('What if Hana is out next week?');
  await sleep(3500);

  // s09 — options weighed before deciding
  mark('s09');
  await ask('Should we delay the EU launch?');
  await js(`(() => { const s = [...document.querySelectorAll('.bot-row strong, .bot-row b')].find(e => e.textContent.includes('options, weighed')); s?.scrollIntoView({ block: 'start', behavior: 'smooth' }); })()`);
  await sleep(5000);

  // s10 — act: fix a ticket with a subscription
  mark('s10');
  await ask('Fix LUM-142', 2500);
  await waitFor(`!!document.querySelector('.draft-card .agent-choices')`, 30000);
  await js(`(() => { const d = [...document.querySelectorAll('.draft-card')].pop(); d?.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(2500);
  await js(`(() => { const d = [...document.querySelectorAll('.draft-card')].pop(); const b = [...d.querySelectorAll('.agent-choice')].find(x => x.textContent.includes('Codex')); b?.click(); })()`);
  await sleep(1500);
  await js(`(() => { const d = [...document.querySelectorAll('.draft-card')].pop(); [...d.querySelectorAll('.btn.primary')].find(x => x.textContent.includes('Approve'))?.click(); })()`);
  await sleep(2500);

  // s11 — the real run, in Forge's chat: the card ticks over, then Forge reports
  mark('s11');
  await openConv('Forge');
  await sleep(1500);
  await scrollChatBottom();
  await waitFor(`[...document.querySelectorAll('.run-card')].some(e => /3 passed/.test(e.textContent))`, 300000);
  await sleep(1000);
  await scrollChatBottom();
  await sleep(1200);
  await js(`(() => { const c = [...document.querySelectorAll('.run-card')].pop(); c?.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(4000);
  await scrollChatBottom();
  await sleep(3000);

  // s12 — make a dot; dots talk to each other
  mark('s12');
  await js(`document.querySelector('.side-actions button[title="New"]')?.click()`);
  await sleep(800);
  await click('.menu button', 'New dot');
  await sleep(1500);
  await click('.preset-grid .preset', 'Ledger');
  await sleep(3000);
  await openConv('Ziv');
  await sleep(1200);
  await js(`(() => { const c = [...document.querySelectorAll('.exchange-chip')].pop(); c?.scrollIntoView({ block: 'center', behavior: 'smooth' }); })()`);
  await sleep(1500);
  await js(`[...document.querySelectorAll('.exchange-chip')].pop()?.click()`);
  await sleep(4000);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.modal-backdrop')?.click()`);
  await sleep(600);

  // s13 — a real Codex session using ZivBot over MCP
  mark('s13');
  await click('.connect-pill');
  await sleep(2500);
  await click('.modal-backdrop');
  const term = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>
    body{margin:0;background:#0d0c0b;color:#e8e2da;font:15px/1.55 'JetBrains Mono',ui-monospace,Menlo,monospace;padding:34px 40px}
    .bar{display:flex;gap:8px;margin-bottom:22px}.bar i{width:12px;height:12px;border-radius:50%;background:#3a3633;display:block}
    .p{color:#ff8a3d}.dim{color:#8b847c}.ok{color:#7ee2a8}.mcp{color:#9ec5ff}pre{white-space:pre-wrap;margin:0}
  </style></head><body><div class="bar"><i></i><i></i><i></i></div><pre id="o"></pre></body></html>`)}`;
  await win.loadURL(term);
  await sleep(500);
  const add = (line, cls = '') => js(`(() => { const o = document.getElementById('o'); const s = document.createElement('span'); s.className = ${JSON.stringify(cls)}; s.textContent = ${JSON.stringify(line + '\n')}; o.appendChild(s); window.scrollTo(0, document.body.scrollHeight); })()`);
  const cmd = `codex exec -c 'mcp_servers.zivbot.url="${BASE}/mcp?user=…"' "Use the zivbot critical_path tool for 'EU Launch'. What blocks it, and what do I unblock first?"`;
  await add('$ ' + cmd, 'p');
  await add('');
  await new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--skip-git-repo-check', '-m', process.env.ZIV_CODEX_MODEL || 'gpt-5.6-terra',
      '-c', `mcp_servers.zivbot.url="${BASE}/mcp?user=${user}"`, '-c', 'mcp_servers.zivbot.default_tools_approval_mode="approve"',
      "Use the zivbot MCP server's critical_path tool for the project 'EU Launch'. Then answer in 3 short lines: what blocks it, and what to unblock first."],
    { cwd: out, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf) => {
      for (const line of String(buf).split('\n')) {
        const l = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        if (!l || /skill|SKILL|hook:|MallocStackLogging|tokens used|^[\d,]+$|^codex\(\d+\)/.test(l)) continue;
        void add(l, /^mcp:/.test(l) ? 'mcp' : /completed/.test(l) ? 'ok' : /^codex$/.test(l) ? 'dim' : '');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', resolve);
  });
  await sleep(4000);

  // s14 — close on the live app
  mark('s14');
  await win.loadURL(`${BASE}/?pair=${user}`);
  await sleep(2500);
  await click('.graph-pulse');
  await sleep(2500);
  await click('.seg.big button', 'Insights');
  await sleep(7000);

  rec = false;
  await sleep(300);
  mark('end');
  fs.writeFileSync(path.join(out, 'markers.json'), JSON.stringify({ fps: FPS, markers }, null, 1));
  app.quit();
});
