import { config } from './config.ts';

/** Minimal OpenAI-compatible chat-completions client with tool calling. */
export type ChatMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

// A daily budget for the model: the planner answers what it can, the model only the rest, and the
// free tier is shared — so count calls per UTC day and stop cleanly when it runs out.
const budget = { day: '', used: 0, exhausted: false };
const today = () => new Date().toISOString().slice(0, 10);
export function llmBudgetLeft() {
  if (budget.day !== today()) Object.assign(budget, { day: today(), used: 0, exhausted: false });
  return budget.exhausted ? 0 : Math.max(0, config.llm.daily - budget.used);
}

export async function chat(messages: ChatMsg[], tools?: { name: string; description: string; params: unknown }[], timeoutMs = 45_000) {
  if (llmBudgetLeft() <= 0) throw new Error('LLM daily budget used up');
  budget.used++;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llm.apiKey}`,
        'x-title': 'ZivBot',
        'http-referer': 'https://github.com/nickthelegend/zivbot',
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        temperature: 0.2,
        ...(tools?.length ? { tools: tools.map((x) => ({ type: 'function', function: { name: x.name, description: x.description, parameters: x.params } })), tool_choice: 'auto' } : {}),
      }),
    });
    if (r.status === 429 || r.status === 402) budget.exhausted = true;
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    const m = j.choices?.[0]?.message;
    if (!m) throw new Error('LLM returned no message');
    return m as { content: string | null; tool_calls?: ToolCall[] };
  } finally {
    clearTimeout(t);
  }
}
