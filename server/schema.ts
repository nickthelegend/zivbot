import type { UserGraph } from './graph.ts';

/**
 * ZivBot graph model (one graph per user — see README "Graph data model").
 *
 * Connected data      Person Team Org Project System Repo File Ticket Email Thread
 *                     Event Doc ChatMessage Channel Decision
 * Agent fleet         Agent (a subscription / CLI) Run Tool Connector
 * Agent memory        Ziv Conversation Episode Fact Procedure Answer Notice Draft
 *
 * Every entity also carries the :Searchable label with a `search` text field,
 * so one full-text index covers names, subjects and bodies across labels.
 */
export const LABELS = [
  'Person', 'Team', 'Org', 'Project', 'System', 'Repo', 'File', 'Ticket', 'Email', 'Thread', 'Event', 'Doc',
  'ChatMessage', 'Channel', 'Decision', 'Agent', 'Run', 'Tool', 'Connector', 'Dot', 'Conversation', 'Episode',
  'Fact', 'Procedure', 'Answer', 'Notice', 'Draft', 'Profile', 'Commit', 'Rule',
] as const;
export type Label = (typeof LABELS)[number];

const ensured = new Set<string>();

export async function ensureSchema(g: UserGraph) {
  if (ensured.has(g.name)) return;
  for (const l of LABELS) {
    await g.q(`CREATE INDEX FOR (n:${l}) ON (n.uid)`).catch(ignoreExists);
  }
  await g.q(`CREATE INDEX FOR (n:Email) ON (n.at)`).catch(ignoreExists);
  await g.q(`CREATE INDEX FOR (n:Episode) ON (n.at)`).catch(ignoreExists);
  await g.q(`CREATE INDEX FOR (n:Person) ON (n.email)`).catch(ignoreExists);
  await g.q(`CALL db.idx.fulltext.createNodeIndex('Searchable', 'search')`).catch(ignoreExists);
  ensured.add(g.name);
}

function ignoreExists(e: Error) {
  if (!/already (indexed|exists)|exists/i.test(e.message)) throw e;
}

/** Colour + display hints the UI uses for each label. */
export const LABEL_META: Record<string, { color: string; icon: string }> = {
  Person: { color: '#f59e0b', icon: 'user' },
  Team: { color: '#eab308', icon: 'users' },
  Org: { color: '#fb7185', icon: 'building' },
  Project: { color: '#a78bfa', icon: 'folder' },
  System: { color: '#22d3ee', icon: 'server' },
  Repo: { color: '#38bdf8', icon: 'git' },
  File: { color: '#7dd3fc', icon: 'file' },
  Ticket: { color: '#f87171', icon: 'ticket' },
  Email: { color: '#60a5fa', icon: 'mail' },
  Thread: { color: '#93c5fd', icon: 'mail' },
  Event: { color: '#34d399', icon: 'calendar' },
  Doc: { color: '#c084fc', icon: 'doc' },
  ChatMessage: { color: '#4ade80', icon: 'chat' },
  Channel: { color: '#86efac', icon: 'hash' },
  Decision: { color: '#fbbf24', icon: 'gavel' },
  Agent: { color: '#ff7a1a', icon: 'bot' },
  Run: { color: '#fdba74', icon: 'play' },
  Tool: { color: '#a3a3a3', icon: 'tool' },
  Connector: { color: '#d4d4d4', icon: 'plug' },
  Dot: { color: '#ff7a1a', icon: 'dot' },
  Episode: { color: '#94a3b8', icon: 'chat' },
  Fact: { color: '#e879f9', icon: 'brain' },
  Procedure: { color: '#f0abfc', icon: 'list' },
  Answer: { color: '#cbd5e1', icon: 'spark' },
  Draft: { color: '#5eead4', icon: 'edit' },
  Rule: { color: '#fb923c', icon: 'eye' },
};
