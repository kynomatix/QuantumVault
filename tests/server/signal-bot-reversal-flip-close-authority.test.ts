import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  deferSignalBotFlipOpen,
  markSignalBotFlipOpenExecuted,
  rejectSignalBotFlipOpen,
  resolveSignalBotFlipCloseThenOpen,
  type SignalBotFlipAuthorityRead,
  type SignalBotFlipCloseExecution,
  type SignalBotFlipPosition,
} from "../../server/trading/signal-bot-close-integrity";
import { classifySignal, type ClassifiedSignal } from "../../server/trading/signal-classifier";

function classifiedFlip(side: "LONG" | "SHORT"): ClassifiedSignal & { type: "FLIP" } {
  const signal = classifySignal(
    { side, size: 3, entryPrice: 100 },
    {
      action: side === "LONG" ? "sell" : "buy",
      contracts: 4,
      strategyPositionSize: side === "LONG" ? -1 : 1,
    },
  );
  expect(signal.type).toBe("FLIP");
  return signal as ClassifiedSignal & { type: "FLIP" };
}

function position(
  side: "LONG" | "SHORT" = "LONG",
  source: SignalBotFlipPosition["source"] = "venue_authoritative",
): SignalBotFlipPosition {
  return { side, size: 3, entryPrice: 100, source };
}

function signedClose(signature = "close-signature"): SignalBotFlipCloseExecution {
  return {
    success: true,
    signature,
    fillPrice: 101,
    executionMethod: "test",
    feeEvidence: { kind: "venue_exact", amount: 0.25, protocol: "pacifica" },
  };
}

describe("shared Signal Bot FLIP close-then-open resolver", () => {
  it.each(["LONG", "SHORT"] as const)(
    "closes %s from the validated durable fallback exactly once, confirms venue flat, then admits the open",
    async side => {
      const fallback = position(side, "durable_risk_reducing_fallback");
      const reads: SignalBotFlipAuthorityRead[] = [
        { kind: "position", position: fallback },
        { kind: "authoritative_flat" },
      ];
      const readAuthority = vi.fn(async (_stage: "initial" | "post_close") => reads.shift()!);
      const executeReduceOnlyClose = vi.fn().mockResolvedValue(signedClose());
      const finalizeConfirmedClose = vi.fn().mockResolvedValue(undefined);

      const result = await resolveSignalBotFlipCloseThenOpen({
        classifiedSignal: classifiedFlip(side),
        readAuthority,
        executeReduceOnlyClose,
        finalizeConfirmedClose,
      });

      expect(readAuthority).toHaveBeenNthCalledWith(1, "initial");
      expect(readAuthority).toHaveBeenNthCalledWith(2, "post_close");
      expect(executeReduceOnlyClose).toHaveBeenCalledOnce();
      expect(executeReduceOnlyClose).toHaveBeenCalledWith(fallback);
      expect(finalizeConfirmedClose).toHaveBeenCalledOnce();
      expect(result.close).toMatchObject({ kind: "executed", signature: "close-signature" });
      expect(result.open).toEqual({ kind: "admitted" });
    },
  );

  it("lets a fresh authoritative venue flat evaluate the open without submitting or fabricating a close", async () => {
    const executeReduceOnlyClose = vi.fn();
    const finalizeConfirmedClose = vi.fn();
    const result = await resolveSignalBotFlipCloseThenOpen({
      classifiedSignal: classifiedFlip("LONG"),
      readAuthority: vi.fn().mockResolvedValue({ kind: "authoritative_flat" }),
      executeReduceOnlyClose,
      finalizeConfirmedClose,
    });

    expect(result).toEqual({ close: { kind: "authoritative_flat" }, open: { kind: "admitted" } });
    expect(executeReduceOnlyClose).not.toHaveBeenCalled();
    expect(finalizeConfirmedClose).not.toHaveBeenCalled();
  });

  it("keeps exhausted position authority distinct from flat and never evaluates the open", async () => {
    const executeReduceOnlyClose = vi.fn();
    const finalizeConfirmedClose = vi.fn();
    const result = await resolveSignalBotFlipCloseThenOpen({
      classifiedSignal: classifiedFlip("SHORT"),
      readAuthority: vi.fn().mockResolvedValue({ kind: "unavailable", reason: "strict and fallback unavailable" }),
      executeReduceOnlyClose,
      finalizeConfirmedClose,
    });

    expect(result).toEqual({
      close: { kind: "position_unavailable", reason: "strict and fallback unavailable" },
      open: { kind: "not_evaluated", reason: "position_unavailable" },
    });
    expect(executeReduceOnlyClose).not.toHaveBeenCalled();
    expect(finalizeConfirmedClose).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "no signature",
      close: {
        success: true,
        signature: null,
        feeEvidence: { kind: "unavailable", reason: "no_signature" },
      } satisfies SignalBotFlipCloseExecution,
      post: { kind: "authoritative_flat" } satisfies SignalBotFlipAuthorityRead,
      expected: "no_signature",
      reads: 1,
    },
    {
      name: "partial residual",
      close: signedClose(),
      post: { kind: "position", position: position("SHORT") } satisfies SignalBotFlipAuthorityRead,
      expected: "partial",
      reads: 2,
    },
    {
      name: "post-close unreadable",
      close: signedClose(),
      post: { kind: "unavailable", reason: "venue timeout" } satisfies SignalBotFlipAuthorityRead,
      expected: "post_close_unreadable",
      reads: 2,
    },
  ])("forbids accounting and the opposite open after $name", async ({ close, post, expected, reads }) => {
    const readAuthority = vi.fn()
      .mockResolvedValueOnce({ kind: "position", position: position("LONG") })
      .mockResolvedValueOnce(post);
    const finalizeConfirmedClose = vi.fn();
    const result = await resolveSignalBotFlipCloseThenOpen({
      classifiedSignal: classifiedFlip("LONG"),
      readAuthority,
      executeReduceOnlyClose: vi.fn().mockResolvedValue(close),
      finalizeConfirmedClose,
    });

    expect(result.close.kind).toBe(expected);
    expect(result.open.kind).toBe("not_evaluated");
    expect(readAuthority).toHaveBeenCalledTimes(reads);
    expect(finalizeConfirmedClose).not.toHaveBeenCalled();
  });

  it("forbids the open when authoritative close finalization fails", async () => {
    const result = await resolveSignalBotFlipCloseThenOpen({
      classifiedSignal: classifiedFlip("LONG"),
      readAuthority: vi.fn()
        .mockResolvedValueOnce({ kind: "position", position: position("LONG") })
        .mockResolvedValueOnce({ kind: "authoritative_flat" }),
      executeReduceOnlyClose: vi.fn().mockResolvedValue(signedClose()),
      finalizeConfirmedClose: vi.fn().mockRejectedValue(new Error("atomic finalization failed")),
    });

    expect(result.close).toMatchObject({ kind: "finalization_failed", signature: "close-signature" });
    expect(result.open).toEqual({ kind: "not_evaluated", reason: "confirmed_close_finalization_failed" });
  });

  it("reports a confirmed close and a later open rejection as two distinct terminals", async () => {
    const resolved = await resolveSignalBotFlipCloseThenOpen({
      classifiedSignal: classifiedFlip("LONG"),
      readAuthority: vi.fn()
        .mockResolvedValueOnce({ kind: "position", position: position("LONG") })
        .mockResolvedValueOnce({ kind: "authoritative_flat" }),
      executeReduceOnlyClose: vi.fn().mockResolvedValue(signedClose()),
      finalizeConfirmedClose: vi.fn().mockResolvedValue(undefined),
    });

    const rejected = rejectSignalBotFlipOpen(resolved, "funding", "insufficient collateral");
    expect(rejected.close.kind).toBe("executed");
    expect(rejected.open).toEqual({
      kind: "rejected",
      category: "funding",
      reason: "insufficient collateral",
    });
    expect(deferSignalBotFlipOpen(resolved, "entry claim busy").open).toEqual({
      kind: "deferred",
      reason: "entry claim busy",
    });
    expect(markSignalBotFlipOpenExecuted(resolved, "open-signature").open).toEqual({
      kind: "executed",
      signature: "open-signature",
    });
  });
});

describe("FLIP route wiring", () => {
  const routes = readFileSync(new URL("../../server/routes.ts", import.meta.url), "utf8");

  it("delegates per-bot, user-webhook, and subscriber reversals to one shared resolver adapter", () => {
    expect(routes.match(/await executeSignalBotFlipClose\(/g)).toHaveLength(3);
    expect(routes).toContain('executionLabel: "per_bot"');
    expect(routes).toContain('executionLabel: "user_webhook"');
    expect(routes).toContain('executionLabel: "subscriber"');
    expect(routes.match(/getPositionForCloseAuthority\(/g)).toHaveLength(3);
    expect(routes.match(/getRiskReducingCachedCloseFallback\(/g)).toHaveLength(3);
    expect(routes.match(/confirmedPositionClose:\s*\{/g)).toHaveLength(2);
  });

  it("removes the legacy venue-read FLIP re-derivation and failed-read-to-FLAT path", () => {
    expect(routes).not.toContain("isPositionFlip");
    expect(routes).not.toContain("Could not fetch on-chain position, assuming flat");
    expect(routes).toContain("The classifier's FLIP verdict is authoritative");
  });

  it("classifies before applying direction and carries each subscriber's own classification", () => {
    const perBotClassifier = routes.indexOf("const classifiedSignal = classifySignal(");
    const perBotFlipDirection = routes.indexOf('if (bot.side !== "both" && bot.side !== side)', perBotClassifier);
    const userClassifier = routes.indexOf("const uwClassified = classifySignal(");
    const userFlipDirection = routes.indexOf('if (bot.side !== "both" && bot.side !== side)', userClassifier);

    expect(perBotClassifier).toBeGreaterThan(0);
    expect(perBotFlipDirection).toBeGreaterThan(perBotClassifier);
    expect(userClassifier).toBeGreaterThan(0);
    expect(userFlipDirection).toBeGreaterThan(userClassifier);
    expect(routes).toContain("const subscriberClassified = classifySignal(");
    expect(routes).toContain("const subscriberFlip = subscriberClassified.type === 'FLIP'");
    expect(routes).not.toContain("signal.isFlipSignal === true || subscriberClassified.type === 'FLIP'");
    expect(routes).toContain("Dispatch the reversal intent once, before source close");
    expect(routes.match(/isFlipSignal: true,/g)).toHaveLength(2);
    expect(routes).toContain("if (!isFlipSignal) {");
    expect(routes).toContain("if (!uwIsFlipSignal) {");
  });
});
