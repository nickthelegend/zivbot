import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { zivHome } from './connectors/git.ts';
import type { Field } from './connectors/types.ts';

/**
 * Connector credentials live in ~/.zivbot/secrets.json (0600), never in the
 * graph. Env vars (see TODO-KEYS.md) fill anything not stored.
 */
type Store = Record<string, Record<string, Record<string, string>>>; // user → connector → field → value

const file = () => join(zivHome(), 'secrets.json');

function load(): Store {
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
}

export function connectorConfig(userId: string, connector: string, fields: Field[] = []): Record<string, string> {
  const stored = load()[userId]?.[connector] || {};
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = stored[f.key] || (f.env ? process.env[f.env] : undefined);
    if (v) out[f.key] = v;
  }
  for (const [k, v] of Object.entries(stored)) if (!(k in out)) out[k] = v;
  return out;
}

export function saveConnectorConfig(userId: string, connector: string, values: Record<string, string>) {
  const s = load();
  s[userId] ??= {};
  s[userId][connector] = { ...(s[userId][connector] || {}), ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v != null)) };
  if (!existsSync(zivHome())) mkdirSync(zivHome(), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
  try { chmodSync(file(), 0o600); } catch { /* windows */ }
}

/** Which fields are satisfied (without revealing values). */
export function configuredFields(userId: string, connector: string, fields: Field[] = []) {
  const c = connectorConfig(userId, connector, fields);
  return Object.fromEntries(fields.map((f) => [f.key, !!c[f.key]]));
}
