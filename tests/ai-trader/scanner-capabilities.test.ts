import { describe, expect, it } from "vitest";
import { parseScannerCapabilities } from "../../server/ai-trader/scanner-capabilities";

describe("scanner process capabilities", () => {
  const bools = [false, true] as const;

  for (const producerEnabled of bools) {
    for (const consumersEnabled of bools) {
      for (const liveExecutionEnabled of bools) {
        it(`parses producer=${producerEnabled} consumers=${consumersEnabled} live=${liveExecutionEnabled}`, () => {
          const capabilities = parseScannerCapabilities({
            SCANNER_ENABLED: producerEnabled ? undefined : "false",
            SCANNER_CONSUMERS_ENABLED: consumersEnabled ? "true" : undefined,
            SCANNER_LIVE_EXECUTION_ENABLED: liveExecutionEnabled ? "true" : undefined,
          });

          expect(capabilities).toEqual({
            producerEnabled,
            consumersEnabled,
            liveExecutionEnabled,
          });
          expect(Object.isFrozen(capabilities)).toBe(true);
        });
      }
    }
  }

  it("retains producer opt-out while refusing non-exact downstream opt-ins", () => {
    expect(parseScannerCapabilities({
      SCANNER_ENABLED: "typo",
      SCANNER_CONSUMERS_ENABLED: "TRUE",
      SCANNER_LIVE_EXECUTION_ENABLED: "1",
    })).toEqual({
      producerEnabled: true,
      consumersEnabled: false,
      liveExecutionEnabled: false,
    });
  });
});
