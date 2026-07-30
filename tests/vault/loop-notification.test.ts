import { describe, expect, it } from "vitest";
import { formatLoopSafetyMessage } from "../../server/notification-service";

describe("SOL-loop notification copy", () => {
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
