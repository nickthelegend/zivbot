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
    const hit = await reg.one(`MATCH (u:User {id:$id}) RETURN u.id AS id`, { id }, 'find user');
    if (hit) {
      const g = await userGraph(id);
      await ensureSchema(g);
      return { id, created: false };
    }
  }
  const uid = id && /^[a-zA-Z0-9_-]{6,64}$/.test(id) ? id : randomUUID().replace(/-/g, '').slice(0, 20);
  await reg.q(`MERGE (u:User {id:$id}) ON CREATE SET u.createdAt = $now`, { id: uid, now: Date.now() }, 'register user');
  const g = await userGraph(uid);
  await ensureSchema(g);
  await syncFleet(g);
  const z = DOT_PRESETS[0];
  const { dot, conv } = await createDot(g, { ...z, stage: 'onboard:user' });
  await startOnboarding(uid, { uid: dot, conv, name: z.name, role: z.role });
  return { id: uid, created: true };
}

export async function allUsers(): Promise<string[]> {
  const reg = await registryGraph();
  return (await reg.q(`MATCH (u:User) RETURN u.id AS id`)).map((r) => r.id);
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
    await postMessage(userId, g, { conv, role: 'assistant', dot, text: `Hi! I'm ${p.name}. ${p.role.split(' — ')[1].replace(/^./, (c) => c.toUpperCase())}.\n\nI share the same graph memory as the other dots, so you can talk to me directly or let them send work my way.` });
  }
  return added;
}

export { getDot };
