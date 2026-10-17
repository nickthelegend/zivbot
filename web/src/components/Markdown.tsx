import type { ReactNode } from 'react';

/** Small, safe markdown: paragraphs, lists, bold, italics, inline code, code fences, links. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|_([^_\n]+)_|(https?:\/\/[^\s)]+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[2]) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3]) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4]) out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer">{m[4]}</a>);
    else if (m[6]) out.push(<em key={k}>{m[6]}</em>);
    else if (m[7]) out.push(<a key={k} href={m[7]} target="_blank" rel="noreferrer">{m[7].replace(/^https?:\/\//, '').slice(0, 48)}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[][] = [];
      while (i < lines.length && (/^\s*[-*•]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*[-*•]\s+/.test(lines[i])) items.push([lines[i].replace(/^\s*[-*•]\s+/, '')]);
        else items[items.length - 1].push(lines[i].trim());
        i++;
      }
      blocks.push(<ul key={k++}>{items.map((it, j) => <li key={j}>{it.map((x, n) => <span key={n}>{n > 0 && <br />}{inline(x, `${k}-${j}-${n}`)}</span>)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[][] = [];
      while (i < lines.length && (/^\s*\d+\.\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*\d+\.\s+/.test(lines[i])) items.push([lines[i].replace(/^\s*\d+\.\s+/, '')]);
        else items[items.length - 1].push(lines[i].trim());
        i++;
      }
      blocks.push(<ol key={k++}>{items.map((it, j) => <li key={j}>{it.map((x, n) => <span key={n}>{n > 0 && <br />}{inline(x, `${k}-${j}-${n}`)}</span>)}</li>)}</ol>);
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      const lvl = line.match(/^#+/)![0].length;
      const T = (`h${lvl + 2}`) as 'h3' | 'h4' | 'h5';
      blocks.push(<T key={k++}>{inline(line.replace(/^#+\s/, ''), `h${k}`)}</T>);
      i++;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*[-*•]\s+|\s*\d+\.\s+|```|#{1,3}\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++}>{para.map((p, j) => <span key={j}>{j > 0 && <br />}{inline(p, `${k}-${j}`)}</span>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
