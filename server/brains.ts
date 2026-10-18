/**
 * Which model answers a chat — picked per conversation, like the model menu in Claude or ChatGPT.
 *
 *  - auto     the graph planner answers what it recognises; a model takes the rest (hybrid)
 *  - planner  graph planner only: instant, free, deterministic
 *  - or:<id>  an OpenRouter model, calling ZivBot's graph tools itself
 *  - codex / claude:<model>  your own subscription, through the CLI on this computer
 *
 * A subscription CLI gets ZivBot's tools over MCP (/mcp?user=…&turn=…). The `turn` ties every
 * tool call back to this chat turn: its Cypher lands in the answer's trace (Show path), its cards
 * (drafts, graphs) land under the reply, and the UI sees each tool as it runs.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config, llmEnabled } from './config.ts';
import { detectAgents } from './fleet.ts';
import type { Trace } from './graph.ts';
import type { Card } from './tools.ts';

export type Brain = { id: string; label: string; sub: string; group: 'ZivBot' | 'Your subscriptions' | 'OpenRouter'; available: boolean; reason?: string };

// ------------------------------------------------------------------ turns reachable over MCP

export type TurnSink = { userId: string; conv: string; dot: string; trace: Trace; cards: Card[]; tools: string[] };
const turns = new Map<string, TurnSink>();
export const turnSink = (id: string | undefined, userId: string) => {
  const t = id ? turns.get(id) : undefined;
  return t && t.userId === userId ? t : undefined;
};

let localBase = () => `http://127.0.0.1:${config.port}`;
export const setLocalBase = (f: () => string) => { localBase = f; };

// ------------------------------------------------------------------ the menu

const CODEX_MODEL = () => process.env.ZIV_CODEX_MODEL || 'gpt-5.6-terra';
let orCache: { at: number; ids: string[] } | null = null;

/** Free OpenRouter models that can call tools, from OpenRouter's own list (cached for an hour). */
async function openRouterModels(): Promise<string[]> {
  if (orCache && Date.now() - orCache.at < 3_600_000) return orCache.ids;
  let ids: string[] = [];
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8000) });
    const all = ((await r.json()) as any).data as any[];
    const ok = all.filter((m) => String(m.id).endsWith(':free') && (m.supported_parameters || []).includes('tools'));
    const rank = (id: string) => { const i = ['gpt-oss', 'qwen', 'deepseek', 'llama', 'gemini', 'glm', 'kimi', 'mistral', 'nemotron'].findIndex((f) => id.includes(f)); return i < 0 ? 99 : i; };
    ids = ok.map((m) => String(m.id)).sort((a, b) => rank(a) - rank(b));
  } catch { /* offline: just the configured model */ }
  const mine = config.llm.model;
  ids = [mine, ...ids.filter((x) => x !== mine)].filter(Boolean).slice(0, 7);
  orCache = { at: Date.now(), ids };
  return ids;
}

const pretty = (id: string) => id.replace(/:free$/, '').split('/').pop()!.replace(/-/g, ' ');

export async function listBrains(): Promise<Brain[]> {
  const llm = llmEnabled();
  const out: Brain[] = [
    { id: 'auto', label: 'Auto', sub: llm ? `Graph planner first, ${pretty(config.llm.model)} for the rest` : 'Graph planner (no model key set)', group: 'ZivBot', available: true },
    { id: 'planner', label: 'Graph only', sub: 'Instant, free — Cypher over your graph, no model', group: 'ZivBot', available: true },
  ];
  const agents = config.hosted ? [] : await detectAgents();
  const has = (k: string) => !!agents.find((a) => a.kind === k)?.path;
  const why = config.hosted ? 'Runs in the desktop app, on your computer' : undefined;
  out.push(
    { id: 'codex', label: 'Codex', sub: `${CODEX_MODEL()} · your ChatGPT plan`, group: 'Your subscriptions', available: has('codex'), reason: why || (has('codex') ? undefined : 'Install the Codex CLI and sign in') },
    { id: 'claude:sonnet', label: 'Claude Sonnet', sub: 'Your Claude plan, via Claude Code', group: 'Your subscriptions', available: has('claude-code'), reason: why || (has('claude-code') ? undefined : 'Install Claude Code and sign in') },
    { id: 'claude:opus', label: 'Claude Opus', sub: 'Your Claude plan, via Claude Code', group: 'Your subscriptions', available: has('claude-code'), reason: why || (has('claude-code') ? undefined : 'Install Claude Code and sign in') },
  );
  if (llm) for (const id of await openRouterModels()) out.push({ id: `or:${id}`, label: pretty(id), sub: `${id.endsWith(':free') ? 'free · ' : ''}OpenRouter`, group: 'OpenRouter', available: true });
  return out;
}

// ------------------------------------------------------------------ a turn through a subscription CLI

function run(bin: string, args: string[], input: string, cwd: string, ms: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGTERM'); err += `\n(timed out after ${ms / 1000}s)`; }, ms);
    p.on('error', (e) => { err += e.message; });
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out, err }); });
    p.stdin.end(input);
  });
}

/**
 * One answer from Codex or Claude on your own subscription. They see the same system prompt
 * as any ZivBot model and only ZivBot's graph tools; the Cypher they cause is traced here.
 */
export async function cliTurn(brain: string, sink: Omit<TurnSink, 'cards' | 'tools'>, prompt: string): Promise<{ text: string; cards: Card[]; tools: string[]; mode: string }> {
  const id = randomBytes(12).toString('hex');
  const full: TurnSink = { ...sink, cards: [], tools: [] };
  turns.set(id, full);
  const url = `${localBase()}/mcp?user=${sink.userId}&turn=${id}`;
  const dir = mkdtempSync(join(tmpdir(), 'ziv-brain-'));
  try {
    if (brain === 'codex') {
      const outFile = join(dir, 'answer.md');
      const r = await run('codex', [
        'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dir, '-m', CODEX_MODEL(),
        '-c', `mcp_servers.zivbot.url="${url}"`,
        '-c', 'mcp_servers.zivbot.default_tools_approval_mode="approve"',
        '--output-last-message', outFile, '-',
      ], prompt, dir, 180_000);
      let text = '';
      try { text = readFileSync(outFile, 'utf8').trim(); } catch { /* no answer */ }
      if (!text) throw new Error(lastLine(r.err) || `codex exited ${r.code}`);
      return { text, cards: full.cards, tools: full.tools, mode: `codex:${CODEX_MODEL()}` };
    }
    if (brain.startsWith('claude:')) {
      const model = brain.slice(7);
      const r = await run('claude', [
        '-p', '--output-format', 'json', '--model', model,
        '--mcp-config', JSON.stringify({ mcpServers: { zivbot: { type: 'http', url } } }), '--strict-mcp-config',
        '--allowedTools', 'mcp__zivbot',
        '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit',
      ], prompt, dir, 180_000);
      let j: any = null;
      try { j = JSON.parse(r.out); } catch { /* not json */ }
      const text = String(j?.result || '').trim();
      if (!text || j?.is_error) throw new Error(text || lastLine(r.err) || lastLine(r.out) || `claude exited ${r.code}`);
      return { text, cards: full.cards, tools: full.tools, mode: `claude:${model}` };
    }
    throw new Error(`unknown model ${brain}`);
  } finally {
    turns.delete(id);
    rmSync(dir, { recursive: true, force: true });
  }
}

const lastLine = (s: string) => s.trim().split('\n').filter((l) => l.trim() && !/^\s*at /.test(l)).pop()?.slice(0, 200) || '';
