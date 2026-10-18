import { userGraph, falkor } from '../server/graph.ts';
import { ensureSchema } from '../server/schema.ts';
import { ingestDirectory, ingestTickets, ingestMail, ingestCalendar, ingestSlack, ingestNotion } from '../server/connectors/workspace.ts';
import { prepareDemoRepo, ingestRepo } from '../server/connectors/git.ts';
import { syncFleet, seedRunHistory } from '../server/fleet.ts';
import { enrich } from '../server/analytics.ts';
import { createDot, updateDot } from '../server/memory.ts';
import { think } from '../server/agent.ts';
const USER = `scratch${Date.now().toString(36)}`;
const g = await userGraph(USER);
await ensureSchema(g);
await ingestDirectory(g, { name: 'Sam' }); await ingestTickets(g); await ingestMail(g); await ingestCalendar(g); await ingestSlack(g); await ingestNotion(g);
await ingestRepo(g, await prepareDemoRepo(USER), { name: 'lumen-payments', implements: 'system:payments-api' });
await syncFleet(g); await seedRunHistory(g); await enrich(g);
const { dot, conv } = await createDot(g, { name: 'Ziv', avatar: 'ziv', role: 'Chief of staff' });
await updateDot(g, dot, { stage: 'ready' } as any);
for (const q of process.argv.slice(2)) {
  const t0 = Date.now();
  const r = await think(USER, { uid: dot, conv, name: 'Ziv', role: 'Chief of staff' } as any, conv, q);
  console.log('====', q, '|', r.mode, '|', r.tools.join(','), `${Date.now() - t0}ms\n` + r.text.slice(0, 900));
}
await g.drop(); await (await falkor()).close();
