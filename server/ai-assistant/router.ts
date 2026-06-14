// Minimal server-side OpenRouter gateway for the QuantumLab AI Strategy Creator
// (Task 187). This is the shared LLM plumbing intended to be reused by a future v2
// chat assistant, so it lives under server/ai-assistant/ rather than under the lab.
//
// SECURITY: every caller passes the USER's own decrypted OpenRouter key per request.
// This module NEVER logs the key, the request headers, or raw provider error bodies
// (OpenRouter error payloads can echo parts of the request). All failures surface a
// sanitized, status-mapped message via LlmGatewayError.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SITE_URL = 'https://myquantumvault.com';
const SITE_NAME = 'QuantumVault';

export const CREATOR_MODELS = {
  // Verified live on OpenRouter (June 2026). If a call 404s, check openrouter.ai/models.
  DRAFT: 'moonshotai/kimi-k2.6', // strong, fast coding model — initial Pine draft + repairs
  ESCALATE: 'anthropic/claude-opus-4.8', // peak reasoning — last-resort repair when DRAFT can't compile
  CRITIC: 'qwen/qwen3.7-max', // different provenance — independent review pass
} as const;

export const LLM_LIMITS = {
  MAX_IDEA_CHARS: 4096, // hard cap on user-supplied idea / insights text
  MAX_OUTPUT_CHARS: 65536, // hard cap on model output we will accept/parse
  MAX_TOKENS: 8192, // hard per-call output budget (bounds the user's spend)
  TIMEOUT_MS: 90_000,
} as const;

// Per-wallet operation rate limit (an "operation" = one draft/improve, which itself
// fans out to several model calls). In-memory + best-effort; resets on restart.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_OPS = 12;
const opLog = new Map<string, number[]>();

export class LlmGatewayError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmGatewayError';
    this.status = status;
  }
}

export function checkRateLimit(walletAddress: string): void {
  const now = Date.now();
  const hits = (opLog.get(walletAddress) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_OPS) {
    throw new LlmGatewayError('Too many AI requests — please wait a minute and try again.', 429);
  }
  hits.push(now);
  opLog.set(walletAddress, hits);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (opLog.size > 5000) {
    opLog.forEach((v: number[], k: string) => {
      const live = v.filter((t) => now - t < RATE_WINDOW_MS);
      if (live.length === 0) opLog.delete(k);
      else opLog.set(k, live);
    });
  }
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function mapStatusToMessage(status: number): string {
  switch (status) {
    case 401:
      return 'Your OpenRouter key was rejected (401). Check the key and re-save it.';
    case 402:
      return 'Your OpenRouter account is out of credits (402). Add credits and try again.';
    case 403:
      return 'Your OpenRouter key is not allowed to use this model (403).';
    case 404:
      return 'The selected model is unavailable (404). It may have been renamed.';
    case 408:
      return 'The model timed out (408). Try again.';
    case 429:
      return 'OpenRouter rate-limited your key (429). Wait a moment and retry.';
    default:
      if (status >= 500) return 'The model provider had an error. Try again shortly.';
      return `The model request failed (HTTP ${status}).`;
  }
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// OpenRouter echoes token counts in `data.usage`. Parse defensively; absent or
// malformed usage returns undefined so callers can record "unknown spend"
// (nothing) rather than guess at the user's bill.
function parseUsage(u: any): LlmUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const totalTokens = num(u.total_tokens) || promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

// Core gateway call: returns the final answer AND token usage (for spend tracking).
// `callOpenRouter` below is the back-compat wrapper that returns just the string,
// so existing draft/improve callers are untouched.
export async function callOpenRouterWithUsage(opts: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<{ content: string; usage?: LlmUsage }> {
  const { apiKey, model, messages } = opts;
  const maxTokens = Math.min(opts.maxTokens ?? LLM_LIMITS.MAX_TOKENS, LLM_LIMITS.MAX_TOKENS);
  const temperature = opts.temperature ?? 0.2;
  const timeoutMs = opts.timeoutMs ?? LLM_LIMITS.TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: any;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': SITE_URL,
        'X-Title': SITE_NAME,
      },
      // Disable provider "reasoning"/thinking. Modern models (Kimi K2.6, Claude,
      // Qwen, …) default reasoning ON, which spends the whole max_tokens budget on
      // hidden thinking and returns an EMPTY `content` — or never finishes the body
      // inside our timeout. We only want the final answer. Verified live: with
      // reasoning on, Kimi K2.6 returns no content within 90s; with it off it
      // returns a complete strategy in ~40s. Non-reasoning models ignore this no-op.
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, reasoning: { enabled: false } }),
      signal: controller.signal,
    });
  } catch (err: any) {
    // NB: never surface `err` — it can include the request (and thus the key).
    if (err?.name === 'AbortError') {
      throw new LlmGatewayError('The model took too long to respond. Try again.', 408);
    }
    throw new LlmGatewayError('Could not reach the model provider. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Drain the body so the socket frees, but DO NOT log or surface it.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw new LlmGatewayError(mapStatusToMessage(res.status), res.status);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new LlmGatewayError('The model returned an unreadable response. Try again.');
  }

  const choice: any = data?.choices?.[0];
  const content: unknown = choice?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    // finish_reason "length" => the model ran out of output budget before answering.
    if (choice?.finish_reason === 'length') {
      throw new LlmGatewayError('The model hit its output limit before returning a strategy. Try a simpler idea or pick a different model.', 502);
    }
    throw new LlmGatewayError('The model returned an empty response. Try again.');
  }
  const trimmed = content.length > LLM_LIMITS.MAX_OUTPUT_CHARS
    ? content.slice(0, LLM_LIMITS.MAX_OUTPUT_CHARS)
    : content;
  return { content: trimmed, usage: parseUsage(data?.usage) };
}

// Back-compat wrapper: returns just the answer text (draft/improve callers).
export async function callOpenRouter(opts: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  const { content } = await callOpenRouterWithUsage(opts);
  return content;
}
