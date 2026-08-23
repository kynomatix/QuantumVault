import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "client/src/components/AiTraderPerformanceChart.tsx"),
  "utf8",
);

describe("AI Trader immutable qualification equity chart", () => {
  it("plots the frozen equity series without substituting the mutable performance feed", () => {
    expect(source).toContain("QualificationEquityPoint");
    expect(source).toContain('data-testid="ai-trader-qualification-equity-chart"');
    expect(source).toContain('dataKey="equity"');
    expect(source).toContain("<ReferenceLine y={start}");
    expect(source).toContain("isAnimationActive={false}");
    expect(source).not.toContain("/api/ai-trader");
  });

  it("fails open to an explicit unavailable label for an unusable retained series", () => {
    expect(source).toContain("data.length < 2");
    expect(source).toContain("Immutable equity series unavailable.");
    expect(source).toContain("Number.isFinite(point.equity)");
  });
});
