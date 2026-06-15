// QuantumLab Sandbox Agent — Phase B deterministic chat replies.
//
// Phase B is the conversational SHELL (docs/LAB_AGENT_SANDBOX_PLAN.md §14): the
// chat persists, renders, and offers option bubbles, but it does NOT call an LLM
// or the toolkit yet (that is Phase C/D). So every assistant reply here is a
// pure, deterministic function of the user's text — no network, no key, no
// hallucination surface. It acknowledges intent honestly and routes the user to
// the QuantumLab tab where they can do the thing by hand today, while naming the
// capability the agent will perform directly in a later phase.
//
// Kept in its own module (no Express, no DB, no LLM) so it is unit-testable in
// isolation and cannot accidentally reach a key or the toolkit.

import type { AgentSuggestedAction } from "@shared/schema";

export interface ComposedReply {
  content: string;
  suggestedActions: AgentSuggestedAction[];
}

/** Optional result context the orchestrator passes after a turn so the reply can
 *  offer result-aware NEXT-STEP chips. All fields nullable — chips appear only for
 *  whatever is present (a current strategy, a finished run, or both). */
export interface NextStepContext {
  strategyId?: number | null;
  lastRunId?: number | null;
}

// Tabs the chips can deep-link to — mirror client/src/pages/QuantumLab.tsx
// `MainTab` ("hub" | "main" | "results" | "heatmap" | "insights" | "creator").
// "main" is the Backtest Setup tab.
const NAV = {
  draft: { id: "nav-creator", label: "Open the Creator", kind: "navigate", tab: "creator" },
  backtest: { id: "nav-backtest", label: "Open Backtest Setup", kind: "navigate", tab: "main" },
  results: { id: "nav-results", label: "See my results", kind: "navigate", tab: "results" },
  heatmap: { id: "nav-heatmap", label: "Open the heatmap", kind: "navigate", tab: "heatmap" },
  insights: { id: "nav-insights", label: "Open insights", kind: "navigate", tab: "insights" },
  // Lands on the Creator, where the secure "Add API key" popover lives. The key
  // is entered there (encrypted store) — deliberately NOT a chat text field.
  addKey: { id: "nav-add-key", label: "Add your API key", kind: "navigate", tab: "creator" },
} as const satisfies Record<string, AgentSuggestedAction>;

const ASK = {
  whyLosing: { id: "ask-why-losing", label: "Why is my strategy losing?", kind: "send", message: "Why is my strategy losing money?" },
  bestResult: { id: "ask-best", label: "What's my best result?", kind: "send", message: "What's my best result?" },
  ideas: { id: "ask-ideas", label: "Suggest a strategy idea", kind: "send", message: "Suggest a strategy idea" },
  help: { id: "ask-help", label: "What can you do?", kind: "send", message: "What can you do?" },
} as const satisfies Record<string, AgentSuggestedAction>;

/** The default chip set shown on the greeting and when no intent is matched. */
export const STARTER_ACTIONS: AgentSuggestedAction[] = [
  NAV.draft,
  NAV.backtest,
  NAV.results,
  ASK.whyLosing,
];

/** Degrade reply for the "key saved but this session can't unlock it" case: the wallet
 *  HAS an OpenRouter key, but the in-memory session UMK is gone (the session went idle and
 *  was reconnected — a wallet reconnect re-binds the session but does NOT reload the UMK;
 *  only a fresh re-sign does). Without the UMK the chat can't decrypt the key, so the LLM
 *  turn can't run. Rather than fall back to the canned shell with NO signal (which reads as
 *  "the assistant got dumber" and gives no way out), name the real cause and offer a
 *  one-tap re-sign (kind:"reconnect"). */
export const SESSION_LOCKED_REPLY: ComposedReply = {
  content:
    "Your OpenRouter key is saved — but this session is locked, so I can only give canned answers right now. " +
    "(Your session went idle; reconnecting the wallet re-links it but doesn't reload the key.) " +
    "Tap “Reconnect to unlock” to re-sign in your wallet, and I'll be back to full strength.",
  suggestedActions: [{ id: "reconnect-session", label: "Reconnect to unlock", kind: "reconnect" }],
};

/** First message seeded into a brand-new chat task. */
export const SEED_GREETING: ComposedReply = {
  content:
    "Hi — I'm your Lab Assistant. I can help you find your way around QuantumLab: " +
    "drafting strategies, running backtests, reading your results, and understanding " +
    "why a strategy wins or loses. Soon I'll be able to do these for you directly. " +
    "What would you like to do?",
  suggestedActions: STARTER_ACTIONS,
};

interface Intent {
  test: RegExp;
  reply: () => ComposedReply;
  // True when the capability requires the user's OpenRouter key (an AI step).
  // When the wallet has no key saved, composeAgentReply wraps the reply with a
  // secure "add your key" nudge. Loading/reading/navigation intents leave unset.
  needsKey?: boolean;
}

// Ordered, first-match-wins. Phrased honestly: Phase B routes you to the tab that
// does the thing today and names the capability the agent will own in a later phase.
const INTENTS: Intent[] = [
  {
    // create / draft / new strategy / idea
    test: /\b(draft|create|build|make|new|generate|write)\b[^.?!]*\b(strateg\w*|bots?|scripts?|pine)\b|\b(strateg\w*|bots?|scripts?|pine)\b[^.?!]*\b(draft|create|build|make|new|generate|write)\b|suggest (a |an )?(strateg\w*|idea)/i,
    reply: () => ({
      content:
        "Strategy drafting lives in the Creator — describe what you want in plain English and it writes the Pine for you. " +
        "I'll be able to draft and test ideas for you end-to-end in a later phase. For now, I've pointed you there.",
      suggestedActions: [NAV.draft, NAV.backtest, ASK.help],
    }),
    needsKey: true,
  },
  {
    // templates
    test: /\btemplate/i,
    reply: () => ({
      content:
        "Ready-made strategy templates are in the Creator — start from one and tweak it. " +
        "Soon I'll be able to pick and tune a template for you.",
      suggestedActions: [NAV.draft, NAV.backtest],
    }),
  },
  {
    // improve (AI step — checked before "why losing" so "improve my losing
    // strategy" routes here and triggers the key nudge, not the insights reply)
    test: /\bimprove\b/i,
    reply: () => ({
      content:
        "Improving rewrites a strategy from its weaknesses using your OpenRouter key — an AI step I'll run for you once the " +
        "deterministic search is exhausted, coming in a later phase. The Creator handles it manually today.",
      suggestedActions: [NAV.draft, NAV.insights],
    }),
    needsKey: true,
  },
  {
    // why losing / insights / report (checked before "results" so "losing" wins)
    test: /\b(why|lose|losing|loss|drawdown|insight|report|explain|overfit|underperform)\b/i,
    reply: () => ({
      content:
        "The Insights tab breaks down parameter sensitivity and directional bias, and helps explain why a strategy under-performs. " +
        "Soon I'll read it and explain it in plain language, then offer to improve the strategy.",
      suggestedActions: [NAV.insights, NAV.results],
    }),
  },
  {
    // heatmap
    test: /\bheat ?map/i,
    reply: () => ({
      content: "The parameter heatmap shows how your results shift across two parameters — I've pointed you to it.",
      suggestedActions: [NAV.heatmap, NAV.results],
    }),
  },
  {
    // results / best / top / winners
    test: /\b(result|best|top|winner|leaderboard|ranked|ranking|profit)\b/i,
    reply: () => ({
      content:
        "Your ranked results are on the Results tab. Heads up: the lab ranks by profit/win-rate today, which isn't the same as robust — " +
        "a later phase will let me re-rank by out-of-sample robustness for you.",
      suggestedActions: [NAV.results, NAV.heatmap, ASK.whyLosing],
    }),
  },
  {
    // refine
    test: /\brefin/i,
    reply: () => ({
      content:
        "Refining hones in around a run's best parameters. You can launch a refine from a finished run; " +
        "in a later phase I'll chain random → refine → deep search for you automatically.",
      suggestedActions: [NAV.results, NAV.backtest],
    }),
  },
  {
    // backtest / optimize / run / test
    test: /\b(backtest|back-test|optimi[sz]e|optimi[sz]ation|run|test)\b/i,
    reply: () => ({
      content:
        "Backtests and optimizations are set up on the Backtest Setup tab — pick a strategy, symbols and timeframes, then run. " +
        "In a later phase I'll queue and watch these runs for you.",
      suggestedActions: [NAV.backtest, NAV.results, ASK.help],
    }),
  },
  {
    // greetings / help / capabilities
    test: /\b(hi|hey|hello|help|what can you|who are you|capab|how do you)\b/i,
    reply: () => ({
      content:
        "I'm the Lab Assistant. Right now I can guide you to the right place for each task — drafting, backtesting, reading results, " +
        "and insights — and remember our conversation. Driving the lab for you directly is coming next. Where to?",
      suggestedActions: STARTER_ACTIONS,
    }),
  },
];

/**
 * Prepend an honest heads-up and surface the secure key-entry chip FIRST when a
 * capability needs the user's OpenRouter key but none is saved. The key is added
 * in the Creator's encrypted store — never typed into this chat or sent to the
 * model (see server/ai-assistant/routes.ts POST /api/lab/creator/key).
 */
function withKeyGuidance(reply: ComposedReply): ComposedReply {
  return {
    content:
      "Heads up: this uses AI, so you'll need your own OpenRouter API key first. " +
      "Add it in the Creator — it goes straight to encrypted storage and is never typed into this chat or sent to the model. " +
      reply.content,
    suggestedActions: [NAV.addKey, ...reply.suggestedActions.filter((a) => a.id !== NAV.addKey.id)],
  };
}

/**
 * Map a user message to a deterministic assistant reply + option bubbles.
 * First matching intent wins; falls back to a friendly capabilities prompt.
 * `hasKey` lets AI-step replies nudge the user to add their OpenRouter key; it
 * defaults to true so chatting never nags someone who already has one.
 */
function baseAgentReply(userContent: string, hasKey: boolean): ComposedReply {
  const raw = (userContent ?? "").trim();

  // Explicit key questions: answer with the secure flow + current status. Note
  // chatting with me needs NO key — it only powers the AI Creator (draft/improve).
  if (/\b(api[ -]?key|open ?router|sk-or|byok?|my key)\b/i.test(raw)) {
    return hasKey
      ? {
          content:
            "You're set — your OpenRouter key is saved (encrypted). You don't need a key just to chat with me; " +
            "it powers the AI Creator when it drafts or improves a strategy. You can update or remove it in the Creator.",
          suggestedActions: [NAV.draft],
        }
      : {
          content:
            "You don't need a key to chat with me. To have the AI draft or improve a strategy, add your own OpenRouter key " +
            "in the Creator — it goes straight to encrypted storage and is never typed into this chat or sent to the model.",
          suggestedActions: [NAV.addKey, NAV.draft],
        };
  }

  for (const intent of INTENTS) {
    if (intent.test.test(raw)) {
      const reply = intent.reply();
      return intent.needsKey && !hasKey ? withKeyGuidance(reply) : reply;
    }
  }
  return {
    content:
      "I can help you draft strategies, run backtests, read your results, and understand why a strategy wins or loses. " +
      "Pick one below — or tell me what you're trying to do.",
    suggestedActions: STARTER_ACTIONS,
  };
}

/** Result-aware NEXT-STEP chips. `kind:"send"` so a click sends a follow-up message
 *  back to the agent (which then calls the matching tool). Gated by what's available:
 *  a finished run unlocks Refine; a current strategy unlocks Improve + try-another-
 *  asset. The agent re-checks the REAL preconditions (e.g. refine needs a holdout,
 *  improve needs existing results) and will explain if a chip can't proceed. */
function nextStepActions(ctx: NextStepContext): AgentSuggestedAction[] {
  const out: AgentSuggestedAction[] = [];
  if (ctx.lastRunId != null) {
    out.push({
      id: "next-refine",
      label: "Refine the best result",
      kind: "send",
      message: `Refine run #${ctx.lastRunId} to hone its best parameters.`,
    });
  }
  if (ctx.strategyId != null) {
    out.push({
      id: "next-improve",
      label: "Improve this strategy",
      kind: "send",
      message: `Improve strategy #${ctx.strategyId} based on its backtest weaknesses.`,
    });
    out.push({
      id: "next-another-asset",
      label: "Try another asset",
      kind: "send",
      message: `Backtest strategy #${ctx.strategyId} on another asset to check robustness.`,
    });
  }
  return out;
}

/**
 * Public entry: the deterministic reply (see {@link baseAgentReply}) plus — when the
 * orchestrator supplies result context — result-aware next-step chips appended after
 * the base chips. Dedupes by id and never drops a base chip. `resultCtx` omitted =
 * pure shell reply (back-compat for the degrade path and unit tests).
 */
export function composeAgentReply(
  userContent: string,
  hasKey = true,
  resultCtx?: NextStepContext,
): ComposedReply {
  const base = baseAgentReply(userContent, hasKey);
  if (!resultCtx) return base;
  const extra = nextStepActions(resultCtx);
  if (extra.length === 0) return base;
  const seen = new Set(base.suggestedActions.map((a) => a.id));
  return {
    content: base.content,
    suggestedActions: [...base.suggestedActions, ...extra.filter((a) => !seen.has(a.id))],
  };
}
