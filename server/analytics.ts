import type { UserGraph } from './graph.ts';

/**
 * Derived structure the agent reasons over, recomputed after every ingest:
 *
 *  - (:Person)-[:COLLABORATES {weight}]-(:Person) from shared mail, meetings,
 *    projects and channels — the social graph nobody wrote down.
 *  - Person.rank      PageRank over COLLABORATES  → who matters most to you
 *  - Person.community label propagation          → the real working groups
 *  - Person.broker    betweenness                → who connects groups
 *  - System.criticality PageRank over DEPENDS_ON  → what everything leans on
 */
export async function enrich(g: UserGraph) {
  await g.q(`MATCH ()-[c:COLLABORATES]->() DELETE c`, {}, 'reset collaboration edges');
  const pairs: [string, string, string][] = [
    ['mail', `MATCH (a:Person)<-[:FROM|TO]-(e:Email)-[:FROM|TO]->(b:Person) WHERE a <> b AND NOT coalesce(e.newsletter,false)`, 'e'],
    ['meetings', `MATCH (a:Person)-[:ATTENDS]->(e:Event)<-[:ATTENDS]-(b:Person) WHERE a <> b`, 'e'],
    ['projects', `MATCH (a:Person)-[:WORKS_ON]->(e:Project)<-[:WORKS_ON]-(b:Person) WHERE a <> b`, 'e'],
    ['chat', `MATCH (a:Person)-[:POSTED]->(:ChatMessage)-[:IN]->(e:Channel)<-[:IN]-(:ChatMessage)<-[:POSTED]-(b:Person) WHERE a <> b`, 'e'],
    ['code', `MATCH (a:Person)<-[:AUTHORED_BY]-(:Commit)-[:TOUCHES]->(e:File)<-[:TOUCHES]-(:Commit)-[:AUTHORED_BY]->(b:Person) WHERE a <> b`, 'e'],
  ];
  for (const [kind, match, v] of pairs) {
    await g.q(
      `${match}
       WITH a, b, count(DISTINCT ${v}) AS w
       MERGE (a)-[c:COLLABORATES]->(b)
       SET c.${kind} = w, c.weight = coalesce(c.weight, 0) + w`,
      {},
      `derive collaboration from ${kind}`,
    );
  }
  const ranks = await g.q(`CALL algo.pageRank('Person', 'COLLABORATES') YIELD node, score SET node.rank = score RETURN count(node) AS n`, {}, 'PageRank people');
  await g.q(
    `CALL algo.labelPropagation({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES']}) YIELD node, communityId
     SET node.community = communityId`,
    {},
    'label propagation: working groups',
  ).catch(() => {});
  await g.q(
    `CALL algo.betweenness({nodeLabels: ['Person'], relationshipTypes: ['COLLABORATES']}) YIELD node, score
     SET node.broker = score`,
    {},
    'betweenness: brokers',
  ).catch(() => {});
  await g.q(`CALL algo.pageRank('System', 'DEPENDS_ON') YIELD node, score SET node.criticality = score`, {}, 'PageRank systems by dependency').catch(() => {});
  return { ranked: ranks[0]?.n ?? 0 };
}
