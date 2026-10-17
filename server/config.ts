import { readFileSync, existsSync } from 'node:fs';

// Tiny .env loader so `npm run dev` works without extra deps.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 8787),
  /** Public web deploy: no local paths, no spawned processes, CORS for the web origin. */
  hosted: env.ZIV_HOSTED === '1',
  corsOrigins: (env.ZIV_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  falkorUrl: env.FALKORDB_URL || `redis://${env.FALKORDB_HOST || 'localhost'}:${env.FALKORDB_PORT || 6379}`,
  falkorUsername: env.FALKORDB_USERNAME || undefined,
  falkorPassword: env.FALKORDB_PASSWORD || undefined,
  llm: {
    baseUrl: (env.ZIV_LLM_BASE_URL || (env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : '')).replace(/\/$/, ''),
    apiKey: env.ZIV_LLM_API_KEY || env.OPENROUTER_API_KEY || '',
    // OpenRouter's free tier works out of the box with a free tool-calling model
    model: env.ZIV_LLM_MODEL || (env.ZIV_LLM_API_KEY ? 'openai/gpt-4o-mini' : 'nvidia/nemotron-3-super-120b-a12b:free'),
    // "off" forces the built-in graph planner even when a key is present.
    mode: (env.ZIV_LLM || 'auto') as 'auto' | 'off',
  },
  proactiveMs: env.ZIV_PROACTIVE_MS === undefined ? 10 * 60_000 : Number(env.ZIV_PROACTIVE_MS),
};

export const llmEnabled = () => config.llm.mode !== 'off' && !!config.llm.apiKey && !!config.llm.baseUrl;
