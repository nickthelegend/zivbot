import { userGraph, falkor } from '../server/graph.ts';
import { ensureSchema } from '../server/schema.ts';
import { ingestDirectory, ingestTickets, ingestMail, ingestCalendar, ingestSlack, ingestNotion } from '../server/connectors/workspace.ts';
import { prepareDemoRepo, ingestRepo } from '../server/connectors/git.ts';
import { syncFleet, seedRunHistory } from '../server/fleet.ts';
import { enrich } from '../server/analytics.ts';
import { createDot } from '../server/memory.ts';
import { plan } from '../server/planner.ts';
import { insights } from '../server/insights.ts';
const USER = `scratch${Date.now().toString(36)}`;
const g = await userGraph(USER);
await ensureSchema(g);
await ingestDirectory(g, { name: 'Sam' }); await ingestTickets(g); await ingestMail(g); await ingestCalendar(g); await ingestSlack(g); await ingestNotion(g);
await ingestRepo(g, await prepareDemoRepo(USER), { name: 'lumen-payments', implements: 'system:payments-api' });
await syncFleet(g); await seedRunHistory(g); await enrich(g);
const dot = (await createDot(g, { name: 'Ziv', avatar: 'ziv', role: 'Chief of staff' })).dot;
const qs = process.argv.slice(2);
for (const q of qs) {
  if (q === 'INSIGHTS') { for (const s of await insights(g)) console.log('##', s.key, s.items.map((i) => i.title + ' — ' + i.detail).join('\n   ')); continue; }
  const r = await plan({ g, userId: USER, dot } as any, q, {});
  console.log('====', q, '| tools:', r.tools.join(','), '\n' + r.text.slice(0, 700), r.cards.filter((c: any) => c.type === 'options').map((c: any) => '\n  [opts] ' + c.options.map((o: any) => o.label).join(' / ')).join(''));
}
await g.drop(); await (await falkor()).close();
