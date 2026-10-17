import type { UserGraph } from './graph.ts';

/**
 * FalkorDB's graph algorithms as agent tools. Everything is allow-listed:
 * the algorithm, labels and relationship types are checked against the live
 * schema before they're interpolated into a procedure call, and every result
 * comes back as rows of nodes with a score (or a group), plus the Cypher run.
 */

export type AlgoName = 'pagerank' | 'betweenness' | 'harmonic' | 'communities' | 'components' | 'reach' | 'shortest_path';

export const ALGORITHMS: Record<AlgoName, { title: string; what: string; defaults: { label?: string; rel?: string }; needs?: ('source' | 'target')[] }> = {
  pagerank: { title: 'PageRank', what: 'Who or what matters most, by how the rest of the graph points at it', defaults: { label: 'Person', rel: 'COLLABORATES' } },
  betweenness: { title: 'Betweenness', what: 'Brokers and bottlenecks: the nodes most shortest paths run through', defaults: { label: 'System', rel: 'DEPENDS_ON' } },
  harmonic: { title: 'Harmonic centrality', what: 'How close each node is to everything else', defaults: { label: 'Person', rel: 'COLLABORATES' } },
  communities: { title: 'Communities (label propagation)', what: 'The groups that actually form (over strong ties)', defaults: { label: 'Person', rel: 'CLOSE_TO' } },
  components: { title: 'Connected components (WCC)', what: 'Islands: parts of the graph nothing connects to', defaults: { label: 'System', rel: 'DEPENDS_ON' } },
  reach: { title: 'Reachability (BFS)', what: 'Everything reachable from one node within N hops', defaults: { rel: 'DEPENDS_ON' }, needs: ['source'] },
  shortest_path: { title: 'Weighted shortest paths', what: 'Cheapest routes between two nodes (algo.SPpaths)', defaults: { rel: 'COLLABORATES' }, needs: ['source', 'target'] },
};

export type AlgoArgs = { algorithm: AlgoName; label?: string; rel?: string; source?: string; target?: string; depth?: number; limit?: number; direction?: 'out' | 'in' };
export type AlgoRow = { uid: string; name: string; label: string; score?: number; group?: number };
export type AlgoResult = { algorithm: AlgoName; title: string; what: string; label?: string; rel?: string; rows: AlgoRow[]; paths?: { uids: string[]; names: string[]; weight: number }[]; edges?: { source: string; target: string; type: string }[]; summary: string };

async function schema(g: UserGraph) {
  const labels = (await g.q(`CALL db.labels() YIELD label RETURN label`, {}, '~labels')).map((r) => r.label as string);
  const rels = (await g.q(`CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType`, {}, '~relationship types')).map((r) => r.relationshipType as string);
  return { labels, rels };
}

const ident = (s: string, allowed: string[], what: string) => {
  if (!allowed.includes(s)) throw new Error(`Unknown ${what} "${s}". Try one of: ${allowed.filter((x) => !['Searchable', 'Memorable'].includes(x)).slice(0, 20).join(', ')}`);
  return s;
};

const nodeOut = `node.uid AS uid, node.name AS name, [l IN labels(node) WHERE NOT l IN ['Searchable','Memorable']][0] AS label`;

export async function runAlgorithm(g: UserGraph, a: AlgoArgs): Promise<AlgoResult> {
  const meta = ALGORITHMS[a.algorithm];
  if (!meta) throw new Error(`Unknown algorithm ${a.algorithm}. Use: ${Object.keys(ALGORITHMS).join(', ')}`);
  const sc = await schema(g);
  const label = a.label || meta.defaults.label;
  const rel = a.rel || meta.defaults.rel;
  const L = label ? ident(label, sc.labels, 'label') : undefined;
  const R = rel ? ident(rel, sc.rels, 'relationship') : undefined;
  const limit = Math.min(a.limit ?? 12, 50);
  const base = { algorithm: a.algorithm, title: meta.title, what: meta.what, label: L, rel: R };

  const ranked = async (cypher: string, labelText: string) => {
    const rows = await g.q(cypher, { limit }, labelText);
    return rows.filter((r) => r.uid);
  };

  switch (a.algorithm) {
    case 'pagerank': {
      const rows = await ranked(`CALL algo.pageRank('${L}', '${R}') YIELD node, score RETURN ${nodeOut}, score ORDER BY score DESC LIMIT $limit`, `PageRank over ${L}/${R}`);
      return { ...base, rows, summary: rows.slice(0, 3).map((r) => r.name).join(', ') + ' rank highest.' };
    }
    case 'betweenness': {
      const rows = await ranked(`CALL algo.betweenness({nodeLabels: ['${L}'], relationshipTypes: ['${R}']}) YIELD node, score RETURN ${nodeOut}, score ORDER BY score DESC LIMIT $limit`, `betweenness over ${L}/${R}`);
      return { ...base, rows, summary: `${rows[0]?.name ?? 'Nothing'} sits on the most shortest paths.` };
    }
    case 'harmonic': {
      const rows = await ranked(`CALL algo.HarmonicCentrality({nodeLabels: ['${L}'], relationshipTypes: ['${R}']}) YIELD node, score RETURN ${nodeOut}, score ORDER BY score DESC LIMIT $limit`, `harmonic centrality over ${L}/${R}`);
      return { ...base, rows, summary: `${rows[0]?.name ?? 'Nothing'} is closest to everything else.` };
    }
    case 'communities': {
      const rows = await g.q(`CALL algo.labelPropagation({nodeLabels: ['${L}'], relationshipTypes: ['${R}']}) YIELD node, communityId RETURN ${nodeOut}, communityId AS grp ORDER BY grp`, {}, `label propagation over ${L}/${R}`);
      const groups = new Map<number, number>();
      rows.forEach((r) => groups.set(r.grp, (groups.get(r.grp) || 0) + 1));
      const big = [...groups.entries()].filter(([, n]) => n > 1).length;
      return { ...base, rows: rows.map((r) => ({ uid: r.uid, name: r.name, label: r.label, group: r.grp })), summary: `${big} group${big === 1 ? '' : 's'} with more than one member; ${groups.size - big} loner${groups.size - big === 1 ? '' : 's'}.` };
    }
    case 'components': {
      const rows = await g.q(`CALL algo.WCC({nodeLabels: ['${L}'], relationshipTypes: ['${R}']}) YIELD node, componentId RETURN ${nodeOut}, componentId AS grp ORDER BY grp`, {}, `connected components over ${L}/${R}`);
      const sizes = new Map<number, number>();
      rows.forEach((r) => sizes.set(r.grp, (sizes.get(r.grp) || 0) + 1));
      const islands = rows.filter((r) => sizes.get(r.grp) === 1);
      return { ...base, rows: rows.map((r) => ({ uid: r.uid, name: r.name, label: r.label, group: r.grp })), summary: `${sizes.size} component${sizes.size === 1 ? '' : 's'}${islands.length ? `; isolated: ${islands.slice(0, 5).map((r) => r.name).join(', ')}` : ''}.` };
    }
    case 'reach': {
      if (!a.source) throw new Error('reach needs a source node');
      const depth = Math.min(Math.max(a.depth ?? 3, 1), 6);
      // BFS follows edges out of the source; "in" walks them backwards (who depends on me)
      const rows = a.direction === 'in'
        ? await g.q(`MATCH p = (n)-[:${R}*1..${depth}]->(s {uid: $src}) WITH n AS node, min(length(p)) AS hops RETURN ${nodeOut}, hops AS score ORDER BY score LIMIT 60`, { src: a.source }, `who reaches ${a.source} over ${R} (≤${depth} hops)`)
        : await g.q(`MATCH (s {uid: $src}) CALL algo.BFS(s, ${depth}, '${R}') YIELD nodes UNWIND nodes AS node RETURN ${nodeOut}`, { src: a.source }, `BFS from ${a.source} over ${R} (≤${depth} hops)`);
      return { ...base, rows, summary: `${rows.length} node${rows.length === 1 ? '' : 's'} within ${depth} hop${depth > 1 ? 's' : ''} ${a.direction === 'in' ? 'reach it' : 'of it'}.` };
    }
    case 'shortest_path': {
      if (!a.source || !a.target) throw new Error('shortest_path needs a source and a target');
      // COLLABORATES carries a strength (weight); invert it so strong ties are cheap to travel
      // (and my own ties live on IN_TOUCH, so a route can start or end at me)
      if (R === 'COLLABORATES') await g.q(`MATCH ()-[c:COLLABORATES|IN_TOUCH]->() SET c.cost = 1.0 / (1.0 + coalesce(c.weight, 0))`, {}, '~edge costs from collaboration strength');
      const weightProp = R === 'COLLABORATES' ? 'cost' : 'w';
      const relTypes = R === 'COLLABORATES' ? `'COLLABORATES', 'IN_TOUCH'` : `'${R}'`;
      const rows = await g.q(
        `MATCH (s {uid: $src}), (t {uid: $dst})
         CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: [${relTypes}], weightProp: '${weightProp}', maxLen: 6, pathCount: 3}) YIELD path, pathWeight
         RETURN [n IN nodes(path) | n.uid] AS uids, [n IN nodes(path) | n.name] AS names, pathWeight AS weight`,
        { src: a.source, dst: a.target },
        `weighted shortest paths over ${R}`,
      );
      const paths = rows.map((r) => ({ uids: r.uids, names: r.names, weight: +Number(r.weight).toFixed(3) })).sort((x, y) => x.weight - y.weight);
      const uids = [...new Set(paths.flatMap((p) => p.uids))];
      const nodes = uids.length ? await g.q(`UNWIND $u AS x MATCH (node {uid: x}) RETURN ${nodeOut}`, { u: uids }, '~path nodes') : [];
      return { ...base, rows: nodes, paths, summary: paths.length ? `Best route: ${paths[0].names.join(' → ')}` : 'No route within 6 hops.' };
    }
  }
}

/** The live graph model: label → relationship → label, with counts. */
export async function graphSchema(g: UserGraph) {
  const triples = await g.q(
    `MATCH (a)-[r]->(b)
     WITH [l IN labels(a) WHERE NOT l IN ['Searchable','Memorable']][0] AS from, type(r) AS rel, [l IN labels(b) WHERE NOT l IN ['Searchable','Memorable']][0] AS to
     RETURN from, rel, to, count(*) AS n ORDER BY n DESC`,
    {},
    'schema: (label)-[rel]->(label) with counts',
  );
  const labels = await g.q(`MATCH (n) WITH [l IN labels(n) WHERE NOT l IN ['Searchable','Memorable']][0] AS label RETURN label, count(*) AS n ORDER BY n DESC`, {}, 'schema: nodes per label');
  const indexes = await g.q(`CALL db.indexes() YIELD label, properties, types RETURN label, properties, types`, {}, 'schema: indexes').catch(() => []);
  return { triples, labels, indexes };
}
