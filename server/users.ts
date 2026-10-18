import { randomUUID } from 'node:crypto';
import { registryGraph, userGraph } from './graph.ts';
import { ensureSchema } from './schema.ts';
import { createDot, listDots, DOT_PRESETS, postMessage, getDot } from './memory.ts';
import { startOnboarding } from './agent.ts';
import { syncFleet } from './fleet.ts';

/** Users live in a small registry graph; each user's data in its own graph. */
export async function ensureUser(id?: string) {
  const reg = await registryGraph();
  if (id && /^[a-zA-Z0-9_-]{6,64}$/.test(id)) {
    const hit = await reg.one(`MATCH (u:User {id:$id}) SET u.lastSeen = $now RETURN u.id AS id`, { id, now: Date.now() }, 'find user');
    if (hit) {
      const g = await userGraph(id);
      await ensureSchema(g);
      return { id, created: false };
    }
  }
  const uid = id && /^[a-zA-Z0-9_-]{6,64}$/.test(id) ? id : randomUUID().replace(/-/g, '').slice(0, 20);
  await reg.q(`MERGE (u:User {id:$id}) ON CREATE SET u.createdAt = $now SET u.lastSeen = $now`, { id: uid, now: Date.now() }, 'register user');
  const g = await userGraph(uid);
  await ensureSchema(g);
  await syncFleet(g);
  const z = DOT_PRESETS[0];
  const { dot, conv } = await createDot(g, { ...z, stage: 'onboard:user' });
  await startOnboarding(uid, { uid: dot, conv, name: z.name, role: z.role });
  return { id: uid, created: true };
}

/** Is this id a registered user? Cached, so every request can ask. */
const known = new Set<string>();
export async function isUser(id: string) {
  if (known.has(id)) return true;
  const hit = await (await registryGraph()).one(`MATCH (u:User {id:$id}) RETURN u.id AS id`, { id }, '~registered?');
  if (hit) known.add(id);
  return !!hit;
}
export const forgetUser = (id: string) => known.delete(id);

/** Users seen recently, newest first — the background loop only works for people who are around. */
export async function allUsers(activeWithinMs = 2 * 86_400_000, max = 50): Promise<string[]> {
  const reg = await registryGraph();
  return (await reg.q(
    `MATCH (u:User) WHERE coalesce(u.lastSeen, u.createdAt, 0) > $since RETURN u.id AS id ORDER BY coalesce(u.lastSeen, u.createdAt) DESC LIMIT $max`,
    { since: Date.now() - activeWithinMs, max },
  )).map((r) => r.id);
}

/** Hosted demo: drop graphs nobody has opened in a week. */
export async function pruneUsers(idleMs = 7 * 86_400_000) {
  const reg = await registryGraph();
  const stale = (await reg.q(`MATCH (u:User) WHERE coalesce(u.lastSeen, u.createdAt, 0) < $before RETURN u.id AS id LIMIT 200`, { before: Date.now() - idleMs })).map((r) => r.id as string);
  for (const id of stale) {
    await (await userGraph(id)).drop().catch(() => {});
    await reg.q(`MATCH (u:User {id:$id}) DELETE u`, { id });
    forgetUser(id);
  }
  return stale.length;
}

/** After the first workspace lands, Ziv brings in its specialists. */
export async function ensureTeam(userId: string) {
  const g = await userGraph(userId);
  const existing = new Set((await listDots(g)).map((d) => d.avatar));
  const added: string[] = [];
  for (const p of DOT_PRESETS.slice(1, 3)) {
    if (existing.has(p.avatar)) continue;
    const { dot, conv } = await createDot(g, p);
    added.push(p.name);
    await postMessage(userId, g, { conv, role: 'assistant', dot, text: `Hi! I'm ${p.name}. ${p.role.split(' — ')[1].replace(/^./, (c) => c.toUpperCase())}.\n\nI share the same graph memory as the other Zivs, so you can talk to me directly or let them send work my way.` });
  }
  return added;
}

export { getDot };
