// Tests for server/ai-trader/reflection-service.ts
//
// Coverage targets:
//   • Zod schema validation (playbookEntrySchema, updatePlaybookSchema)
//   • callReflectionLlm — valid response, malformed→retry→keep-old, gateway error,
//     win-cannot-evict-failure (server stores model output verbatim)
//   • fireReflection — no-key skip, in-flight guard

import { describe, it, expect, vi, beforeEach } from "vitest";

// Module mocks MUST be hoisted before any import that resolves the mocked module.
vi.mock("../../server/ai-assistant/router", () => ({
  callOpenRouterWithUsage: vi.fn(),
  LlmGatewayError: class LlmGatewayError extends Error {
    constructor(msg: string) { super(msg); this.name = "LlmGatewayError"; }
  },
}));

vi.mock("../../server/storage", () => ({
  storage: {
    getWalletLlmApiKeyCiphertext: vi.fn(),
    updateAiTraderBot: vi.fn(),
    getRecentClosedDecisions: vi.fn(),
  },
}));

vi.mock("../../server/session-v3", () => ({
  getSessionByWalletAddress: vi.fn(),
  restoreWalletSecurityFromStorage: vi.fn().mockResolvedValue(undefined),
  decryptLlmApiKeyV3: vi.fn(),
}));

import {
  playbookEntrySchema,
  updatePlaybookSchema,
  callReflectionLlm,
  fireReflection,
} from "../../server/ai-trader/reflection-service";
import { callOpenRouterWithUsage, LlmGatewayError } from "../../server/ai-assistant/router";
import { storage } from "../../server/storage";
import {
  getSessionByWalletAddress,
  decryptLlmApiKeyV3,
} from "../../server/session-v3";

const mockCallLlm = vi.mocked(callOpenRouterWithUsage);
const mockStorage = storage as any;
const mockGetSession = vi.mocked(getSessionByWalletAddress);
const mockDecrypt = vi.mocked(decryptLlmApiKeyV3);

// --- Fixtures ----------------------------------------------------------------

const VALID_ENTRY = {
  lesson: "range longs 1-for-4 in chop",
  regime: "ranging" as const,
  evidence: "1 of 4",
};

const BOT_STUB: any = {
  id: "bot-reflect-0001",
  walletAddress: "wallet-reflect-test",
  market: "SOL-PERP",
  playbook: null,
  playbookVersion: 0,
  playbookUpdatedAt: null,
};

const DECISION_STUB = {
  rawDecision: { action: "long", rationale: "trend up", invalidation: "below support" },
  clampedDecision: { action: "long", exitReason: "sl" },
  realizedPnl: "-12.50",
  contextDigest: {},
};

const makeToolResponse = (entries: typeof VALID_ENTRY[]) => ({
  content: "",
  toolCalls: [
    { name: "update_playbook", arguments: JSON.stringify({ entries }) },
  ],
});

const VALID_TOOL_RESPONSE = makeToolResponse([VALID_ENTRY]);
const NO_TOOL_RESPONSE = { content: "sorry, I cannot help with that", toolCalls: undefined };

// --- playbookEntrySchema -----------------------------------------------------

describe("playbookEntrySchema", () => {
  it("accepts a valid entry", () => {
    expect(playbookEntrySchema.safeParse(VALID_ENTRY).success).toBe(true);
  });

  it("accepts all four valid regimes", () => {
    for (const regime of ["trending", "ranging", "transitional", "any"] as const) {
      expect(playbookEntrySchema.safeParse({ ...VALID_ENTRY, regime }).success).toBe(true);
    }
  });

  it("rejects lesson > 200 characters", () => {
    const r = playbookEntrySchema.safeParse({ ...VALID_ENTRY, lesson: "x".repeat(201) });
    expect(r.success).toBe(false);
  });

  it("rejects evidence > 40 characters", () => {
    const r = playbookEntrySchema.safeParse({ ...VALID_ENTRY, evidence: "x".repeat(41) });
    expect(r.success).toBe(false);
  });

  it("rejects unknown regime", () => {
    const r = playbookEntrySchema.safeParse({ ...VALID_ENTRY, regime: "volatile" });
    expect(r.success).toBe(false);
  });
});

// --- updatePlaybookSchema ----------------------------------------------------

describe("updatePlaybookSchema", () => {
  it("accepts 0 entries (empty playbook)", () => {
    expect(updatePlaybookSchema.safeParse({ entries: [] }).success).toBe(true);
  });

  it("accepts exactly 12 entries (cap)", () => {
    const entries = Array(12).fill(VALID_ENTRY);
    expect(updatePlaybookSchema.safeParse({ entries }).success).toBe(true);
  });

  it("rejects 13 entries (exceeds cap)", () => {
    const entries = Array(13).fill(VALID_ENTRY);
    expect(updatePlaybookSchema.safeParse({ entries }).success).toBe(false);
  });
});

// --- callReflectionLlm -------------------------------------------------------

describe("callReflectionLlm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns entries on a valid tool call response", async () => {
    mockCallLlm.mockResolvedValueOnce(VALID_TOOL_RESPONSE as any);

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].lesson).toBe(VALID_ENTRY.lesson);
      expect(result.entries[0].regime).toBe(VALID_ENTRY.regime);
    }
    expect(mockCallLlm).toHaveBeenCalledTimes(1);
  });

  it("retries once on malformed response and returns malformed after two failures", async () => {
    mockCallLlm
      .mockResolvedValueOnce(NO_TOOL_RESPONSE as any)
      .mockResolvedValueOnce(NO_TOOL_RESPONSE as any);

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
    // First attempt + one corrective retry = 2 LLM calls total.
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
  });

  it("succeeds on second attempt when first attempt is malformed", async () => {
    mockCallLlm
      .mockResolvedValueOnce(NO_TOOL_RESPONSE as any)
      .mockResolvedValueOnce(VALID_TOOL_RESPONSE as any);

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);

    expect(result.ok).toBe(true);
    expect(mockCallLlm).toHaveBeenCalledTimes(2);
  });

  it("returns gateway error on LlmGatewayError throw", async () => {
    mockCallLlm.mockRejectedValueOnce(new (LlmGatewayError as any)("network timeout"));

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("gateway");
      expect(result.detail).toContain("network timeout");
    }
  });

  it("returns gateway error on non-LlmGatewayError throw", async () => {
    mockCallLlm.mockRejectedValueOnce(new Error("connection refused"));

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("gateway");
    }
  });

  // win-cannot-evict-failure: the server stores model output verbatim and must
  // never filter out failure lessons in favour of win lessons. Curation is the
  // model's job (enforced via prompt instructions). Server just validates schema
  // and persists whatever the model returns.
  it("stores failure-lesson-only playbook verbatim (win-cannot-evict-failure invariant)", async () => {
    const failureLesson = { lesson: "breakout shorts 0-for-3 in trend", regime: "trending" as const, evidence: "0 of 3" };
    const winLesson = { lesson: "with-trend longs 4-for-5", regime: "trending" as const, evidence: "4 of 5" };
    mockCallLlm.mockResolvedValueOnce(makeToolResponse([failureLesson, winLesson]) as any);

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both lessons must be present — server must NOT filter failure lessons.
      expect(result.entries).toHaveLength(2);
      expect(result.entries.find(e => e.lesson === failureLesson.lesson)).toBeDefined();
      expect(result.entries.find(e => e.lesson === winLesson.lesson)).toBeDefined();
    }
  });

  it("rejects a response with an invalid tool arguments (invalid regime)", async () => {
    const badArgs = JSON.stringify({ entries: [{ ...VALID_ENTRY, regime: "invalid-regime" }] });
    const badResponse = { content: "", toolCalls: [{ name: "update_playbook", arguments: badArgs }] };
    mockCallLlm
      .mockResolvedValueOnce(badResponse as any)
      .mockResolvedValueOnce(badResponse as any);

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects a response with wrong tool name", async () => {
    const wrongTool = { content: "", toolCalls: [{ name: "something_else", arguments: "{}" }] };
    mockCallLlm
      .mockResolvedValueOnce(wrongTool as any)
      .mockResolvedValueOnce(wrongTool as any);

    const result = await callReflectionLlm("api-key", BOT_STUB, DECISION_STUB);
    expect(result.ok).toBe(false);
  });
});

// --- fireReflection ----------------------------------------------------------

describe("fireReflection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips silently when no BYO key is found (ciphertext is null)", async () => {
    const BOT_NO_KEY: any = { ...BOT_STUB, id: "bot-reflect-nokey-01" };
    mockStorage.getRecentClosedDecisions.mockResolvedValue([
      { ...DECISION_STUB, id: "dec-1", realizedPnl: "-10.00" },
    ]);
    mockStorage.getWalletLlmApiKeyCiphertext.mockResolvedValue(null);

    fireReflection(BOT_NO_KEY);
    await new Promise(r => setTimeout(r, 30));

    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(mockStorage.updateAiTraderBot).not.toHaveBeenCalled();
  });

  it("skips silently when no session UMK is available", async () => {
    const BOT_NO_UMK: any = { ...BOT_STUB, id: "bot-reflect-noumk-01" };
    mockStorage.getRecentClosedDecisions.mockResolvedValue([
      { ...DECISION_STUB, id: "dec-2", realizedPnl: "-5.00" },
    ]);
    mockStorage.getWalletLlmApiKeyCiphertext.mockResolvedValue(Buffer.from("encrypted-key"));
    mockGetSession.mockReturnValue(null); // no in-memory session

    fireReflection(BOT_NO_UMK);
    await new Promise(r => setTimeout(r, 30));

    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(mockStorage.updateAiTraderBot).not.toHaveBeenCalled();
  });

  it("in-flight guard: second concurrent call for same bot is skipped", async () => {
    const BOT_INFLIGHT: any = { ...BOT_STUB, id: "bot-reflect-inflight-01" };
    mockStorage.getRecentClosedDecisions.mockResolvedValue([
      { ...DECISION_STUB, id: "dec-3", realizedPnl: "-8.00" },
    ]);
    mockStorage.getWalletLlmApiKeyCiphertext.mockResolvedValue(null); // exits early

    fireReflection(BOT_INFLIGHT);
    fireReflection(BOT_INFLIGHT); // second call — same bot ID, must be a no-op

    await new Promise(r => setTimeout(r, 30));

    // getRecentClosedDecisions should be called at most once — the second call
    // was rejected by the in-flight guard before reaching the storage query.
    expect(mockStorage.getRecentClosedDecisions).toHaveBeenCalledTimes(1);
  });

  it("skips when realizedPnl is null (no outcome yet)", async () => {
    const BOT_NO_PNL: any = { ...BOT_STUB, id: "bot-reflect-nopnl-01" };
    mockStorage.getRecentClosedDecisions.mockResolvedValue([
      { ...DECISION_STUB, id: "dec-4", realizedPnl: null },
    ]);
    mockStorage.getWalletLlmApiKeyCiphertext.mockResolvedValue(null);

    fireReflection(BOT_NO_PNL);
    await new Promise(r => setTimeout(r, 30));

    // exits before key resolution — getWalletLlmApiKeyCiphertext never called
    expect(mockStorage.getWalletLlmApiKeyCiphertext).not.toHaveBeenCalled();
    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it("updates storage on successful reflection", async () => {
    const BOT_SUCCESS: any = { ...BOT_STUB, id: "bot-reflect-success-01", playbookVersion: 3 };
    mockStorage.getRecentClosedDecisions.mockResolvedValue([
      { ...DECISION_STUB, id: "dec-5", realizedPnl: "22.00" },
    ]);
    mockStorage.getWalletLlmApiKeyCiphertext.mockResolvedValue(Buffer.from("enc"));
    mockGetSession.mockReturnValue({ session: { umk: Buffer.from("umk") } });
    const rawKey = Buffer.from("sk-test-api-key");
    mockDecrypt.mockReturnValue(rawKey);
    mockCallLlm.mockResolvedValueOnce(VALID_TOOL_RESPONSE as any);
    mockStorage.updateAiTraderBot.mockResolvedValue({ ...BOT_SUCCESS, playbookVersion: 4 });

    fireReflection(BOT_SUCCESS);
    await new Promise(r => setTimeout(r, 50));

    expect(mockStorage.updateAiTraderBot).toHaveBeenCalledWith(
      BOT_SUCCESS.id,
      expect.objectContaining({
        playbook: [VALID_ENTRY],
        playbookVersion: 4, // 3 + 1
      })
    );
  });
});
