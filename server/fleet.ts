import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UserGraph } from './graph.ts';
import { upsertNodes, link } from './ingest.ts';
import { publish } from './bus.ts';
import { uid, clip } from './util.ts';
import { pastRuns } from './seed/lumen.ts';
import { config } from './config.ts';

const exec = promisify(execFile);

/**
 * The agent fleet: the coding-agent subscriptions installed on the Ziv's
 * computer, as :Agent nodes. ZivBot routes work to them with a graph query
 * (past runs on the same systems, quota state, your stated preferences) and
 * runs them headlessly — the invocations are ported from Loom's adapters.
 */
export type AgentKind = 'codex' | 'claude-code' | 'cursor' | 'opencode' | 'grok' | 'antigravity';

type Spec = { kind: AgentKind; name: string; bin: string[]; plan: string; vendor: string; args: (prompt: string, dir: string) => string[] };

export const AGENT_SPECS: Spec[] = [
  {
    kind: 'codex', name: 'Codex', bin: ['codex'], plan: 'ChatGPT plan', vendor: 'OpenAI',
    args: (p, d) => ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', d, ...(process.env.ZIV_CODEX_MODEL ? ['-m', process.env.ZIV_CODEX_MODEL] : []), p],
  },
  {
    kind: 'claude-code', name: 'Claude Code', bin: ['claude'], plan: 'Claude plan', vendor: 'Anthropic',
    args: (p) => ['-p', p, '--output-format', 'text', '--permission-mode', 'acceptEdits'],
  },
  {
    kind: 'cursor', name: 'Cursor', bin: ['cursor-agent'], plan: 'Cursor plan', vendor: 'Cursor',
    args: (p) => ['-p', p, '--output-format', 'text', '--force'],
  },
  {
    kind: 'opencode', name: 'OpenCode', bin: ['opencode'], plan: 'OpenCode Zen (free models)', vendor: 'SST',
    args: (p) => ['run', p, '-m', process.env.ZIV_OPENCODE_MODEL || 'opencode/big-pickle'],
  },
  {
    kind: 'grok', name: 'Grok', bin: ['grok'], plan: 'SuperGrok', vendor: 'xAI',
    args: (p, d) => ['-p', p, '--output-format', 'json', '--cwd', d, '--permission-mode', 'auto'],
  },
  {
    kind: 'antigravity', name: 'Antigravity', bin: ['agy'], plan: 'Google AI plan', vendor: 'Google',
    args: (p, d) => ['--print', p, '--mode', 'accept-edits', '--add-dir', d],
  },
];

const QUOTA = /\b(?:usage limit|hit (?:your|the) (?:usage |rate )?limit|rate[- ]limit(?:ed)?|quota (?:exceeded|exhausted|reached)|limit reached|too many requests|out of (?:credits|quota)|insufficient (?:quota|credits|balance)|weekly limit|5-hour limit)\b/i;

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec('/bin/sh', ['-lc', `command -v ${bin}`], { timeout: 4000 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function version(path: string): Promise<string> {
  try {
    const { stdout, stderr } = await exec(path, ['--version'], { timeout: 6000 });
    return clip((stdout || stderr).trim().split('\n')[0], 40);
  } catch { return ''; }
}

let detected: { at: number; agents: { kind: AgentKind; path: string | null; version: string }[] } | null = null;

export async function detectAgents(force = false) {
  if (detected && !force && Date.now() - detected.at < 60_000) return detected.agents;
  const agents = await Promise.all(AGENT_SPECS.map(async (s) => {
    const path = await which(s.bin[0]);
    return { kind: s.kind, path, version: path ? await version(path) : '' };
  }));
  detected = { at: Date.now(), agents };
  return agents;
}

/** Mirror installed subscriptions into the graph as :Agent nodes. */
export async function syncFleet(g: UserGraph) {
  const found = await detectAgents();
  await upsertNodes(g, 'Agent', AGENT_SPECS.map((s) => {
    const d = found.find((f) => f.kind === s.kind)!;
    return { uid: `agent:${s.kind}`, props: { name: s.name, kind: s.kind, plan: s.plan, vendor: s.vendor, installed: !!d.path, version: d.version, path: d.path || '' }, search: `${s.name} ${s.vendor} ${s.plan} coding agent subscription` };
  }));
  return found;
}

/** Synthetic run history from the demo workspace, so routing has signal on day one. */
export async function seedRunHistory(g: UserGraph) {
  const now = Date.now();
  const runs = pastRuns.map((r, i) => ({ ...r, uid: `run:seed-${i}` }));
  await upsertNodes(g, 'Run', runs.map((r) => ({ uid: r.uid, props: { name: r.goal, goal: r.goal, status: r.outcome === 'success' ? 'succeeded' : 'failed', startedAt: now + r.at, endedAt: now + r.at + r.mins * 60_000, synthetic: true }, search: r.goal })));
  await link(g, 'Run', 'EXECUTED_BY', 'Agent', runs.map((r) => ({ from: r.uid, to: `agent:${r.agent}` })));
  await link(g, 'Run', 'WORKED_ON', 'System', runs.map((r) => ({ from: r.uid, to: `system:${r.system}` })));
  await link(g, 'Run', 'RESOLVES', 'Ticket', runs.filter((r) => r.ticket && r.outcome === 'success').map((r) => ({ from: r.uid, to: `ticket:${r.ticket}` })));
}

export type RouteChoice = { agent: string; kind: AgentKind; name: string; score: number; reasons: string[]; installed: boolean };

/**
 * Pick the agent for a job on `systems` with one graph query: wins and losses
 * on those systems and on their direct dependencies, overall record, quota
 * state, and Procedures where the user said which agent they prefer.
 */
/**
 * The fleet's skill graph: (Agent)-[:SKILLED_IN {wins, losses, score}]->(System),
 * derived from finished runs. score is Laplace-smoothed: (wins+1)/(runs+2).
 */
export async function refreshSkills(g: UserGraph) {
  await g.q(`MATCH (:Agent)-[s:SKILLED_IN]->() DELETE s`, {}, '~reset skill edges');
  await g.q(
    `MATCH (a:Agent)<-[:EXECUTED_BY]-(r:Run)-[:WORKED_ON]->(sys:System) WHERE r.status IN ['succeeded', 'failed']
     WITH a, sys, count(CASE WHEN r.status = 'succeeded' THEN 1 END) AS wins, count(CASE WHEN r.status = 'failed' THEN 1 END) AS losses, max(r.endedAt) AS lastAt
     MERGE (a)-[s:SKILLED_IN]->(sys)
     SET s.wins = wins, s.losses = losses, s.lastAt = lastAt, s.score = (wins + 1.0) / (wins + losses + 2.0)`,
    {},
    'derive the agent skill graph from runs',
  );
}

export async function routeJob(g: UserGraph, systems: string[]): Promise<RouteChoice[]> {
  await refreshSkills(g);
  const rows = await g.q(
    `MATCH (a:Agent)
     OPTIONAL MATCH (a)-[s:SKILLED_IN]->(x:System) WHERE x.uid IN $systems
     WITH a, sum(coalesce(s.wins, 0)) AS wins, sum(coalesce(s.losses, 0)) AS losses
     OPTIONAL MATCH (a)-[s2:SKILLED_IN]->(:System)-[:DEPENDS_ON]-(n:System) WHERE n.uid IN $systems
     WITH a, wins, losses, sum(coalesce(s2.wins, 0)) AS nearWins
     OPTIONAL MATCH (a)-[s3:SKILLED_IN]->()
     WITH a, wins, losses, nearWins, sum(coalesce(s3.wins, 0)) AS allWins, sum(coalesce(s3.wins, 0) + coalesce(s3.losses, 0)) AS allRuns
     OPTIONAL MATCH (p:Procedure)-[pref:PREFERS]->(a)
     RETURN a.uid AS agent, a.kind AS kind, a.name AS name, a.installed AS installed,
            coalesce(a.limitedUntil, 0) AS limitedUntil, wins, losses, nearWins, allWins, allRuns,
            sum(CASE WHEN pref IS NULL THEN 0 ELSE pref.weight END) AS preference`,
    { systems },
    'route job: score agents on the skill graph',
  );
  const now = Date.now();
  return rows.map((r) => {
    const reasons: string[] = [];
    let score = 0;
    if (r.wins) { score += 3 * r.wins; reasons.push(`${r.wins} successful run${r.wins > 1 ? 's' : ''} on these systems`); }
    if (r.losses) { score -= 2 * r.losses; reasons.push(`${r.losses} failed run${r.losses > 1 ? 's' : ''} here`); }
    if (r.nearWins) { score += 1.5 * r.nearWins; reasons.push(`${r.nearWins} win${r.nearWins > 1 ? 's' : ''} on neighbouring systems`); }
    if (r.allRuns) { score += r.allWins / r.allRuns; }
    if (r.preference) { score += 2 * r.preference; reasons.push(r.preference > 0 ? 'you said you prefer it' : 'you said to avoid it'); }
    // the web demo has no CLIs: still show how the graph would pick, and say where it runs
    if (!r.installed && !config.hosted) { score -= 100; reasons.push('not installed on this computer'); }
    if (config.hosted) reasons.push('runs in the desktop app');
    if (r.limitedUntil > now) { score -= 50; reasons.push(`out of quota until ${new Date(r.limitedUntil).toLocaleTimeString()}`); }
    if (!reasons.length) reasons.push('no history yet');
    return { agent: r.agent, kind: r.kind, name: r.name, score: +score.toFixed(2), reasons, installed: !!r.installed };
  }).sort((a, b) => b.score - a.score);
}

export type RunDone = { uid: string; goal: string; status: string; agent: string; kind: AgentKind; tests: string; diff: string; branch: string; dot?: string; tickets: string[]; log: string; summary: string };
export const runHooks: ((userId: string, g: UserGraph, r: RunDone) => Promise<void> | void)[] = [];

export type RunRequest = { goal: string; prompt: string; dir: string; repo?: string; systems: string[]; tickets: string[]; kind: AgentKind; dot?: string; answer?: string; parentRun?: string };

/**
 * Execute a job with a real coding-agent CLI. The run is a node from the
 * first moment; its log streams to the UI; tests + a diff are recorded at the
 * end; a quota hit marks the agent limited and hands off to the next agent.
 */
export async function dispatchRun(userId: string, g: UserGraph, req: RunRequest): Promise<string> {
  const spec = AGENT_SPECS.find((s) => s.kind === req.kind)!;
  const runUid = uid('run');
  const startedAt = Date.now();
  await upsertNodes(g, 'Run', [{ uid: runUid, props: { name: req.goal, goal: req.goal, status: 'running', startedAt, agentKind: req.kind, dir: req.dir }, search: req.goal }]);
  await link(g, 'Run', 'EXECUTED_BY', 'Agent', [{ from: runUid, to: `agent:${req.kind}` }]);
  await link(g, 'Run', 'WORKED_ON', 'System', req.systems.map((s) => ({ from: runUid, to: s })));
  if (req.repo) await link(g, 'Run', 'WORKED_ON', 'Repo', [{ from: runUid, to: req.repo }]);
  await link(g, 'Run', 'FOR_TICKET', 'Ticket', req.tickets.map((t) => ({ from: runUid, to: t })));
  if (req.dot) await link(g, 'Run', 'REQUESTED_BY', 'Dot', [{ from: runUid, to: req.dot }]);
  if (req.answer) await link(g, 'Run', 'BECAUSE', 'Answer', [{ from: runUid, to: req.answer }]);
  if (req.parentRun) await link(g, 'Run', 'HANDED_OFF_TO', 'Run', [{ from: req.parentRun, to: runUid }]);
  publish(userId, { type: 'run', run: { uid: runUid, goal: req.goal, status: 'running', agent: spec.name, kind: req.kind, startedAt } });

  void (async () => {
    let log = '';
    const push = (s: string) => {
      log = (log + s).slice(-12000);
      publish(userId, { type: 'run.log', uid: runUid, chunk: s });
    };
    const branch = `ziv/${(req.tickets[0] || runUid).split(':').pop()!.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    await exec('git', ['checkout', '-q', '-B', branch], { cwd: req.dir }).catch(() => {});
    push(`$ ${spec.bin[0]} ${spec.args('<task>', req.dir).map((a) => (a === '<task>' ? '"<task>"' : a)).join(' ')}\n`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn(spec.bin[0], spec.args(req.prompt, req.dir), { cwd: req.dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { push('\n[zivbot] timed out after 15 minutes\n'); child.kill('SIGKILL'); }, 15 * 60_000);
      child.stdout.on('data', (d) => push(humanize(req.kind, d.toString())));
      // stderr carries the CLI's own housekeeping (skill loading, malloc notices, ANSI): keep real errors only
      child.stderr.on('data', (d) => {
        const keep = d.toString().replace(/\x1b\[[0-9;]*m/g, '').split('\n')
          .filter((l: string) => l.trim() && !/failed to load skill|SKILL\.md|MallocStackLogging|^\s*\d{4}-\d\d-\d\dT[\d:.]+Z\s+(INFO|WARN|DEBUG)/.test(l));
        if (keep.length) push(keep.join('\n') + '\n');
      });
      child.on('error', (e) => { push(`\n[zivbot] ${e.message}\n`); resolve(127); });
      child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1); });
    });

    let tests = { ok: false, summary: 'not run' };
    try {
      const { stdout, stderr } = await exec('npm', ['test', '--silent'], { cwd: req.dir, timeout: 120_000 }).catch((e) => e);
      const out = `${stdout || ''}${stderr || ''}`;
      const pass = Number(out.match(/(?:#|ℹ)\s*pass (\d+)/)?.[1] || 0), fail = Number(out.match(/(?:#|ℹ)\s*fail (\d+)/)?.[1] || 0);
      tests = { ok: fail === 0 && pass > 0, summary: `${pass} passed, ${fail} failed` };
      push(`\n$ npm test\n${tests.summary}\n`);
    } catch { /* no test script */ }

    const { stdout: diff } = await exec('git', ['diff', '--stat', 'HEAD'], { cwd: req.dir }).catch(() => ({ stdout: '' }));
    const { stdout: names } = await exec('git', ['diff', '--name-only', 'HEAD'], { cwd: req.dir }).catch(() => ({ stdout: '' }));
    const changed = names.split('\n').filter(Boolean);
    if (changed.length) {
      await exec('git', ['add', '-A'], { cwd: req.dir }).catch(() => {});
      await exec('git', ['-c', 'user.name=ZivBot', '-c', 'user.email=zivbot@local', 'commit', '-q', '-m', `${req.goal}\n\nRun ${runUid} by ${spec.name} via ZivBot`], { cwd: req.dir }).catch(() => {});
    }
    const quota = code !== 0 && QUOTA.test(log);
    const status = quota ? 'quota' : code === 0 && (tests.ok || tests.summary === 'not run') ? 'succeeded' : 'failed';
    const endedAt = Date.now();
    // the agent's own two-line wrap-up ("Root cause: … / Fix: …"), if it wrote one
    const summary = (log.match(/(Root cause[\s\S]{0,600})/i)?.[1] || '').split('\n').filter((l) => l.trim() && !l.startsWith('$') && !/^\d+ passed/.test(l.trim())).slice(0, 2).join('\n');
    await g.q(
      `MATCH (r:Run {uid:$uid}) SET r.status=$status, r.endedAt=$endedAt, r.exitCode=$code, r.tests=$tests, r.diff=$diff, r.branch=$branch, r.log=$log, r.summary=$summary`,
      { uid: runUid, status, endedAt, code, tests: tests.summary, diff: diff.trim(), branch, log: log.slice(-6000), summary },
      'record run result',
    );
    if (req.repo && changed.length) await link(g, 'Run', 'CHANGED', 'File', changed.map((f) => ({ from: runUid, to: `file:${req.repo!.slice(5)}/${f}` })));
    if (status === 'succeeded') {
      await link(g, 'Run', 'RESOLVES', 'Ticket', req.tickets.map((t) => ({ from: runUid, to: t })));
      await g.q(`UNWIND $t AS k MATCH (t:Ticket {uid:k}) SET t.status = 'fix ready', t.fixBranch = $branch`, { t: req.tickets, branch }, 'mark tickets fix-ready');
    }
    publish(userId, { type: 'run', run: { uid: runUid, goal: req.goal, status, agent: spec.name, kind: req.kind, startedAt, endedAt, tests: tests.summary, diff: diff.trim(), branch } });
    if (status !== 'quota') for (const h of runHooks) await Promise.resolve(h(userId, g, { uid: runUid, goal: req.goal, status, agent: spec.name, kind: req.kind, tests: tests.summary, diff: diff.trim(), branch, dot: req.dot, tickets: req.tickets, log, summary })).catch((e) => console.error('[run hook]', e));

    if (quota) {
      await g.q(`MATCH (a:Agent {uid:$a}) SET a.limitedUntil = $until`, { a: `agent:${req.kind}`, until: Date.now() + 3_600_000 }, 'mark agent out of quota');
      const next = (await routeJob(g, req.systems)).find((c) => c.installed && c.kind !== req.kind && c.score > -50);
      if (next) {
        push(`\n[zivbot] ${spec.name} is out of quota — handing off to ${next.name}\n`);
        await dispatchRun(userId, g, { ...req, kind: next.kind, parentRun: runUid });
      }
    }
  })().catch((e) => console.error('[run]', e));
  return runUid;
}

/** Codex prints JSONL events; show the human parts. */
function humanize(kind: AgentKind, chunk: string) {
  if (kind !== 'codex') return chunk;
  return chunk.split('\n').map((line) => {
    if (!line.trim().startsWith('{')) return line;
    try {
      const e = JSON.parse(line);
      const item = e.item || e.msg || {};
      if (item.type === 'agent_message' || item.type === 'reasoning') return item.text ? `${item.text}` : '';
      if (item.type === 'command_execution') return item.command ? `$ ${item.command}` : '';
      if (item.type === 'file_change') return `~ ${(item.changes || []).map((c: any) => c.path).join(', ')}`;
      if (e.type === 'error' || e.type === 'turn.failed') return `error: ${e.message || e.error?.message || ''}`;
      return '';
    } catch { return line; }
  }).filter(Boolean).join('\n') + '\n';
}
