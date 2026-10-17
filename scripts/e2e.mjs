// End-to-end smoke test against a running API: node scripts/e2e.mjs [baseUrl]
const BASE = process.argv[2] || 'http://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let USER;
async function api(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(USER ? { 'x-ziv-user': USER } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok && r.status !== 202) throw new Error(`${path} ${r.status} ${t.slice(0, 300)}`);
  return j;
}
const state = () => api('/api/state');
async function convOf(name) { const s = await state(); return s.dots.find((d) => d.name === name)?.conv; }
async function say(conv, text, wait = 1) {
  const before = (await api(`/api/conversations/${conv}/messages`)).messages.length;
  await api(`/api/conversations/${conv}/messages`, { text });
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const m = (await api(`/api/conversations/${conv}/messages`)).messages;
    const fresh = m.slice(before).filter((x) => x.role === 'assistant');
    if (fresh.length >= wait) return m.slice(before);
  }
  throw new Error(`no reply to "${text}"`);
}
const show = (ms) => ms.forEach((m) => console.log(`  [${m.role}] ${m.text.replace(/\n/g, '\n      ').slice(0, 900)}${m.cards?.length ? `\n      cards: ${m.cards.map((c) => c.type + (c.draft ? `(${c.draft.kind}:${c.draft.agent || c.draft.to || ''})` : c.with ? `(${c.with.name})` : '')).join(', ')}` : ''}`));

console.log('health', await api('/api/health'));
USER = (await api('/api/session', {})).id;
console.log('user', USER);
let ziv = await convOf('Ziv');
show((await api(`/api/conversations/${ziv}/messages`)).messages);
show(await say(ziv, 'Nick'));
show(await say(ziv, 'Ziv', 3));
console.log('connect demo…');
const t0 = Date.now();
console.log(await api('/api/connectors/demo/connect', {}), `${Date.now() - t0}ms`);
await sleep(1500);
show((await api(`/api/conversations/${ziv}/messages`)).messages.slice(-3));
console.log('dots', (await state()).dots.map((d) => `${d.name}:${d.stage}`).join(', '));
for (const q of ['Suggest a first task', 'who knows payments-api?', 'what breaks if billing-db goes down?', 'why did we move to Stripe Billing?', 'what did Brightwave ask for last month, and was it resolved?', 'how is Kate Morgan connected to Priya Raman?', 'who are the key people?', 'remember that I prefer Codex for backend fixes']) {
  console.log(`\n> ${q}`);
  show(await say(ziv, q));
}
console.log('\n> Fix LUM-142 and LUM-139 (delegation to Forge)');
const fix = await say(ziv, 'Fix LUM-142 and LUM-139');
console.log('connectors', (await api('/api/connectors')).length);
show(fix);
const last = fix.filter((m) => m.role === 'assistant').pop();
if (last?.answer) {
  const tr = await api(`/api/answers/${last.answer}`);
  console.log(`trace: ${tr.queries.length} queries, ${tr.nodes.length} nodes, ${tr.edges.length} edges; tools=${tr.tools}`);
  console.log(tr.queries.slice(0, 4).map((q) => `   - ${q.label} (${q.ms}ms, ${q.rows} rows)`).join('\n'));
}
console.log('\nForge chat:'); show((await api(`/api/conversations/${await convOf('Forge')}/messages`)).messages.slice(-3));
console.log('fleet routing', JSON.stringify((await api('/api/fleet')).routing.slice(0, 3).map((r) => [r.name, r.score, r.reasons.join('; ')])));
console.log('stats', JSON.stringify((await api('/api/stats')).labels.slice(0, 12)));
console.log(`\nUSER=${USER}`);
