import { describe, expect, it } from "vitest";
import {
  formatBorrowHealthMessage,
  formatLoopSafetyMessage,
} from "../../server/notification-service";

describe("SOL-loop notification copy", () => {
  it("truthfully reports an unreadable managed-loop safety check without transaction or exposure claims", () => {
    const message = formatBorrowHealthMessage({
      scopeLabel: "Account",
      collateralLabel: "JitoSOL",
      context: "managed_loop",
      band: "unavailable",
      healthFactor: null,
      ltv: null,
      reasonCode: "exchange_price_unavailable",
    });

    expect(message.title).toBe("Loop Safety Check Unreadable");
    expect(message.body).toContain("Automatic loop safety could not assess");
    expect(message.body).toContain("No automatic safety adjustment was attempted");
    expect(message.body).toContain("Monitoring will continue");
    expect(message.body).toContain("review the position manually");
    expect(message.body).toContain("Cause: the vault accrual prices could not be read.");
    expect(message.body).not.toMatch(/wallet|row|signature|transaction|is safe|closed|liquidat/i);
  });

  it("adds a bounded cause to classic unreadable loan copy without raw infrastructure detail", () => {
    const message = formatBorrowHealthMessage({
      scopeLabel: "Account",
      collateralLabel: "INF",
      context: "borrow",
      band: "unavailable",
      healthFactor: null,
      ltv: null,
      reasonCode: "position_read_failed",
    });

    expect(message.title).toContain("Loan Health Unreadable");
    expect(message.body).toContain("Cause: the on-chain position read did not complete.");
    expect(message.body).not.toMatch(/wallet|row|signature|transaction|rpc|endpoint|exception/i);
  });

  it("describes the destination loop as active without claiming continuous vault custody", () => {
    const message = formatLoopSafetyMessage({
      symbol: "JitoSOL",
      action: "hop",
      ok: true,
      reason: "automatic rotation recovery completed",
      detail: null,
    });

    expect(message.title).toBe("🔀 Loop Hopped");
    expect(message.body).toContain("JitoSOL loop is now active");
    expect(message.body).toContain("automatic monitoring continues");
    expect(message.body).not.toContain("stayed in the vault the whole time");
  });
});
