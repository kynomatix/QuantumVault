import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("trade retry close fee accounting wiring", () => {
  const source = readFileSync(new URL("../../server/trade-retry-service.ts", import.meta.url), "utf8");

  it("propagates the adapter fee and classified close evidence through the retry wrapper", () => {
    expect(source).toContain("actualFee: orderResult.fee");
    expect(source).toContain("closeFeeEvidence,");
    expect(source).toContain("classifyCloseFeeEvidence({");
    expect(source).toContain("resolveFeeRateQuote(adapter");
  });

  it("uses nullish exact-fee semantics and never restores the legacy close-rate constant", () => {
    expect(source).not.toContain("getExchangeFeeRate");
    expect(source).not.toContain("result.actualFee ||");
    expect(source).toContain("result.actualFee ?? notional * result.admissionFeeQuote!.effectiveRate");
    expect(source).toContain("closeFeeAmount(result.closeFeeEvidence");
  });

  it("writes explicit SQL-null-bound values and does not backfill unknown closes", () => {
    expect(source).toContain("fee: fee === null ? null : fee.toString()");
    expect(source).toContain("exact close fee unavailable, skipping");
    expect(source).toContain("fee ?? 0,");
  });
});
