import { describe, it, expect } from "vitest";
import { agentSuggestedActionSchema } from "@shared/schema";
import { looksLikeApiKey } from "@shared/api-key-detect";
import {
  composeAgentReply,
  SEED_GREETING,
  STARTER_ACTIONS,
  SESSION_LOCKED_REPLY,
} from "../../server/lab-agent/chat-replies";

// Mirror client/src/pages/QuantumLab.tsx `MainTab`.
const VALID_TABS = new Set(["hub", "main", "results", "heatmap", "insights", "creator"]);

function expectValidActions(actions: unknown) {
  expect(Array.isArray(actions)).toBe(true);
  for (const a of actions as any[]) {
    expect(() => agentSuggestedActionSchema.parse(a)).not.toThrow();
    if (a.kind === "navigate") {
      expect(a.tab).toBeDefined();
      expect(VALID_TABS.has(a.tab)).toBe(true);
    }
    if (a.kind === "send") {
      expect(typeof a.message).toBe("string");
      expect(a.message.length).toBeGreaterThan(0);
    }
  }
}

describe("SEED_GREETING", () => {
  it("has content and valid starter chips", () => {
    expect(SEED_GREETING.content.length).toBeGreaterThan(0);
    expect(SEED_GREETING.suggestedActions.length).toBeGreaterThan(0);
    expectValidActions(SEED_GREETING.suggestedActions);
  });
});

describe("STARTER_ACTIONS", () => {
  it("are all valid and uniquely identified", () => {
    expectValidActions(STARTER_ACTIONS);
    const ids = STARTER_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("SESSION_LOCKED_REPLY", () => {
  it("explains the locked state and offers a single reconnect chip (no tab/message needed)", () => {
    expect(SESSION_LOCKED_REPLY.content.length).toBeGreaterThan(0);
    expectValidActions(SESSION_LOCKED_REPLY.suggestedActions);
    const reconnect = SESSION_LOCKED_REPLY.suggestedActions.filter((a) => a.kind === "reconnect");
    expect(reconnect.length).toBe(1);
    // A reconnect chip drives the wallet re-sign client-side, so it carries no tab/message.
    expect(reconnect[0].tab).toBeUndefined();
    expect(reconnect[0].message).toBeUndefined();
  });
});

describe("composeAgentReply", () => {
  it("always returns content + valid chips for any input (incl. empty/gibberish)", () => {
    for (const input of ["", "   ", "asdkjfh random gibberish", "tell me a joke"]) {
      const r = composeAgentReply(input);
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.suggestedActions.length).toBeGreaterThan(0);
      expectValidActions(r.suggestedActions);
    }
  });

  it("routes a drafting intent to the Creator", () => {
    const r = composeAgentReply("can you create a new strategy for me?");
    expect(r.suggestedActions.some((a) => a.kind === "navigate" && a.tab === "creator")).toBe(true);
  });

  it("routes a backtest intent to Backtest Setup", () => {
    const r = composeAgentReply("how do I run a backtest?");
    expect(r.suggestedActions.some((a) => a.kind === "navigate" && a.tab === "main")).toBe(true);
  });

  it("routes a results intent to Results", () => {
    const r = composeAgentReply("what's my best result?");
    expect(r.suggestedActions.some((a) => a.kind === "navigate" && a.tab === "results")).toBe(true);
  });

  it("routes a 'why losing' intent to Insights (losing beats the results keyword)", () => {
    const r = composeAgentReply("why is my strategy losing money?");
    expect(r.suggestedActions.some((a) => a.kind === "navigate" && a.tab === "insights")).toBe(true);
  });

  it("answers a help/greeting intent with valid chips", () => {
    const r = composeAgentReply("hi, what can you do?");
    expect(r.content.length).toBeGreaterThan(0);
    expectValidActions(r.suggestedActions);
  });
});

describe("composeAgentReply: result-aware next-step chips", () => {
  it("appends NO next-step chips when no result context is given (back-compat)", () => {
    const r = composeAgentReply("what's my best result?");
    expect(r.suggestedActions.some((a) => a.id.startsWith("next-"))).toBe(false);
  });

  it("offers Refine when a finished run is in context", () => {
    const r = composeAgentReply("what's my best result?", true, { lastRunId: 42 });
    const refine = r.suggestedActions.find((a) => a.id === "next-refine");
    expect(refine).toBeDefined();
    expect(refine!.kind).toBe("send");
    expect((refine as any).message).toContain("42");
    // A run alone does not unlock the strategy-scoped chips.
    expect(r.suggestedActions.some((a) => a.id === "next-improve")).toBe(false);
    expectValidActions(r.suggestedActions);
  });

  it("offers Improve + try-another-asset when a strategy is in context", () => {
    const r = composeAgentReply("what's my best result?", true, { strategyId: 7 });
    expect(r.suggestedActions.some((a) => a.id === "next-improve")).toBe(true);
    expect(r.suggestedActions.some((a) => a.id === "next-another-asset")).toBe(true);
    expect(r.suggestedActions.some((a) => a.id === "next-refine")).toBe(false);
    expectValidActions(r.suggestedActions);
  });

  it("offers all three when both a run and a strategy are in context", () => {
    const r = composeAgentReply("what's my best result?", true, { strategyId: 7, lastRunId: 42 });
    for (const id of ["next-refine", "next-improve", "next-another-asset"]) {
      expect(r.suggestedActions.some((a) => a.id === id)).toBe(true);
    }
    // Base chips are preserved (next-step chips are appended, never replace them).
    const base = composeAgentReply("what's my best result?", true);
    for (const a of base.suggestedActions) {
      expect(r.suggestedActions.some((x) => x.id === a.id)).toBe(true);
    }
    // No duplicate ids.
    const ids = r.suggestedActions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expectValidActions(r.suggestedActions);
  });
});

describe("key guidance", () => {
  it("nudges to the secure key entry for AI drafting when no key is saved", () => {
    const r = composeAgentReply("create a new strategy for me", false);
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(true);
    // Still routes to the Creator and keeps copy honest about where the key goes.
    expect(r.suggestedActions.some((a) => a.kind === "navigate" && a.tab === "creator")).toBe(true);
    expect(r.content.toLowerCase()).toContain("openrouter");
    expectValidActions(r.suggestedActions);
  });

  it("does NOT nudge for drafting when a key is already saved", () => {
    const r = composeAgentReply("create a new strategy for me", true);
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(false);
    expect(r.suggestedActions.some((a) => a.kind === "navigate" && a.tab === "creator")).toBe(true);
  });

  it("answers an explicit key question with the secure flow (no key)", () => {
    const r = composeAgentReply("how do I add my OpenRouter api key?", false);
    expect(r.content.toLowerCase()).toContain("encrypted");
    expect(r.content.toLowerCase()).toContain("never typed into this chat");
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(true);
    expectValidActions(r.suggestedActions);
  });

  it("confirms a saved key and clarifies chat needs no key", () => {
    const r = composeAgentReply("what about my api key?", true);
    expect(r.content.toLowerCase()).toContain("saved");
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(false);
    expectValidActions(r.suggestedActions);
  });

  it("does not nudge non-AI intents even without a key", () => {
    const r = composeAgentReply("how do I run a backtest?", false);
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(false);
  });

  it("defaults to no nudge when hasKey is omitted (backward compatible)", () => {
    const r = composeAgentReply("create a new strategy for me");
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(false);
  });

  it("nudges for 'improve my losing strategy' (improve beats why-losing)", () => {
    const r = composeAgentReply("improve my losing strategy", false);
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(true);
    expectValidActions(r.suggestedActions);
  });

  it("still routes a plain 'why is it losing' to insights, not improve", () => {
    const r = composeAgentReply("why is my strategy losing money?", false);
    expect(r.suggestedActions.some((a) => a.kind === "navigate" && a.tab === "insights")).toBe(true);
    expect(r.suggestedActions.some((a) => a.id === "nav-add-key")).toBe(false);
  });
});

describe("looksLikeApiKey (pasted-secret guard)", () => {
  it("flags a real-shaped OpenRouter key", () => {
    expect(looksLikeApiKey("sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("flags a key embedded in a sentence", () => {
    expect(looksLikeApiKey("here is my key sk-or-v1-abcdef0123456789abcdef0123456789 thanks")).toBe(true);
  });

  it("flags other long sk- secrets too (defense in depth)", () => {
    expect(looksLikeApiKey("sk-proj-abcdef0123456789abcdef0123")).toBe(true);
  });

  it("does NOT flag ordinary chat that merely mentions a key", () => {
    expect(looksLikeApiKey("where do I add my openrouter api key?")).toBe(false);
    expect(looksLikeApiKey("what is an sk-or key?")).toBe(false);
    expect(looksLikeApiKey("create a new strategy for me")).toBe(false);
  });

  it("does NOT flag a 'task-' style word that contains 'sk-'", () => {
    expect(looksLikeApiKey("finish the task-force-onboarding-checklist-item")).toBe(false);
  });

  it("handles empty / nullish input safely", () => {
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey(null)).toBe(false);
    expect(looksLikeApiKey(undefined)).toBe(false);
  });
});
