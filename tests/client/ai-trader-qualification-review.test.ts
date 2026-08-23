import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const component = readFileSync(
  resolve(process.cwd(), "client/src/components/AiTraderQualificationReview.tsx"),
  "utf8",
);
const drawer = readFileSync(
  resolve(process.cwd(), "client/src/components/AiTraderDrawer.tsx"),
  "utf8",
);

describe("AI Trader immutable qualification review", () => {
  it("distinguishes truthful available, waived, pending, legacy, and transport states", () => {
    for (const id of [
      "qualification-review-available",
      "qualification-review-waived",
      "qualification-review-pending",
      "qualification-review-legacy-unavailable",
      "qualification-review-error",
    ]) expect(component).toContain(id);
    expect(component).toContain("predates immutable qualification records");
    expect(component).toContain("has not been reconstructed");
    expect(component).toContain("Qualification was explicitly waived");
  });

  it("labels historical and unavailable observations without presenting them as live truth", () => {
    expect(component).toContain("Historical max drawdown");
    expect(component).toContain("Latest retained leverage observation");
    expect(component).toContain("Leverage observation unavailable");
    expect(component).toContain("Volatility proxy unavailable");
    expect(component).toContain("record.evidenceSourceDigest");
    expect(component).not.toContain("current leverage");
  });

  it("uses the authenticated owner route and renders in the Record tab", () => {
    expect(drawer).toContain("`/api/ai-trader/${botId}/qualification-review`");
    expect(drawer).toContain("credentials: 'include'");
    expect(drawer).toContain("headers: walletAuthHeaders()");
    const tab = drawer.indexOf('<TabsContent value="track-record"');
    const review = drawer.indexOf("<AiTraderQualificationReview", tab);
    const headline = drawer.indexOf('data-testid="track-record-net-pnl"', tab);
    expect(review).toBeGreaterThan(tab);
    expect(review).toBeLessThan(headline);
  });
});
