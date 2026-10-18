import { useMemo, useState } from 'react';
import { api, API_BASE, userId, type Connector } from '../api';
import { useStore, set, toast, loadConnectors } from '../store';
import { AppIcon, Icon } from './icons';

const CATS = ['All', 'Agents', 'Workspace', 'Communication', 'Productivity', 'Code', 'Research', 'Sales', 'Finance', 'Notifications'];
const CHIPS = ['All', 'Agents', 'Productivity', 'Communication', 'Code'];
const MORE = CATS.filter((c) => !CHIPS.includes(c));

/** GrokBot-style "Connect Apps": search, categories, Add / Connect per app. */
export function ConnectModal() {
  const open = useStore((s) => s.connectOpen);
  const connectors = useStore((s) => s.connectors);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [config, setConfig] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const connected = connectors.filter((c) => c.status === 'connected');
  const filtered = useMemo(() => connectors.filter((c) => (cat === 'All' || c.category === cat) && (!q || `${c.name} ${c.description} ${c.category}`.toLowerCase().includes(q.toLowerCase()))), [connectors, q, cat]);
  if (!open) return null;
  const groups = cat === 'All' && !q
    ? [['Recommended for you', filtered.filter((c) => c.recommended)] as const, ...CATS.slice(1).map((k) => [k, filtered.filter((c) => c.category === k)] as const)]
    : [[cat === 'All' ? 'Results' : cat, filtered] as const];
  return (
    <div className="modal-backdrop" onClick={() => set({ connectOpen: false })}>
      <div className="modal connect-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Connect Apps</h2>
          <span className="connected-count">
            <span className="icon-stack">{connected.slice(0, 3).map((c) => <AppIcon key={c.id} slug={c.icon} size={18} />)}</span>
            {connected.length} connected <Icon.chevron size={14} />
          </span>
          <button aria-label="Close" className="icon-btn" onClick={() => set({ connectOpen: false })}><Icon.close size={18} /></button>
        </div>
        <div className="modal-search">
          <div className="search-box"><Icon.search size={16} /><input autoFocus placeholder="Search across apps and skills" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <button className="btn templates" onClick={() => set({ connectOpen: false, newDotOpen: true })}><span className="tpl-dot" /> Ziv templates <Icon.external size={13} /></button>
        </div>
        <div className="cat-chips">
          {CHIPS.map((c) => <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
          <div className="menu-anchor">
            <button className={MORE.includes(cat) ? 'on' : ''} onClick={() => setMore(!more)}>{MORE.includes(cat) ? cat : 'More'} <Icon.down size={13} /></button>
            {more && <div className="menu down" onMouseLeave={() => setMore(false)}>{MORE.map((c) => <button key={c} onClick={() => { setCat(c); setMore(false); }}>{c}</button>)}</div>}
          </div>
        </div>
        <div className="modal-body">
          {cat === 'All' && !q && <McpBox />}
          {groups.filter(([, list]) => list.length).map(([title, list]) => (
            <section key={title}>
              <div className="sec-head"><h3>{title}</h3>{cat === 'All' && !q && title !== 'Recommended for you' && <button className="link-btn" onClick={() => setCat(title)}>View all</button>}</div>
              <div className="app-grid">
                {(cat === 'All' && !q ? list.slice(0, 6) : list).map((c) => (
                  <AppRow key={c.id} c={c} open={config === c.id} onToggle={() => setConfig(config === c.id ? null : c.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Your graph's tools, from any MCP client — the same ones the Zivs use. */
function McpBox() {
  const url = `${API_BASE || location.origin}/mcp?user=${userId}`;
  const cmd = `claude mcp add --transport http zivbot "${url}"`;
  return (
    <section className="mcp-box">
      <div className="grow">
        <h3><Icon.bolt size={14} /> Use your graph from any agent (MCP)</h3>
        <small>30 graph tools — blast radius, critical path, diagnose, what-if, PageRank and more — with the Cypher behind every answer. Works in Claude Code, Codex, Cursor and Claude Desktop.</small>
        <code className="mcp-cmd">{cmd}</code>
      </div>
      <button className="btn ghost sm" onClick={() => void navigator.clipboard.writeText(cmd).then(() => toast('Copied'))}>Copy</button>
    </section>
  );
}

/** One-time, per computer: the OAuth client Google requires before any "Sign in with Google". */
function GoogleSetup({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="app-config google-setup">
      <div className="gs-title">One-time setup for Google sign-in</div>
      <ol>
        <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud → Credentials</a> (any project) and enable the <b>Gmail API</b> and <b>Google Calendar API</b>.</li>
        <li><b>OAuth consent screen</b>: External, name “ZivBot”, add the Google account you'll connect as a <b>test user</b>.</li>
        <li><b>Create credentials → OAuth client ID → Desktop app</b>. Paste its ID and secret here.</li>
      </ol>
      <label><span>Client ID</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="….apps.googleusercontent.com" /></label>
      <label><span>Client secret</span><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" /></label>
      <small>Saved on this computer only. After this, any Google account is one click.</small>
      <div className="row-end"><button className="btn primary sm" disabled={busy || !id || !secret} onClick={() => { setBusy(true); void api.googleClient(id, secret).then(onDone).catch((e) => toast(e.message)).finally(() => setBusy(false)); }}>{busy ? 'Saving…' : 'Save and sign in'}</button></div>
    </div>
  );
}

function AppRow({ c, open, onToggle }: { c: Connector; open: boolean; onToggle: () => void }) {
  const progress = useStore((s) => s.connectorProgress[c.id]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const isAgent = c.id.startsWith('agent-');
  const connected = c.status === 'connected';
  const needsInput = (c.fields?.length || 0) > 0;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.connect(c.id, values);
      if (!r.ok) toast(r.missing ? `${c.name} needs: ${r.missing.join(', ')}` : r.error || 'Failed');
      else { toast(`${c.name} connected`); if (open) onToggle(); }
      await loadConnectors();
    } catch (e: any) { toast(e.data?.missing ? `${c.name} needs: ${e.data.missing.join(', ')}` : e.message); await loadConnectors(); } finally { setBusy(false); }
  };
  const [setup, setSetup] = useState(false);
  const googleSignIn = async () => {
    setBusy(true);
    try {
      const g = await api.google();
      if (!g.clientReady) { setSetup(true); return; }
      await api.googleSignIn();
      toast('Choose your Google account in the browser');
    } catch (e: any) { if (/client/i.test(e.message)) setSetup(true); else toast(e.message); } finally { setBusy(false); }
  };
  const label = connected ? (isAgent ? 'Ready' : 'Added') : c.status === 'syncing' || busy ? 'Syncing…' : isAgent ? (c.status === 'not installed' ? 'Install' : 'Detect') : c.auth === 'key' ? 'Connect' : 'Add';
  return (
    <div className={`app-row ${open ? 'open' : ''}`}>
      <div className="app-main">
        <AppIcon slug={c.icon} size={38} />
        <div className="grow">
          <div className="app-name">{c.name}{c.auth === 'demo' && <span className="pill-mini">demo</span>}{c.status === 'demo' && <span className="pill-mini">sample data</span>}{c.auth === 'key' && !connected && <span className="pill-mini key">key</span>}</div>
          <div className="app-desc">{progress && c.status === 'syncing' ? progress : c.error && c.status !== 'connected' ? c.error : connected && c.counts ? Object.entries(c.counts).slice(0, 4).map(([k, v]) => `${v} ${k}`).join(' · ') : c.description}</div>
        </div>
        {c.id === 'google' && !connected && c.status !== 'desktop only' ? (
          <button className="btn add google-btn" disabled={busy} onClick={() => void googleSignIn()}><AppIcon slug="google" size={15} /> {busy ? 'Waiting for Google…' : 'Sign in with Google'}</button>
        ) : c.status === 'desktop only' ? (
          <span className="desktop-only" title="Runs on your own machine">Desktop app</span>
        ) : connected ? (
          <button className="added" onClick={needsInput ? onToggle : undefined}><Icon.check size={14} /> {label}</button>
        ) : (
          <button className="btn add" disabled={busy || c.status === 'syncing'} onClick={() => (needsInput && !open ? onToggle() : void go())}>{label}</button>
        )}
      </div>
      {setup && <GoogleSetup onDone={() => { setSetup(false); void googleSignIn(); }} />}
      {open && c.id !== 'google' && (
        <div className="app-config">
          {c.fields.map((f) => (
            <label key={f.key}>
              <span>{f.label}{f.optional ? ' (optional)' : ''}{c.configured[f.key] && <em> · saved</em>}</span>
              <input type={f.secret ? 'password' : 'text'} placeholder={c.configured[f.key] ? '•••••••• (saved)' : f.placeholder} value={values[f.key] || ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              {f.env && <small>or set <code>{f.env}</code> in .env</small>}
            </label>
          ))}
          {c.actions.length > 0 && <div className="app-actions">Gives your Zivs: {c.actions.map((a) => <code key={a.name}>{a.name}{a.mutates ? '*' : ''}</code>)} <small>* asks first</small></div>}
          <div className="row-end">
            {connected && <button className="btn ghost sm" onClick={() => void api.disconnect(c.id).then(loadConnectors)}>Disconnect</button>}
            <button className="btn primary sm" disabled={busy} onClick={() => void go()}>{busy ? 'Connecting…' : connected ? 'Re-sync' : 'Connect'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
