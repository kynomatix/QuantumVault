// QuantumLab Sandbox Agent — deterministic fallback chat replies.
//
// This is the NO-LLM fallback shell (docs/LAB_AGENT_SANDBOX_PLAN.md §14). The LIVE
// assistant is the agentic turn brain (server/lab-agent/chat-brain.ts +
// orchestrator.ts), which actually drives the lab on the user's key. These canned
// replies are used ONLY when that path can't run: the wallet has no OpenRouter key,
// the session is locked, or a turn degrades. So every reply here is a pure,
// deterministic function of the user's text — no network, no key, no hallucination
// surface. It still routes the user to the right tab AND describes, in present tense,
// what the assistant can actually do — never "coming later". When an action needs a
// key the wallet doesn't have, it names that honestly and points to the secure
// key-entry flow.
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

/** Two-button reply for a PAUSED auto run. The 30-min session UMK expired mid-run, so
 *  instead of killing the run we park it and let the user choose: re-sign and pick up where
 *  we left off, or clear it and start fresh. Both chips are kind:"reconnect" (they re-sign
 *  first); the dock branches on the id to either resume or stop. */
export const REAUTH_PAUSED_REPLY: ComposedReply = {
  content:
    "Your session timed out, so I paused this auto run instead of dropping it. Your progress is " +
    "saved. Tap “Continue session” to re-sign and pick up where we left off, or “Start a new one” " +
    "to clear it and begin fresh.",
  suggestedActions: [
    { id: "reauth-continue", label: "Continue session", kind: "reconnect" },
    { id: "reauth-fresh", label: "Start a new one", kind: "reconnect" },
  ],
};

/** Fallback for when an auto run loses the key because it was DELETED (not just a locked
 *  session): re-signing can't help, so drop back to chat and point the user to re-add the
 *  key in the Creator. */
export const KEY_MISSING_REPLY: ComposedReply = {
  content:
    "I can't reach your OpenRouter key anymore, so I stopped this auto run. Add your key again in " +
    "the Creator, then start a new run.",
  suggestedActions: [{ id: "nav-add-key", label: "Add your API key", kind: "navigate", tab: "creator" }],
};

/** First message seeded into a brand-new chat task. */
export const SEED_GREETING: ComposedReply = {
  content:
    "Hi — I'm your Lab Assistant. I can drive QuantumLab for you: draft a strategy from " +
    "a plain-English idea, run and refine backtests across assets, pull up and " +
    "rank your results, explain why a strategy wins or loses, and improve a " +
    "weak one. Just tell me what you want and I'll do it. What would you like to start with?",
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

// Ordered, first-match-wins. Present-tense and honest: each reply says what the
// assistant actually does now (and routes to the matching tab as a shortcut). When a
// capability needs the user's OpenRouter key and none is saved, withKeyGuidance names
// that. This is the fallback voice; the live agentic brain does the work directly.
const INTENTS: Intent[] = [
  {
    // create / draft / new strategy / idea
    test: /\b(draft|create|build|make|new|generate|write)\b[^.?!]*\b(strateg\w*|bots?|scripts?|pine)\b|\b(strateg\w*|bots?|scripts?|pine)\b[^.?!]*\b(draft|create|build|make|new|generate|write)\b|suggest (a |an )?(strateg\w*|idea)/i,
    reply: () => ({
      content:
        "I draft strategies from a plain-English idea, then write the Pine and backtest it for you. " +
        "Tell me the strategy you want (the asset, the style, and any rules) and I'll build it. " +
        "You can also open the Creator to draft one by hand.",
      suggestedActions: [NAV.draft, NAV.backtest, ASK.help],
    }),
    needsKey: true,
  },
  {
    // templates
    test: /\btemplate/i,
    reply: () => ({
      content:
        "I can start you from a ready-made template and tune it for you — or open the Creator to browse templates yourself.",
      suggestedActions: [NAV.draft, NAV.backtest],
    }),
  },
  {
    // improve (AI step — checked before "why losing" so "improve my losing
    // strategy" routes here and triggers the key nudge, not the insights reply)
    test: /\bimprove\b/i,
    reply: () => ({
      content:
        "I can improve a strategy for you — I rewrite it from its weaknesses and backtest the new version. That's an AI " +
        "step on your OpenRouter key, so I run it once the free search is exhausted. Tell me which strategy to improve.",
      suggestedActions: [NAV.draft, NAV.insights],
    }),
    needsKey: true,
  },
  {
    // why losing / insights / report (checked before "results" so "losing" wins)
    test: /\b(why|lose|losing|loss|drawdown|insight|report|explain|overfit|underperform)\b/i,
    reply: () => ({
      content:
        "I can read your insights — parameter sensitivity, directional bias, robustness — and explain in plain language " +
        "why a strategy underperforms, then improve it for you. Want me to take a look?",
      suggestedActions: [NAV.insights, NAV.results],
    }),
  },
  {
    // heatmap
    test: /\bheat ?map/i,
    reply: () => ({
      content: "I can pull up your heatmap — it shows how results shift across ticker and timeframe so you can see where a strategy holds up.",
      suggestedActions: [NAV.heatmap, NAV.results],
    }),
  },
  {
    // results / best / top / winners
    test: /\b(result|best|top|winner|leaderboard|ranked|ranking|profit)\b/i,
    reply: () => ({
      content:
        "I can pull up your results and rank them by robustness, not just headline profit — a result that holds up out-of-sample " +
        "beats a bigger in-sample number. Ask me for your most robust result, or open the Results tab.",
      suggestedActions: [NAV.results, NAV.heatmap, ASK.whyLosing],
    }),
  },
  {
    // refine
    test: /\brefin/i,
    reply: () => ({
      content:
        "I can refine a finished run for you — hone in around its best parameters, and chain random → refine → deep search " +
        "automatically. Point me at a run and I'll take it from there.",
      suggestedActions: [NAV.results, NAV.backtest],
    }),
  },
  {
    // backtest / optimize / run / test
    test: /\b(backtest|back-test|optimi[sz]e|optimi[sz]ation|run|test)\b/i,
    reply: () => ({
      content:
        "I can run a backtest or optimization for you — I queue it across assets, watch it, and read the results when it's done. " +
        "Tell me the strategy and assets, or open Backtest Setup to configure it yourself.",
      suggestedActions: [NAV.backtest, NAV.results, ASK.help],
    }),
  },
  {
    // greetings / help / capabilities
    test: /\b(hi|hey|hello|help|what can you|who are you|capab|how do you)\b/i,
    reply: () => ({
      content:
        "I drive the lab for you — I don't just point you around. I can draft a strategy from a plain-English idea, run and " +
        "refine backtests across assets, pull up and robustness-rank your results, read your insights to explain wins and " +
        "losses, and improve a weak strategy. Tell me what you want and I'll do it.",
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
 * For a keyless wallet the agentic loop can't run (it calls the model on the user's
 * OpenRouter key), so a present-tense "I can do X for you" reply would over-promise.
 * Prepend a brief, honest note so the capability framing stays true: "I can — once
 * you add your key." Text only: navigation/reading intents shouldn't nag with an
 * extra chip, and the note already says where the key goes. needsKey intents
 * (draft/improve) use the stronger withKeyGuidance, which also surfaces the add-key chip.
 */
function withChatKeyNote(reply: ComposedReply): ComposedReply {
  return {
    content:
      "Quick note — I'll need your own OpenRouter key before I can run things for you " +
      "(add it in the Creator: encrypted, never typed into this chat). Once it's in: " +
      reply.content,
    suggestedActions: reply.suggestedActions,
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

  // Explicit key questions: answer with the secure flow + current status. Chatting is
  // free, but the key is what lets me actually RUN things for you — the whole agentic
  // loop calls the model on your key, not just the AI Creator's draft/improve steps.
  if (/\b(api[ -]?key|open ?router|sk-or|byok?|my key)\b/i.test(raw)) {
    return hasKey
      ? {
          content:
            "You're set — your OpenRouter key is saved (encrypted). You don't need a key just to chat with me; " +
            "it's what lets me actually run things for you — drafting, backtesting, refining, reading results, and improving. " +
            "You can update or remove it in the Creator.",
          suggestedActions: [NAV.draft],
        }
      : {
          content:
            "You don't need a key to chat with me — but to have me actually run things for you (draft, backtest, refine, " +
            "improve), add your own OpenRouter key in the Creator — it goes straight to encrypted storage and is never typed " +
            "into this chat or sent to the model.",
          suggestedActions: [NAV.addKey, NAV.draft],
        };
  }

  for (const intent of INTENTS) {
    if (intent.test.test(raw)) {
      const reply = intent.reply();
      if (!hasKey) return intent.needsKey ? withKeyGuidance(reply) : withChatKeyNote(reply);
      return reply;
    }
  }
  const fallback: ComposedReply = {
    content:
      "I can draft strategies, run backtests, read and robustness-rank your results, and explain why a strategy wins or " +
      "loses — all for you. Pick one below, or tell me what you're trying to do.",
    suggestedActions: STARTER_ACTIONS,
  };
  return hasKey ? fallback : withChatKeyNote(fallback);
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
