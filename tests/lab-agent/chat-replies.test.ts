import { describe, it, expect } from "vitest";
import { agentSuggestedActionSchema } from "@shared/schema";
import {
  composeAgentReply,
  SEED_GREETING,
  STARTER_ACTIONS,
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
