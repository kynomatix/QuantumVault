import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveTradePriceDisplay } from "../../client/src/components/TradeHistoryModal";
import {
  formatCapitalAmount,
  resolveCapitalAccountingWarning,
} from "../../client/src/components/DepositWithdraw";
import {
  deriveKnownBotEquity,
  resolveUnknownAccountingSettingsAuthority,
  resolveWithdrawalAuthority,
} from "../../client/src/components/BotManagementDrawer";

describe("accounting-incomplete client surfaces", () => {
  it("never presents an observation-context price as a venue fill", () => {
    expect(resolveTradePriceDisplay({
      price: "101.25",
      webhookPayload: {
        priceRole: "observation_context_only",
        closeAccounting: { kind: "unavailable" },
      },
    })).toEqual({
      value: null,
      label: "--",
      exportValue: "",
      note: "observation only; venue fill unavailable",
    });
    expect(resolveTradePriceDisplay({ price: "101.25", webhookPayload: {} })).toEqual({
      value: 101.25,
      label: "$101.25",
      exportValue: "101.25",
      note: "",
    });
  });

  it("uses the same unavailable provenance in both UI layouts, clipboard text, and CSV", () => {
    const source = readFileSync("client/src/components/TradeHistoryModal.tsx", "utf8");
    expect(source.match(/resolveTradePriceDisplay\(trade\)/g)).toHaveLength(3);
    expect(source).toContain("price: priceDisplay.exportValue");
    expect(source).toContain("priceNote: priceDisplay.note");
    expect(source).toContain("'Price basis'");
    expect(source).not.toContain('${Number(trade.price).toLocaleString()}');
  });

  it("keeps drawer accounting unknown through display and withdrawal authority", () => {
    expect(deriveKnownBotEquity(null, 50, 10)).toBeNull();
    expect(deriveKnownBotEquity(100, 50, 10)).toBe(140);
    expect(resolveWithdrawalAuthority(null, 1)).toEqual({ allowed: false, reason: "accounting_unavailable" });
    expect(resolveWithdrawalAuthority(5, 6)).toEqual({ allowed: false, reason: "exceeds_available" });
    expect(resolveWithdrawalAuthority(5, 5)).toEqual({ allowed: true, reason: null });
    const source = readFileSync("client/src/components/BotManagementDrawer.tsx", "utf8");
    expect(source).toContain("Withdrawal unavailable: accounting balance is incomplete.");
    expect(source).toContain("Bot equity: -- (accounting unavailable). Position sizing is disabled.");
    expect(source).not.toContain("setBotBalance(data.usdcBalance ?? 0)");
    expect(source).not.toContain("setExchangeFreeCollateral(data.freeCollateral ?? 0)");
    const appSource = readFileSync("client/src/pages/App.tsx", "utf8");
    expect(appSource).not.toContain("balance: data.usdcBalance ?? 0");
    expect(appSource).toContain("delete-bot-balance-unavailable");
    expect(appSource).toContain("No zero balance is assumed and no withdrawal amount is promised.");
  });

  it("allows de-risking but refuses leverage or cap increases while accounting is unavailable", () => {
    const base = {
      accountingAvailable: false,
      currentLeverage: 5,
      currentMaxPositionSize: 1_000,
    };
    expect(resolveUnknownAccountingSettingsAuthority({
      ...base,
      nextLeverage: 4,
      nextMaxPositionSize: 800,
    })).toEqual({ allowed: true, reason: null });
    expect(resolveUnknownAccountingSettingsAuthority({
      ...base,
      nextLeverage: 6,
      nextMaxPositionSize: 800,
    })).toEqual({ allowed: false, reason: "accounting_unavailable_for_risk_increase" });
    expect(resolveUnknownAccountingSettingsAuthority({
      ...base,
      nextLeverage: 4,
      nextMaxPositionSize: 1_200,
    })).toEqual({ allowed: false, reason: "accounting_unavailable_for_risk_increase" });
    expect(resolveUnknownAccountingSettingsAuthority({
      ...base,
      nextLeverage: 4,
      nextMaxPositionSize: null,
    })).toEqual({ allowed: false, reason: "accounting_unavailable_for_risk_increase" });
  });

  it("uses shared price provenance in the dashboard recent-trades table", () => {
    const source = readFileSync("client/src/pages/App.tsx", "utf8");
    expect(source).toContain("TradeHistoryModal, resolveTradePriceDisplay");
    expect(source).toContain("const priceDisplay = resolveTradePriceDisplay(trade)");
    expect(source).toContain("{priceDisplay.label}");
    expect(source).not.toContain("`$${priceDisplay.label}`");
    expect(source).not.toContain("${Number(trade.price).toLocaleString()}");
  });

  it("renders unknown capital as unavailable rather than zero", () => {
    expect(formatCapitalAmount(null)).toBe("--");
    expect(formatCapitalAmount(undefined)).toBe("--");
    expect(formatCapitalAmount(12.5)).toBe("$12.50");
    expect(resolveCapitalAccountingWarning({
      mainAccountBalance: 10,
      allocatedToBot: 5,
      totalEquity: 15,
      accountingIncompleteCloseCount: 0,
      realizedAccountingStatus: "complete",
      capitalBalanceStatus: "available",
    })).toBeNull();
    expect(resolveCapitalAccountingWarning({
      mainAccountBalance: null,
      allocatedToBot: null,
      totalEquity: 15,
      accountingIncompleteCloseCount: 2,
      realizedAccountingStatus: "incomplete",
      capitalBalanceStatus: "unavailable",
    })).toBe("Realized accounting is incomplete for 2 close event(s); derived balances are unavailable.");
    expect(resolveCapitalAccountingWarning({
      mainAccountBalance: null,
      allocatedToBot: null,
      totalEquity: 15,
      accountingIncompleteCloseCount: 0,
      realizedAccountingStatus: "incomplete",
      capitalBalanceStatus: "unavailable",
    })).toBe("Derived balances are unavailable.");
    const source = readFileSync("client/src/components/DepositWithdraw.tsx", "utf8");
    expect(source).toContain("text-capital-accounting-incomplete");
    expect(source).not.toContain("capitalPool?.mainAccountBalance ?? 0");
    expect(source).not.toContain("capitalPool?.allocatedToBot ?? 0");
  });
});
