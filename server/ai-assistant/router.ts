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
  DRAFT: 'moonshotai/kimi-k2.6', // fast + reliable on our custom Pine engine — initial Pine draft + repairs
  ESCALATE: 'anthropic/claude-opus-4.8', // peak reasoning — last-resort repair when DRAFT can't compile
  CRITIC: 'qwen/qwen3.7-max', // different provenance — independent review pass
} as const;

// Some models REQUIRE provider reasoning ("thinking") and reject reasoning:{enabled:false}
// with HTTP 400 ("Reasoning is mandatory for this endpoint and cannot be disabled."). For
// these we must NOT send the disable flag, and we give them a larger output budget + a
// longer timeout so the hidden thinking can't crowd out (truncate) the actual answer.
// Verified live 2026-06-14: kimi-k2.7-code 400s on reasoning-off; with reasoning on it
// returns valid Pine but spends most of its completion tokens thinking.
export const REASONING_REQUIRED_MODELS = new Set<string>(['moonshotai/kimi-k2.7-code']);

export function modelRequiresReasoning(model: string): boolean {
  return REASONING_REQUIRED_MODELS.has(model);
}

export const LLM_LIMITS = {
  MAX_IDEA_CHARS: 4096, // hard cap on user-supplied idea / insights text
  MAX_OUTPUT_CHARS: 65536, // hard cap on model output we will accept/parse
  MAX_TOKENS: 8192, // hard per-call output budget for non-reasoning models (bounds spend)
  MAX_TOKENS_REASONING: 16384, // bigger budget for thinking models (thinking consumes output tokens)
  TIMEOUT_MS: 90_000,
  TIMEOUT_MS_REASONING: 120_000, // thinking models are slower; stays well under the job stuck-cap
} as const;

// Per-wallet operation rate limit (an "operation" = one draft/improve, which itself
// fans out to several model calls). In-memory + best-effort; resets on restart.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_OPS = 12;
const opLog = new Map<string, number[]>();

export class LlmGatewayError extends Error {
  status?: number;
  /**
   * WO-4: true when a 400 response body mentioned "temperature" — some providers
   * reject any explicit temperature value. Derived server-side from the (never
   * surfaced) raw body so callers can retry once with `omitTemperature:true`.
   */
  temperatureUnsupported?: boolean;
  constructor(message: string, status?: number, opts?: { temperatureUnsupported?: boolean }) {
    super(message);
    this.name = 'LlmGatewayError';
    this.status = status;
    if (opts?.temperatureUnsupported) this.temperatureUnsupported = true;
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
//
// WO-2: extended with optional structured-output fields. All four are omitted from the
// request body when absent, so callers that don't set them get a byte-identical request.
export async function callOpenRouterWithUsage(opts: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** OpenAI-shape function tool definitions. When present, enables tool-call response parsing. */
  tools?: unknown[];
  /** e.g. `{type:"function",function:{name:"decide"}}` — forces the model to call a specific tool. */
  toolChoice?: unknown;
  /** e.g. `{type:"json_schema", json_schema:{...}}` — structured output format. */
  responseFormat?: unknown;
  /** When true, adds `provider:{require_parameters:true}` to pin providers that honour the extras. */
  requireParameters?: boolean;
  /**
   * WO-4: when true, the `temperature` field is omitted from the request body entirely.
   * Used for the one-shot retry after a 400 whose body mentioned temperature
   * (some providers reject any explicit value; their default then applies).
   */
  omitTemperature?: boolean;
}): Promise<{ content: string; usage?: LlmUsage; toolCalls?: { name: string; arguments: string }[] }> {
  const { apiKey, model, messages } = opts;
  // Thinking models need a bigger output budget (thinking eats tokens) and longer to
  // respond; pick the per-model cap so an explicit caller value can't exceed it.
  const reasoningRequired = modelRequiresReasoning(model);
  const tokenCap = reasoningRequired ? LLM_LIMITS.MAX_TOKENS_REASONING : LLM_LIMITS.MAX_TOKENS;
  const maxTokens = Math.min(opts.maxTokens ?? tokenCap, tokenCap);
  const temperature = opts.temperature ?? 0.2;
  const timeoutMs = opts.timeoutMs ?? (reasoningRequired ? LLM_LIMITS.TIMEOUT_MS_REASONING : LLM_LIMITS.TIMEOUT_MS);

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
      // Disable provider "reasoning"/thinking for models that ALLOW it. Most modern
      // models (Kimi K2.6, Claude, Qwen, …) default reasoning ON, which spends the whole
      // max_tokens budget on hidden thinking and returns an EMPTY `content` — or never
      // finishes inside our timeout. We only want the final answer. Verified live: with
      // reasoning on, Kimi K2.6 returns no content within 90s; with it off it returns a
      // complete strategy in ~40s. EXCEPTION: models in REASONING_REQUIRED_MODELS (e.g.
      // kimi-k2.7-code) reject reasoning:{enabled:false} with HTTP 400, so we send
      // enabled:true and let them think — the larger budget + timeout above keep the
      // answer intact (these models are slow: ~minutes per call on real prompts).
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        // WO-4: omitted entirely on the temperature-quirk retry (provider default applies).
        ...(opts.omitTemperature ? {} : { temperature }),
        reasoning: { enabled: reasoningRequired },
        // WO-2: include structured-output fields only when the caller set them.
        // Absent fields are NOT serialised (undefined → omitted by JSON.stringify),
        // so draft/improve callers get a byte-identical request body.
        ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        ...(opts.toolChoice !== undefined ? { tool_choice: opts.toolChoice } : {}),
        ...(opts.responseFormat !== undefined ? { response_format: opts.responseFormat } : {}),
        ...(opts.requireParameters ? { provider: { require_parameters: true } } : {}),
      }),
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
    // Drain the body so the socket frees, but DO NOT log or surface it. WO-4: sniff a
    // 400 body for the temperature quirk (some providers reject any explicit value) and
    // expose ONLY the boolean flag — never the raw body — so callers can retry once
    // with `omitTemperature:true`.
    let temperatureUnsupported = false;
    try {
      const bodyText = await res.text();
      if (res.status === 400 && !opts.omitTemperature && /temperature/i.test(bodyText)) {
        temperatureUnsupported = true;
      }
    } catch {
      /* ignore */
    }
    throw new LlmGatewayError(mapStatusToMessage(res.status), res.status, { temperatureUnsupported });
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new LlmGatewayError('The model returned an unreadable response. Try again.');
  }

  const choice: any = data?.choices?.[0];
  const content: unknown = choice?.message?.content;

  // WO-2: when caller sent `tools`, a valid response may carry tool_calls instead of
  // (or in addition to) content. Parse the first call and return early so the empty-
  // content check below never fires on a legitimate tool-call response.
  if (opts.tools) {
    const toolCallsArr: any[] | undefined = Array.isArray(choice?.message?.tool_calls)
      ? choice.message.tool_calls
      : undefined;
    if (toolCallsArr && toolCallsArr.length > 0) {
      const first = toolCallsArr[0];
      const name: string = typeof first?.function?.name === 'string' ? first.function.name : '';
      const args: string =
        typeof first?.function?.arguments === 'string'
          ? first.function.arguments
          : JSON.stringify(first?.function?.arguments ?? {});
      const contentStr = typeof content === 'string' ? content.trim() : '';
      return {
        content: contentStr,
        toolCalls: [{ name, arguments: args }],
        usage: parseUsage(data?.usage),
      };
    }
    // Provider answered in content instead of tool_calls — fall through to normal handling.
  }

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
