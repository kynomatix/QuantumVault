// Curated catalog of selectable LLMs for the AI Strategy Creator, merged with LIVE
// pricing from OpenRouter's public /models endpoint.
//
// The curated allow-list below (ids, labels, plain-language notes, and our maintained
// coding-strength rank) is the ONLY manual-upkeep surface. Per-token prices are fetched
// live so the picker stays current on its own — no hardcoded prices to go stale.
//
// Prices are best-effort: if the fetch fails we still return the list (price = null) so
// "Auto" and any override keep working. Network/pricing data never carries secrets, so
// this module needs no key.

import { CREATOR_MODELS } from "./router";

export interface SelectableModel {
  id: string;
  label: string;
  note: string;
  rank: number; // 1 = strongest coder (our maintained ordering)
  promptPerM: number | null; // USD per 1M input tokens
  completionPerM: number | null; // USD per 1M output tokens
}

export interface CreatorModelCatalog {
  auto: { label: string; note: string; stages: { label: string; model: string }[] };
  models: SelectableModel[];
}

// Hand-maintained shortlist of strong coding models (rank 1 = strongest coder). Ids here
// that OpenRouter doesn't actually serve are dropped at merge time, so listing a model
// that later disappears can never surface a 404 inside the picker.
const CURATED: Omit<SelectableModel, "promptPerM" | "completionPerM">[] = [
  { id: "anthropic/claude-opus-4.8", label: "Claude Opus 4.8", rank: 1, note: "Peak reasoning — best for intricate, multi-condition logic." },
  { id: "moonshotai/kimi-k3", label: "Kimi K3", rank: 2, note: "Top coding benchmarks (thinking model), but pricier and unproven on our custom Pine — expect multi-minute drafts." },
  { id: "moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code", rank: 3, note: "Stronger generic-coding benchmarks (thinking model), but slower and less reliable on our custom Pine — expect multi-minute drafts." },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", rank: 4, note: "Fast and reliable on our Pine engine — the default drafter inside Auto." },
  { id: "qwen/qwen3.7-max", label: "Qwen3.7 Max", rank: 5, note: "Strong coding with independent provenance." },
  { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", rank: 6, note: "Excellent value — capable on most strategies." },
  { id: "z-ai/glm-5.2", label: "GLM-5.2", rank: 7, note: "Newer GLM with stronger reasoning and clean, well-structured output." },
  { id: "z-ai/glm-5.1", label: "GLM-5.1", rank: 8, note: "Reliable, well-structured output." },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", rank: 9, note: "Cheapest and fastest — good for simple ideas." },
  { id: "minimax/minimax-m3", label: "MiniMax M3", rank: 10, note: "Very large context window." },
];

const SELECTABLE_IDS = new Set(CURATED.map((m) => m.id));

export function isSelectableModel(id: string): boolean {
  return SELECTABLE_IDS.has(id);
}

interface PriceEntry {
  promptPerM: number | null;
  completionPerM: number | null;
}

/** Per-model capability flags derived from OpenRouter's `supported_parameters` list. */
export interface ModelCapabilities {
  /** Model supports `tools` + `tool_choice` (native tool calling). */
  tools: boolean;
  /** Model supports `response_format`. */
  responseFormat: boolean;
  /** Model supports `structured_outputs` (strict JSON schema enforcement). */
  structuredOutputs: boolean;
}

const PRICE_TTL_MS = 12 * 60 * 60 * 1000; // 12h on success
const FAILURE_RETRY_MS = 5 * 60 * 1000; // retry 5 min after a failure
const FETCH_TIMEOUT_MS = 8000;

let priceCache: {
  at: number;
  prices: Map<string, PriceEntry>;
  caps: Map<string, ModelCapabilities>;
  live: boolean;
} | null = null;

// OpenRouter quotes price per single token as a decimal string (e.g. "0.000003").
// Convert to USD per 1,000,000 tokens, rounded to 2dp.
function perMillion(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 100) / 100;
}

async function loadPrices(): Promise<{
  prices: Map<string, PriceEntry>;
  caps: Map<string, ModelCapabilities>;
  live: boolean;
}> {
  const now = Date.now();
  const fresh = priceCache && now - priceCache.at < (priceCache.live ? PRICE_TTL_MS : FAILURE_RETRY_MS);
  if (priceCache && fresh) {
    return { prices: priceCache.prices, caps: priceCache.caps, live: priceCache.live };
  }

  const prices = new Map<string, PriceEntry>();
  const caps = new Map<string, ModelCapabilities>();
  let live = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
    if (res.ok) {
      const data: any = await res.json();
      const list: any[] = Array.isArray(data?.data) ? data.data : [];
      for (const m of list) {
        if (!m?.id || !SELECTABLE_IDS.has(m.id)) continue;
        prices.set(m.id, {
          promptPerM: perMillion(m?.pricing?.prompt),
          completionPerM: perMillion(m?.pricing?.completion),
        });
        // WO-1: capability map — union across all providers (OpenRouter aggregates).
        // `tools` requires BOTH `tools` AND `tool_choice` in the list.
        const params: string[] = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];
        caps.set(m.id, {
          tools: params.includes("tools") && params.includes("tool_choice"),
          responseFormat: params.includes("response_format"),
          structuredOutputs: params.includes("structured_outputs"),
        });
      }
      live = true;
    }
  } catch {
    /* fail-open: leave prices/caps empty, mark not-live so the list still renders */
  } finally {
    clearTimeout(timer);
  }

  priceCache = { at: now, prices, caps, live };
  return { prices, caps, live };
}

export async function getCreatorModelCatalog(): Promise<CreatorModelCatalog> {
  const { prices, live } = await loadPrices();
  const models: SelectableModel[] = CURATED
    // With a live list, only show models OpenRouter actually serves. On a failed fetch,
    // show the whole curated list (price = null) so the picker degrades gracefully.
    .filter((m) => (live ? prices.has(m.id) : true))
    .map((m) => {
      const p = prices.get(m.id);
      return { ...m, promptPerM: p?.promptPerM ?? null, completionPerM: p?.completionPerM ?? null };
    })
    .sort((a, b) => a.rank - b.rank);

  return {
    auto: {
      label: "Auto",
      note: "Our tailored blend: Kimi drafts, Claude escalates on hard cases, and Qwen reviews it independently.",
      stages: [
        { label: "Draft", model: CREATOR_MODELS.DRAFT },
        { label: "Escalate", model: CREATOR_MODELS.ESCALATE },
        { label: "Review", model: CREATOR_MODELS.CRITIC },
      ],
    },
    models,
  };
}

// --- Capability lookup (WO-1) ---------------------------------------------------

/**
 * Return the capability flags for `modelId`, piggybacking on the same 12h
 * price-cache fetch so we never add a second network call. Fail-soft: when
 * the fetch failed or the model is unknown, returns all-false + `live:false`
 * so callers always fall back to the prose path — never throws, never blocks a turn.
 */
export async function getModelCapabilities(
  modelId: string,
): Promise<ModelCapabilities & { live: boolean }> {
  try {
    const { caps, live } = await loadPrices();
    const c = caps.get(modelId);
    if (!c) return { tools: false, responseFormat: false, structuredOutputs: false, live };
    return { ...c, live };
  } catch {
    return { tools: false, responseFormat: false, structuredOutputs: false, live: false };
  }
}

// --- Spend accounting helpers (used by the Lab Assistant chat brain) ----------

// Look up live per-million prices for one model from the same cached loader the
// catalog uses. Returns nulls when pricing is unavailable (fail-soft).
export async function getModelPrice(modelId: string): Promise<PriceEntry> {
  const { prices } = await loadPrices();
  return prices.get(modelId) ?? { promptPerM: null, completionPerM: null };
}

// Estimate the USD cost of one call from its token usage. Returns null when we
// don't have live pricing for the model — callers then record "unknown" (nothing)
// rather than guess at the user's spend.
export async function estimateCallCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): Promise<number | null> {
  const { promptPerM, completionPerM } = await getModelPrice(modelId);
  if (promptPerM == null || completionPerM == null) return null;
  const cost = (promptTokens / 1e6) * promptPerM + (completionTokens / 1e6) * completionPerM;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
