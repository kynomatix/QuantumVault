import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import { detachTradingBotAfterDriftCustodyHandoff } from "../../server/trading-bot-custody-handoff";

const base = (over: Record<string, unknown> = {}) => ({
  walletAddress: "wallet-1",
  agentPublicKey: "agent-generation-1",
  driftSubaccountId: 7,
  subaccountAuthMode: "main_plus_id",
  closeConfirmed: false,
  orphanReason: "close failed",
  createOrphanedSubaccount: vi.fn(async () => undefined),
  deleteTradingBot: vi.fn(async () => undefined),
  ...over,
});

describe("trading-bot delete custody handoff", () => {
  it("commits the orphan handoff before deleting an unclosed Drift bot", async () => {
    const args = base();
    const result = await detachTradingBotAfterDriftCustodyHandoff(args as any);

    expect(result).toEqual({
      deleted: true,
      orphanHandoffRequired: true,
      orphanHandoffComplete: true,
    });
    expect(args.createOrphanedSubaccount).toHaveBeenCalledWith({
      walletAddress: "wallet-1",
      agentPublicKey: "agent-generation-1",
      driftSubaccountId: 7,
      reason: "close failed",
    });
    expect(args.createOrphanedSubaccount.mock.invocationCallOrder[0])
      .toBeLessThan(args.deleteTradingBot.mock.invocationCallOrder[0]);
  });

  it("never deletes when the orphan insert fails", async () => {
    const args = base({
      createOrphanedSubaccount: vi.fn(async () => { throw new Error("generation CAS lost"); }),
    });
    await expect(detachTradingBotAfterDriftCustodyHandoff(args as any)).resolves.toEqual({
      deleted: false,
      orphanHandoffRequired: true,
      orphanHandoffComplete: false,
      blockedReason: "orphan_handoff_failed",
    });
    expect(args.deleteTradingBot).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("never deletes an unclosed Drift bot without a usable agent generation (%p)", async (agentPublicKey) => {
    const args = base({ agentPublicKey });
    const result = await detachTradingBotAfterDriftCustodyHandoff(args as any);
    expect(result.deleted).toBe(false);
    expect(result.blockedReason).toBe("missing_agent_generation");
    expect(args.createOrphanedSubaccount).not.toHaveBeenCalled();
    expect(args.deleteTradingBot).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN])("blocks malformed linked Drift id %p instead of treating it as detached", async (driftSubaccountId) => {
    const args = base({ driftSubaccountId, closeConfirmed: true });
    const result = await detachTradingBotAfterDriftCustodyHandoff(args as any);
    expect(result.blockedReason).toBe("invalid_subaccount_id");
    expect(args.createOrphanedSubaccount).not.toHaveBeenCalled();
    expect(args.deleteTradingBot).not.toHaveBeenCalled();
  });

  it.each([
    { label: "confirmed close", closeConfirmed: true },
    { label: "main account", driftSubaccountId: 0 },
    { label: "no linkage", driftSubaccountId: null },
    { label: "external-key custody", subaccountAuthMode: "external_key" },
  ])("deletes without manufacturing a Drift orphan for $label", async (over) => {
    const args = base(over);
    const result = await detachTradingBotAfterDriftCustodyHandoff(args as any);
    expect(result).toEqual({
      deleted: true,
      orphanHandoffRequired: false,
      orphanHandoffComplete: false,
    });
    expect(args.createOrphanedSubaccount).not.toHaveBeenCalled();
    expect(args.deleteTradingBot).toHaveBeenCalledTimes(1);
  });

  it("leaves the durable orphan in place if the subsequent delete throws", async () => {
    const args = base({
      deleteTradingBot: vi.fn(async () => { throw new Error("delete failed"); }),
    });
    await expect(detachTradingBotAfterDriftCustodyHandoff(args as any)).rejects.toThrow("delete failed");
    expect(args.createOrphanedSubaccount).toHaveBeenCalledTimes(1);
    expect(args.createOrphanedSubaccount.mock.invocationCallOrder[0])
      .toBeLessThan(args.deleteTradingBot.mock.invocationCallOrder[0]);
  });

  it("wires both missed routes through the custody helper before their final delete", () => {
    const source = readFileSync(resolve(__dirname, "../../server/routes.ts"), "utf8");
    const forceStart = source.indexOf('app.delete("/api/trading-bots/:id/force"');
    const confirmStart = source.indexOf('app.post("/api/trading-bots/:id/confirm-delete"');
    const tradesStart = source.indexOf('app.get("/api/trading-bots/:id/trades"');
    const forceRoute = source.slice(forceStart, confirmStart);
    const confirmRoute = source.slice(confirmStart, tradesStart);
    const lowBalance = forceRoute.slice(
      forceRoute.indexOf("if (balance <= 0.01)"),
      forceRoute.indexOf("// Auto-sweep"),
    );
    const sweptBalance = forceRoute.slice(
      forceRoute.indexOf("// Auto-sweep"),
      forceRoute.indexOf("// Subaccount 0 or no encrypted key"),
    );

    expect(lowBalance).toContain("detachTradingBotAfterDriftCustodyHandoff");
    expect(lowBalance).not.toContain("await storage.deleteTradingBot(req.params.id)");
    expect(sweptBalance).toContain("detachTradingBotAfterDriftCustodyHandoff");
    expect(sweptBalance).not.toContain("await storage.deleteTradingBot(req.params.id)");
    expect(confirmRoute).toContain("detachTradingBotAfterDriftCustodyHandoff");
    expect(confirmRoute).not.toContain("await storage.deleteTradingBot(req.params.id)");
  });
});
