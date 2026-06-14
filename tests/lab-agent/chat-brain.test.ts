import { describe, it, expect } from "vitest";
import {
  buildChatMessages,
  generateLabChatReply,
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
