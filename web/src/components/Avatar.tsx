/**
 * Ziv avatars: a round body with big oval eyes, like a friendly blob.
 * Each preset has its own colour and eye style.
 */
const STYLES: Record<string, { color: string; eyes: 'tall' | 'round' | 'side' | 'sleepy'; ring?: boolean }> = {
  ziv: { color: '#ff7a1a', eyes: 'tall' },
  forge: { color: '#22d3ee', eyes: 'side' },
  scout: { color: '#a78bfa', eyes: 'round' },
  ledger: { color: '#34d399', eyes: 'sleepy' },
  ghost: { color: '#e5e5e5', eyes: 'side' },
};

/** Hand-made character art for the preset Zivs (generated for ZivBot); custom Zivs use the vector blob. */
const ART = new Set(['ziv', 'forge', 'scout', 'ledger']);

export function Avatar({ avatar = 'ziv', color, size = 36, busy, badge }: { avatar?: string; color?: string; size?: number; busy?: boolean; badge?: boolean }) {
  const st = STYLES[avatar] || STYLES.ziv;
  if (ART.has(avatar) && (!color || color.toLowerCase() === st.color)) {
    return (
      <span className={`avatar art ${busy ? 'busy' : ''}`} style={{ width: size, height: size }}>
        <img src={`/dots/${avatar}.png`} width={size} height={size} alt="" draggable={false} />
        {badge && <i className="avatar-badge" />}
      </span>
    );
  }
  const fill = color || st.color;
  const eyes = {
    tall: [<ellipse key="a" cx="12.2" cy="15.5" rx="2.5" ry="4.2" />, <ellipse key="b" cx="19.6" cy="15.5" rx="2.5" ry="4.2" />],
    round: [<circle key="a" cx="12.5" cy="15.5" r="3" />, <circle key="b" cx="19.5" cy="15.5" r="3" />],
    side: [<ellipse key="a" cx="17.5" cy="14.5" rx="2.4" ry="3.8" />, <ellipse key="b" cx="23.5" cy="14.5" rx="2.4" ry="3.8" />],
    sleepy: [<rect key="a" x="9.5" y="15" width="6" height="2.6" rx="1.3" />, <rect key="b" x="17" y="15" width="6" height="2.6" rx="1.3" />],
  }[st.eyes];
  return (
    <span className={`avatar ${busy ? 'busy' : ''}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
        <defs>
          <radialGradient id={`g-${avatar}-${fill}`} cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.35" />
            <stop offset="60%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="15.5" fill={fill} />
        <circle cx="16" cy="16" r="15.5" fill={`url(#g-${avatar}-${fill})`} />
        <g fill="#141414">{eyes}</g>
        {st.eyes !== 'sleepy' && (
          <g fill="#fff" opacity="0.9">
            {st.eyes === 'side' ? <><circle cx="18.2" cy="13" r="0.9" /><circle cx="24.2" cy="13" r="0.9" /></> : <><circle cx="13" cy="13.6" r="0.9" /><circle cx="20.4" cy="13.6" r="0.9" /></>}
          </g>
        )}
      </svg>
      {badge && <i className="avatar-badge" />}
    </span>
  );
}

export function AvatarStack({ dots, size = 22 }: { dots: { avatar?: string; color?: string; uid: string }[]; size?: number }) {
  return (
    <span className="avatar-stack" style={{ width: size + (Math.min(dots.length, 4) - 1) * size * 0.45 }}>
      {dots.slice(0, 4).map((d, i) => (
        <span key={d.uid} style={{ left: i * size * 0.45, zIndex: 10 - i }}>
          <Avatar avatar={d.avatar} color={d.color} size={size} />
        </span>
      ))}
    </span>
  );
}

/** GrokBot-style group avatar: up to four Zivs clustered in one circle. */
export function AvatarCluster({ dots, size = 38 }: { dots: { avatar?: string; color?: string; uid: string }[]; size?: number }) {
  const d = dots.slice(0, 4);
  const small = Math.round(size * (d.length > 2 ? 0.52 : 0.62));
  const pos = d.length === 2
    ? [[0, 0], [size - small, size - small]]
    : d.length === 3 ? [[(size - small) / 2, 0], [0, size - small], [size - small, size - small]]
      : [[0, 0], [size - small, 0], [0, size - small], [size - small, size - small]];
  return (
    <span className="avatar-cluster" style={{ width: size, height: size }}>
      {d.map((x, i) => (
        <span key={x.uid} style={{ left: pos[i][0], top: pos[i][1] }}><Avatar avatar={x.avatar} color={x.color} size={small} /></span>
      ))}
    </span>
  );
}
