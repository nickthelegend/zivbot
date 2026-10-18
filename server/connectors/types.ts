import type { UserGraph } from '../graph.ts';

/**
 * A connector maps one app into the user's graph (sync) and gives Zivs
 * hands inside that app (actions). Actions with `mutates: true` never run
 * directly — the Ziv creates an approval Draft, and the action runs when
 * the user approves it.
 */

export type Category = 'Workspace' | 'Communication' | 'Productivity' | 'Code' | 'Agents' | 'Research' | 'Sales' | 'Finance' | 'Data' | 'Notifications';

export type Field = {
  key: string;
  label: string;
  /** env var that can provide it instead (see TODO-KEYS.md) */
  env?: string;
  secret?: boolean;
  placeholder?: string;
  optional?: boolean;
  help?: string;
};

export type ConnectorCtx = {
  g: UserGraph;
  userId: string;
  /** field values: stored config merged over env vars */
  config: Record<string, string>;
  progress: (msg: string) => void;
};

export type ConnectorAction = {
  name: string;
  description: string;
  params: { type: 'object'; properties: Record<string, any>; required?: string[] };
  mutates: boolean;
  run: (ctx: ConnectorCtx, args: any) => Promise<string>;
};

export type ConnectorDef = {
  id: string;
  name: string;
  category: Category;
  description: string;
  /** simple-icons slug, or a built-in icon name for non-brand connectors */
  icon: string;
  color?: string;
  /** none = works out of the box; key = needs credentials; local = needs something on this computer */
  auth: 'none' | 'key' | 'local' | 'demo';
  fields?: Field[];
  docs?: string;
  recommended?: boolean;
  /** pull the app into the graph; returns counts for the summary line */
  sync?: (ctx: ConnectorCtx) => Promise<Record<string, number | string>>;
  actions?: ConnectorAction[];
};

export class MissingConfig extends Error {
  constructor(public fields: string[]) {
    super(`Missing ${fields.join(', ')}`);
  }
}

export function need(ctx: ConnectorCtx, ...keys: string[]) {
  const missing = keys.filter((k) => !ctx.config[k]);
  if (missing.length) throw new MissingConfig(missing);
  return keys.map((k) => ctx.config[k]);
}

/** fetch JSON with a clear error message (status + first bytes of the body). */
export async function getJson<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'user-agent': 'ZivBot/0.1 (+https://github.com/nickthelegend/zivbot)', ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}
