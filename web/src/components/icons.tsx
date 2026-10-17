import {
  siNotion, siLinear, siGithub, siGoogle, siJira, siSentry, siStripe, siHubspot, siVercel, siTelegram, siDiscord, siClaude, siCursor, siX,
  siGit, siRss, siYcombinator, siGooglecalendar, siObsidian, siWikipedia, siModelcontextprotocol, siGmail, siAnthropic,
} from 'simple-icons';

const si: Record<string, { path: string; hex: string }> = {
  notion: siNotion, linear: siLinear, github: siGithub, google: siGoogle, jira: siJira, sentry: siSentry, stripe: siStripe, hubspot: siHubspot,
  vercel: siVercel, telegram: siTelegram, discord: siDiscord, claude: siClaude, cursor: siCursor, x: siX, git: siGit, rss: siRss,
  ycombinator: siYcombinator, googlecalendar: siGooglecalendar, obsidian: siObsidian, wikipedia: siWikipedia, modelcontextprotocol: siModelcontextprotocol,
  gmail: siGmail, anthropic: siAnthropic,
};

/** Brand marks for connectors (simple-icons), with letter tiles as fallback. */
const BRAND: Record<string, { path?: string; hex: string; letter?: string }> = {};
function brand(slug: string) {
  if (BRAND[slug]) return BRAND[slug];
  const icon = si[slug];
  const fallbacks: Record<string, { hex: string; letter: string }> = {
    slack: { hex: '4A154B', letter: '#' }, openai: { hex: '111111', letter: '◎' }, opencode: { hex: '111111', letter: '>_' },
    firecrawl: { hex: 'FF6B2C', letter: '🔥' }, zivbot: { hex: 'FF7A1A', letter: 'Z' },
  };
  BRAND[slug] = icon ? { path: icon.path, hex: icon.hex } : fallbacks[slug] || { hex: '666666', letter: slug[0]?.toUpperCase() };
  return BRAND[slug];
}

export function AppIcon({ slug, size = 36 }: { slug: string; size?: number }) {
  const b = brand(slug);
  const dark = ['111111', '000000', '181717', '24292F'].includes(b.hex.toUpperCase());
  if (slug === 'slack') {
    const P = ({ x, y, w, h, c }: { x: number; y: number; w: number; h: number; c: string }) => <rect x={x} y={y} width={w} height={h} rx={1.65} fill={c} />;
    return (
      <span className="app-icon" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden>
          <P x={5.4} y={12.6} w={3.3} h={8.6} c="#E01E5A" /><P x={2} y={12.6} w={3.3} h={3.3} c="#E01E5A" />
          <P x={2.8} y={5.4} w={8.6} h={3.3} c="#36C5F0" /><P x={8.1} y={2} w={3.3} h={3.3} c="#36C5F0" />
          <P x={15.3} y={2.8} w={3.3} h={8.6} c="#2EB67D" /><P x={18.7} y={8.1} w={3.3} h={3.3} c="#2EB67D" />
          <P x={12.6} y={15.3} w={8.6} h={3.3} c="#ECB22E" /><P x={12.6} y={18.7} w={3.3} h={3.3} c="#ECB22E" />
        </svg>
      </span>
    );
  }
  if (slug === 'openai') {
    return (
      <span className="app-icon" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} aria-hidden fill="none" stroke="#111" strokeWidth="1.7">
          {[0, 60, 120].map((r) => <ellipse key={r} cx="12" cy="12" rx="9" ry="4.2" transform={`rotate(${r} 12 12)`} />)}
        </svg>
      </span>
    );
  }
  if (slug === 'zivbot') {
    return (
      <span className="app-icon" style={{ width: size, height: size, background: '#ff7a1a' }}>
        <svg viewBox="0 0 32 32" width={size * 0.66} height={size * 0.66}><ellipse cx="12" cy="16" rx="3" ry="5" fill="#141414" /><ellipse cx="20" cy="16" rx="3" ry="5" fill="#141414" /></svg>
      </span>
    );
  }
  return (
    <span className="app-icon" style={{ width: size, height: size }}>
      {b.path ? (
        <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56} aria-hidden><path d={b.path} fill={dark ? '#111' : `#${b.hex}`} /></svg>
      ) : (
        <b style={{ color: `#${b.hex}`, fontSize: size * 0.42 }}>{b.letter}</b>
      )}
    </span>
  );
}

type P = { size?: number; className?: string };
const I = (d: React.ReactNode, vb = '0 0 24 24') => ({ size = 18, className }: P) => (
  <svg viewBox={vb} width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>{d}</svg>
);

export const Icon = {
  search: I(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  plus: I(<path d="M12 5v14M5 12h14" />),
  mic: I(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  wave: I(<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />),
  send: I(<path d="M12 19V5M5 12l7-7 7 7" />),
  close: I(<path d="M6 6l12 12M18 6 6 18" />),
  chevron: I(<path d="m9 6 6 6-6 6" />),
  down: I(<path d="m6 9 6 6 6-6" />),
  graph: I(<><circle cx="5" cy="6" r="2.2" /><circle cx="19" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><circle cx="12" cy="10" r="1.6" /><path d="M7 7l4 2.4M17 7l-4 2.4M12 11.6V16" /></>),
  path: I(<><circle cx="5" cy="18" r="2" /><circle cx="19" cy="6" r="2" /><path d="M7 18h4a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3h0" /></>),
  chat: I(<path d="M4 5h16v11H8l-4 4z" />),
  bolt: I(<path d="M13 3 4 14h7l-1 7 9-11h-7z" />),
  edit: I(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>),
  phone: I(<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />),
  bell: I(<><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></>),
  monitor: I(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>),
  laptop: I(<><rect x="5" y="5" width="14" height="10" rx="1.5" /><path d="M3 19h18" /></>),
  check: I(<path d="m5 12 5 5 9-10" />),
  x: I(<path d="M6 6l12 12M18 6 6 18" />),
  play: I(<path d="M7 5v14l11-7z" />),
  file: I(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>),
  brain: I(<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" />),
  sun: I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>),
  moon: I(<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z" />),
  panel: I(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>),
  users: I(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5" /></>),
  terminal: I(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>),
  database: I(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  spark: I(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />),
  refresh: I(<><path d="M20 11a8 8 0 0 0-14-5L4 8M4 13a8 8 0 0 0 14 5l2-2" /><path d="M4 4v4h4M20 20v-4h-4" /></>),
  external: I(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>),
};
