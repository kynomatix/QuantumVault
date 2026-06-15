import { describe, it, expect } from "vitest";
import {
  buildChatMessages,
  generateLabChatReply,
  coerceProseToFinal,
  DEFAULT_CHAT_MODEL,
  type ChatBrainInput,
} from "../../server/lab-agent/chat-brain";

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
  it("starts with a system prompt that states the C0 honesty limits", () => {
    const msgs = buildChatMessages(baseInput());
    expect(msgs[0].role).toBe("system");
    const sys = msgs[0].content;
    // Limits the brain must carry into every turn (talk-only + never solicit keys).
    expect(sys).toMatch(/CANNOT/);
    expect(/never ask .* api key/i.test(sys)).toBe(true);
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

  it("keeps at most the 10 most-recent turns, in chronological order", () => {
    const recent = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "agent") as "user" | "agent",
      content: `m${i}`,
    }));
    const msgs = buildChatMessages(baseInput({ recentMessages: recent }));
    const body = msgs.slice(1);
    expect(body.length).toBe(10);
    // newest-first selection then restored to order => kept window is m5..m14.
    expect(body[0].content).toBe("m5");
    expect(body[body.length - 1].content).toBe("m14");
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

  it("enforces the ~6k char budget but always keeps the newest turn", () => {
    const huge = "x".repeat(5000);
    const recent: ChatBrainInput["recentMessages"] = [
      { role: "user", content: huge }, // oldest
      { role: "agent", content: huge },
      { role: "user", content: "newest" },
    ];
    const msgs = buildChatMessages(baseInput({ recentMessages: recent }));
    const body = msgs.slice(1);
    // Newest is always admitted; the budget then fits exactly one 5000-char turn.
    expect(body[body.length - 1].content).toBe("newest");
    const totalChars = body.reduce((n, m) => n + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(6000);
  });

  it("trims surrounding whitespace on turns", () => {
    const msgs = buildChatMessages(
      baseInput({ recentMessages: [{ role: "user", content: "  spaced  " }] }),
    );
    expect(msgs[msgs.length - 1].content).toBe("spaced");
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
});
