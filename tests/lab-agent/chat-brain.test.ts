import { describe, it, expect } from "vitest";
import {
  buildChatMessages,
  buildDecisionMessages,
  generateLabChatReply,
  coerceProseToFinal,
  isSafeDirectAnswerTurn,
  namedAvailableTickers,
  DEFAULT_CHAT_MODEL,
  type ChatBrainInput,
  type BrainTurnContext,
} from "../../server/lab-agent/chat-brain";
import { LAB_AVAILABLE_TICKERS } from "../../shared/schema";

// chat-brain is the Phase C0 conversational brain. The pure, deterministic surface
// is buildChatMessages (prompt assembly + context bounding); the networked surface
// (generateLabChatReply -> OpenRouter, estimateCallCostUsd -> catalog fetch) is left
// to integration coverage. These tests pin the bounds/ordering/honesty guarantees.

const baseInput = (over: Partial<ChatBrainInput> = {}): ChatBrainInput => ({
  goal: null,
  recentMessages: [{ role: "user", content: "How do I run a backtest?" }],
  apiKey: "sk-or-test",
  ...over,
});

describe("DEFAULT_CHAT_MODEL", () => {
  it("is the cheap-but-capable DeepSeek default", () => {
    expect(DEFAULT_CHAT_MODEL).toBe("deepseek/deepseek-v4-pro");
  });
});

describe("buildChatMessages", () => {
  it("starts with a system prompt that states the honesty limits + acts-now framing", () => {
    const msgs = buildChatMessages(baseInput());
    expect(msgs[0].role).toBe("system");
    const sys = msgs[0].content;
    // The brain now DOES the work; it must never solicit a key, and must respond in English.
    expect(/never ask .* api key/i.test(sys)).toBe(true);
    expect(/always respond in english/i.test(sys)).toBe(true);
    // Old stale shell claim must be gone (it caused the confirmation-seeking pattern).
    expect(sys).not.toMatch(/\bCANNOT\b/);
  });

  it("ends with the user's newest turn", () => {
    const msgs = buildChatMessages(
      baseInput({
        recentMessages: [
          { role: "agent", content: "Welcome!" },
          { role: "user", content: "latest question" },
        ],
      }),
    );
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("latest question");
  });

  it("injects the task goal into the system prompt only when present", () => {
    const withGoal = buildChatMessages(baseInput({ goal: "tune my RSI scalper" }));
    const without = buildChatMessages(baseInput({ goal: null }));
    expect(withGoal[0].content).toMatch(/tune my RSI scalper/);
    expect(without[0].content).not.toMatch(/current focus for this conversation/);
  });

  it("maps stored roles to OpenRouter roles (agent/tool -> assistant)", () => {
    const msgs = buildChatMessages(
      baseInput({
        recentMessages: [
          { role: "agent", content: "a" },
          { role: "tool", content: "t" },
          { role: "user", content: "u" },
        ],
      }),
    );
    const body = msgs.slice(1); // drop system
    expect(body.map((m) => m.role)).toEqual(["assistant", "assistant", "user"]);
  });

  it("keeps at most the 20 most-recent turns, in chronological order", () => {
    const recent = Array.from({ length: 25 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "agent") as "user" | "agent",
      content: `m${i}`,
    }));
    const msgs = buildChatMessages(baseInput({ recentMessages: recent }));
    const body = msgs.slice(1);
    expect(body.length).toBe(20);
    // newest-first selection then restored to order => kept window is m5..m24.
    expect(body[0].content).toBe("m5");
    expect(body[body.length - 1].content).toBe("m24");
  });

  it("strips pure filler user turns so they don't consume context slots", () => {
    const msgs = buildChatMessages(
      baseInput({
        recentMessages: [
          { role: "user", content: "draft me a momentum bot on SOL" },
          { role: "agent", content: "Drafting it now." },
          { role: "user", content: "ok" },
          { role: "user", content: "go on then" },
          { role: "user", content: "yes" },
          { role: "user", content: "what's the win rate?" },
        ],
      }),
    );
    const body = msgs.slice(1);
    const contents = body.map((m) => m.content);
    expect(contents).not.toContain("ok");
    expect(contents).not.toContain("go on then");
    expect(contents).not.toContain("yes");
    // Substantive turns survive.
    expect(contents).toContain("draft me a momentum bot on SOL");
    expect(contents).toContain("what's the win rate?");
  });

  it("truncates an oversized tool result but keeps user turns intact", () => {
    const bigTool = "T".repeat(3000);
    const bigUser = "U".repeat(3000);
    const msgs = buildChatMessages(
      baseInput({
        recentMessages: [
          { role: "tool", content: bigTool },
          { role: "user", content: bigUser },
        ],
      }),
    );
    const body = msgs.slice(1);
    const toolMsg = body[0];
    expect(toolMsg.content.length).toBeLessThan(bigTool.length);
    expect(toolMsg.content).toMatch(/tool result truncated/);
    // A user turn of the same size is NOT truncated.
    expect(body[body.length - 1].content).toBe(bigUser);
  });

  it("drops empty / whitespace-only messages", () => {
    const msgs = buildChatMessages(
      baseInput({
        recentMessages: [
          { role: "agent", content: "   " },
          { role: "user", content: "real question" },
        ],
      }),
    );
    const body = msgs.slice(1);
    expect(body.length).toBe(1);
    expect(body[0].content).toBe("real question");
  });

  it("enforces the ~12k char budget but always keeps the newest turn", () => {
    const huge = "x".repeat(10000);
    const recent: ChatBrainInput["recentMessages"] = [
      { role: "user", content: huge }, // oldest
      { role: "agent", content: huge },
      { role: "user", content: "newest" },
    ];
    const msgs = buildChatMessages(baseInput({ recentMessages: recent }));
    const body = msgs.slice(1);
    // Newest is always admitted; the budget then fits exactly one 10000-char turn.
    expect(body[body.length - 1].content).toBe("newest");
    const totalChars = body.reduce((n, m) => n + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(12000);
  });

  it("trims surrounding whitespace on turns", () => {
    const msgs = buildChatMessages(
      baseInput({ recentMessages: [{ role: "user", content: "  spaced  " }] }),
    );
    expect(msgs[msgs.length - 1].content).toBe("spaced");
  });
});

// Regression: the brain used to refuse a valid ticker (e.g. HYPE) as "not available"
// and deflect to SOL/ETH/ARB, because it was never told the real ticker universe and a
// rule pushed it off single symbols. Both prompts now carry the live AVAILABLE list from
// the schema source of truth, and the rules honor an explicitly named single symbol.
describe("available backtest symbols injection", () => {
  const decisionBase = (over: Partial<BrainTurnContext> = {}): BrainTurnContext => ({
    goal: null,
    recentMessages: [{ role: "user", content: "backtest a trend bot on HYPE" }],
    ...over,
  });

  it("lists every schema ticker in the decision system prompt", () => {
    const sys = buildDecisionMessages(decisionBase())[0].content;
    expect(sys).toMatch(/AVAILABLE BACKTEST SYMBOLS/);
    for (const t of LAB_AVAILABLE_TICKERS) {
      expect(sys).toContain(t.name);
    }
    // The exact ticker the user was wrongly refused must be present.
    expect(sys).toContain("HYPE");
  });

  it("also lists the tickers in the conversational chat prompt", () => {
    const sys = buildChatMessages(baseInput())[0].content;
    expect(sys).toMatch(/AVAILABLE BACKTEST SYMBOLS/);
    expect(sys).toContain("HYPE");
  });

  it("instructs the brain to honor an explicitly named single ticker", () => {
    // Collapse line-wrap whitespace so phrases that span prompt lines still match.
    const sys = buildDecisionMessages(decisionBase())[0].content.replace(/\s+/g, " ");
    // Single named ticker is allowed; never call a listed ticker unavailable.
    expect(/single named ticker is fine/i.test(sys)).toBe(true);
    expect(/never tell the user it is unavailable/i.test(sys)).toBe(true);
  });

  it("injects a 'these ARE backtestable' line naming the ticker the user mentioned", () => {
    const sys = buildDecisionMessages(decisionBase())[0].content;
    expect(sys).toMatch(/named these tickers/);
    expect(sys).toMatch(/backtestable here: HYPE/);
    // Same injection in the conversational prompt.
    const chatSys = buildChatMessages(
      baseInput({ recentMessages: [{ role: "user", content: "try a scalper on HYPE" }] }),
    )[0].content;
    expect(chatSys).toMatch(/backtestable here: HYPE/);
  });

  it("omits the injection line when the user named no available ticker", () => {
    const sys = buildDecisionMessages(
      decisionBase({ recentMessages: [{ role: "user", content: "how do you work?" }] }),
    )[0].content;
    expect(sys).not.toMatch(/backtestable here/);
  });
});

describe("namedAvailableTickers", () => {
  it("detects a plainly named ticker (the HYPE first-ask regression)", () => {
    expect(namedAvailableTickers("backtest a trend bot on HYPE")).toContain("HYPE");
  });

  it("is case-insensitive for unambiguous symbols", () => {
    const found = namedAvailableTickers("let's try sol and eth");
    expect(found).toContain("SOL");
    expect(found).toContain("ETH");
  });

  it("only matches whole words, never substrings", () => {
    // "sol" lives inside "absolutely"/"solid" but must NOT be detected.
    expect(namedAvailableTickers("an absolutely solid foundation")).not.toContain("SOL");
  });

  it("requires uppercase for ambiguous English-word tickers like NEAR", () => {
    expect(namedAvailableTickers("buy near the close")).not.toContain("NEAR");
    expect(namedAvailableTickers("go long NEAR now")).toContain("NEAR");
  });

  it("returns nothing for empty text", () => {
    expect(namedAvailableTickers("")).toEqual([]);
  });
});

// The result-summary formatting + per-timeframe rules the brain must follow so the dock
// renders clean bold lines with trades + a leverage line, and reports the combo the user
// actually asked for (not a stale older run).
describe("result formatting rules", () => {
  const sys = buildDecisionMessages({ goal: null, recentMessages: [] })[0].content;
  const flat = sys.replace(/\s+/g, " ");

  it("requires trades and a drawdown-sized leverage line from the DTO fields", () => {
    expect(flat).toContain("Trades:");
    expect(flat).toContain("suggestedLeverage");
    expect(flat).toContain("leveragedNetProfitPercent");
  });

  it("forbids em dashes in the formatted result", () => {
    expect(/no em dashes/i.test(flat)).toBe(true);
  });

  it("tells the brain to report the best result for EACH requested combo", () => {
    expect(/report the best result for each/i.test(flat)).toBe(true);
    expect(/never substitute an older run/i.test(flat)).toBe(true);
  });
});

describe("generateLabChatReply", () => {
  it("is exported as the brain entry point (network path is integration-tested)", () => {
    expect(typeof generateLabChatReply).toBe("function");
  });
});

describe("coerceProseToFinal", () => {
  // A turn where a tool actually ran: a user turn followed by a tool result. This is the
  // ONLY shape the salvage should ever rescue (a post-tool prose answer).
  const afterTool = (prose: string): Parameters<typeof coerceProseToFinal>[1] => [
    { role: "user", content: "what's my most robust result?" },
    { role: "tool", content: "getTopResults result: {\"runId\":371,\"net\":418.73}" },
  ];

  it("salvages clean post-tool prose into a final decision (the degrade-after-tools fix)", () => {
    const prose =
      "Your most robust strategy is Stop-Run Reversal v2 — on SOL/USDT 1h it's up 418.73% net.";
    const out = coerceProseToFinal(prose, afterTool(prose));
    expect(out).not.toBeNull();
    expect(out?.action).toBe("final");
    expect(out?.message).toBe(prose);
  });

  it("returns null when NO tool ran this turn (don't rescue a fresh no-tool prose turn)", () => {
    const prose = "I'm doing great, thanks for asking! How can I help with your strategies?";
    const noTool: Parameters<typeof coerceProseToFinal>[1] = [
      { role: "agent", content: "earlier reply" },
      { role: "tool", content: "old tool result: {}" }, // a PRIOR turn's tool, before the user
      { role: "user", content: "how are you?" },
    ];
    expect(coerceProseToFinal(prose, noTool)).toBeNull();
  });

  it("rejects output containing JSON braces (a half / broken decision, not prose)", () => {
    const broken = 'Here is the result {"action":"final"';
    expect(coerceProseToFinal(broken, afterTool(broken))).toBeNull();
  });

  it("rejects output containing code fences", () => {
    const fenced = "Here are your results:\n```json\n[1,2,3]\n```";
    expect(coerceProseToFinal(fenced, afterTool(fenced))).toBeNull();
  });

  it("rejects output leaking reasoning/thinking markers", () => {
    const thinky = "<think>let me decide</think> Your best result is up 418%.";
    expect(coerceProseToFinal(thinky, afterTool(thinky))).toBeNull();
  });

  it("rejects plain-text reasoning prefixes (no XML tag)", () => {
    for (const lead of ["Reasoning: ", "Thinking - ", "Scratchpad: "]) {
      const leak = `${lead}the user wants the heatmap, so I should read it and report.`;
      expect(coerceProseToFinal(leak, afterTool(leak))).toBeNull();
    }
  });

  it("rejects array-shaped malformed output (brackets are not prose)", () => {
    const arr = '["Your best result is Stop-Run Reversal v2, up 418.73% net."]';
    expect(coerceProseToFinal(arr, afterTool(arr))).toBeNull();
  });

  it("rejects too-short output", () => {
    const tiny = "ok";
    expect(coerceProseToFinal(tiny, afterTool(tiny))).toBeNull();
  });

  it("caps an over-long answer to the salvage ceiling", () => {
    const huge = "a".repeat(2500); // clean prose, no braces/fences/markers
    const out = coerceProseToFinal(huge, afterTool(huge));
    expect(out).not.toBeNull();
    expect(out!.message.length).toBeLessThanOrEqual(2000);
  });

  it("with requireToolRan:false, salvages clean prose even when NO tool ran (last-resort chat salvage)", () => {
    const prose =
      "I live in the backtesting lab, so I can't see a deployed bot's live trades. But I can backtest that strategy here.";
    const noTool: Parameters<typeof coerceProseToFinal>[1] = [
      { role: "user", content: "can you see how my deployed bot is doing?" },
    ];
    expect(coerceProseToFinal(prose, noTool)).toBeNull(); // default: gated off when no tool ran
    const out = coerceProseToFinal(prose, noTool, { requireToolRan: false });
    expect(out?.action).toBe("final");
    expect(out?.message).toBe(prose);
  });

  it("with requireToolRan:false, still rejects half-JSON / fences / thinking markers", () => {
    const noTool: Parameters<typeof coerceProseToFinal>[1] = [];
    expect(coerceProseToFinal('Sure, here you go {"action":"final"', noTool, { requireToolRan: false })).toBeNull();
    expect(coerceProseToFinal("here you go\n```json\n[1]\n```", noTool, { requireToolRan: false })).toBeNull();
    expect(coerceProseToFinal("<think>hmm</think> ok here is your answer now", noTool, { requireToolRan: false })).toBeNull();
  });
});

describe("isSafeDirectAnswerTurn", () => {
  it("allows conversational / scope / how-it-works questions", () => {
    for (const q of [
      "how does the creator work",
      "can you explain how it works though?",
      "but how does it actually create strategies, under the hood?",
      "I don't have pro tradingview, only a couple of alerts, is that a blocker?",
      "If I deployed a strategy here, can you see how its trades are going?",
      "who are you and what can you do?",
    ]) {
      expect(isSafeDirectAnswerTurn(q)).toBe(true);
    }
  });

  it("rejects in-scope DATA / metric / performance asks (so salvage can't fabricate a number)", () => {
    for (const q of [
      "what's my best result?",
      "what is my best result",
      "show me my results",
      "how's my pnl looking",
      "what's my win rate and drawdown",
      "how did my strategy perform?",
      "which run performed best?",
      "what's my best run?",
    ]) {
      expect(isSafeDirectAnswerTurn(q)).toBe(false);
    }
  });

  it("rejects clear lab ACTION asks (must go through a tool), even when phrased politely", () => {
    for (const q of [
      "optimize my SOL strategy",
      "backtest my RSI bot",
      "refine that run",
      "improve my losing strategy",
      "draft me a momentum strategy",
      "can you draft me a momentum strategy?",
      "could you create a Pine bot for ETH?",
      "can you build me a strategy?",
    ]) {
      expect(isSafeDirectAnswerTurn(q)).toBe(false);
    }
  });

  it("returns false for empty input", () => {
    expect(isSafeDirectAnswerTurn("")).toBe(false);
    expect(isSafeDirectAnswerTurn("   ")).toBe(false);
  });
});
