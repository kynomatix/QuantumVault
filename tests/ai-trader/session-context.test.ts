// Phase 1A acceptance tests for server/ai-trader/session-context.ts.
// Pure function — no mocks, no I/O, fully deterministic.
//
// Reference week used throughout (ISO 8601 UTC):
//   Mon 2026-01-05 … Fri 2026-01-09 … Sat 2026-01-10 … Sun 2026-01-11 … Mon 2026-01-12

import { describe, it, expect } from "vitest";
import { getSessionContext } from "../../server/ai-trader/session-context";

function d(iso: string) {
  return new Date(iso);
}

// ─── Weekend boundary ─────────────────────────────────────────────────────────

describe("weekend boundaries", () => {
  it("is new_york one minute before Fri 21:00 (not yet weekend)", () => {
    const r = getSessionContext(d("2026-01-09T20:59:00Z")); // Fri 20:59
    expect(r.label).toBe("new_york");
  });

  it("enters weekend exactly at Fri 21:00", () => {
    const r = getSessionContext(d("2026-01-09T21:00:00Z")); // Fri 21:00
    expect(r.label).toBe("weekend");
    expect(r.block).toContain("weekend");
  });

  it("is weekend mid-Saturday", () => {
    const r = getSessionContext(d("2026-01-10T12:00:00Z")); // Sat 12:00
    expect(r.label).toBe("weekend");
  });

  it("is weekend at Sun 20:59 (one minute before end)", () => {
    const r = getSessionContext(d("2026-01-11T20:59:00Z")); // Sun 20:59
    expect(r.label).toBe("weekend");
  });

  it("exits weekend exactly at Sun 21:00 — becomes asia", () => {
    const r = getSessionContext(d("2026-01-11T21:00:00Z")); // Sun 21:00
    expect(r.label).toBe("asia");
  });

  it("is asia one minute after Sun 21:00", () => {
    const r = getSessionContext(d("2026-01-11T21:01:00Z")); // Sun 21:01
    expect(r.label).toBe("asia");
  });
});

// ─── Non-weekend session boundaries (Tuesday 2026-01-06) ─────────────────────

describe("session handoff boundaries (Tuesday UTC)", () => {
  it("midnight is asia (daily open, Asia session continues)", () => {
    const r = getSessionContext(d("2026-01-06T00:00:00Z"));
    expect(r.label).toBe("asia");
  });

  it("06:59 is asia", () => {
    expect(getSessionContext(d("2026-01-06T06:59:00Z")).label).toBe("asia");
  });

  it("07:00 enters asia_london overlap", () => {
    expect(getSessionContext(d("2026-01-06T07:00:00Z")).label).toBe("asia_london");
  });

  it("08:59 is still asia_london overlap", () => {
    expect(getSessionContext(d("2026-01-06T08:59:00Z")).label).toBe("asia_london");
  });

  it("09:00 enters london", () => {
    expect(getSessionContext(d("2026-01-06T09:00:00Z")).label).toBe("london");
  });

  it("13:29 is still london", () => {
    expect(getSessionContext(d("2026-01-06T13:29:00Z")).label).toBe("london");
  });

  it("13:30 enters london_new_york overlap", () => {
    expect(getSessionContext(d("2026-01-06T13:30:00Z")).label).toBe("london_new_york");
  });

  it("15:59 is still london_new_york overlap", () => {
    expect(getSessionContext(d("2026-01-06T15:59:00Z")).label).toBe("london_new_york");
  });

  it("16:00 enters new_york", () => {
    expect(getSessionContext(d("2026-01-06T16:00:00Z")).label).toBe("new_york");
  });

  it("20:59 is still new_york", () => {
    expect(getSessionContext(d("2026-01-06T20:59:00Z")).label).toBe("new_york");
  });

  it("21:00 returns to asia (NY session ends)", () => {
    expect(getSessionContext(d("2026-01-06T21:00:00Z")).label).toBe("asia");
  });

  it("23:59 is asia (late evening before midnight)", () => {
    expect(getSessionContext(d("2026-01-06T23:59:00Z")).label).toBe("asia");
  });
});

// Friday session: only goes to 21:00 before weekend kicks in.
describe("Friday session transitions", () => {
  it("Fri 16:00 is new_york", () => {
    expect(getSessionContext(d("2026-01-09T16:00:00Z")).label).toBe("new_york");
  });

  it("Fri 20:59 is new_york", () => {
    expect(getSessionContext(d("2026-01-09T20:59:00Z")).label).toBe("new_york");
  });

  it("Fri 21:00 is weekend (not asia)", () => {
    expect(getSessionContext(d("2026-01-09T21:00:00Z")).label).toBe("weekend");
  });
});

// Sunday session: Asia picks up from 21:00 through midnight.
describe("Sunday 21:00+ Asia continuation", () => {
  it("Sun 22:00 is asia", () => {
    expect(getSessionContext(d("2026-01-11T22:00:00Z")).label).toBe("asia");
  });

  it("Sun 23:59 is asia", () => {
    expect(getSessionContext(d("2026-01-11T23:59:00Z")).label).toBe("asia");
  });
});

// ─── Weekly open proximity (Mon 00:00 UTC = weekly candle open) ───────────────

describe("weekly open proximity edges (Mon 00:00 UTC, window = −12h to +2h)", () => {
  it("Sun 11:59 is NOT near weekly open (721 min away, > 720)", () => {
    const r = getSessionContext(d("2026-01-11T11:59:00Z")); // Sun 11:59 — 1 min before window
    expect(r.nearWeeklyOpen).toBe(false);
    expect(r.block).not.toContain("Weekly");
  });

  it("Sun 12:00 IS near weekly open (exactly 720 min = 12h before)", () => {
    const r = getSessionContext(d("2026-01-11T12:00:00Z")); // Sun 12:00 — edge of −12h window
    expect(r.nearWeeklyOpen).toBe(true);
    expect(r.block).toContain("Weekly");
  });

  it("Sun 12:01 is near weekly open (719 min away)", () => {
    expect(getSessionContext(d("2026-01-11T12:01:00Z")).nearWeeklyOpen).toBe(true);
  });

  it("Mon 01:59 is near weekly open (119 min after = within +2h)", () => {
    expect(getSessionContext(d("2026-01-12T01:59:00Z")).nearWeeklyOpen).toBe(true);
  });

  it("Mon 02:00 IS near weekly open (exactly 120 min = 2h after)", () => {
    const r = getSessionContext(d("2026-01-12T02:00:00Z")); // Mon 02:00 — edge of +2h window
    expect(r.nearWeeklyOpen).toBe(true);
  });

  it("Mon 02:01 is NOT near weekly open (121 min after, > 120)", () => {
    const r = getSessionContext(d("2026-01-12T02:01:00Z")); // Mon 02:01 — 1 min past window
    expect(r.nearWeeklyOpen).toBe(false);
    expect(r.block).not.toContain("Weekly candle");
  });

  it("mid-week (Wed 12:00) is not near weekly open", () => {
    expect(getSessionContext(d("2026-01-07T12:00:00Z")).nearWeeklyOpen).toBe(false);
  });

  it("proximity line says 'opens in' before Mon 00:00", () => {
    const r = getSessionContext(d("2026-01-11T23:00:00Z")); // Sun 23:00 — 60 min before
    expect(r.nearWeeklyOpen).toBe(true);
    expect(r.block).toContain("opens in");
  });

  it("proximity line says 'opened' after Mon 00:00 passes", () => {
    const r = getSessionContext(d("2026-01-12T01:00:00Z")); // Mon 01:00 — 60 min after
    expect(r.nearWeeklyOpen).toBe(true);
    expect(r.block).toContain("opened");
  });
});

// ─── Daily open proximity (00:00 UTC, window = ±1h) ──────────────────────────

describe("daily open proximity edges (00:00 UTC, window = ±1h)", () => {
  it("22:59 is NOT near daily open (61 min before, > 60)", () => {
    const r = getSessionContext(d("2026-01-06T22:59:00Z")); // Tue 22:59
    expect(r.nearDailyOpen).toBe(false);
  });

  it("23:00 IS near daily open (exactly 60 min before)", () => {
    const r = getSessionContext(d("2026-01-06T23:00:00Z")); // Tue 23:00 — edge
    expect(r.nearDailyOpen).toBe(true);
  });

  it("23:01 is near daily open (59 min before)", () => {
    expect(getSessionContext(d("2026-01-06T23:01:00Z")).nearDailyOpen).toBe(true);
  });

  it("00:00 exactly is near daily open (just opened)", () => {
    expect(getSessionContext(d("2026-01-06T00:00:00Z")).nearDailyOpen).toBe(true);
  });

  it("01:00 IS near daily open (exactly 60 min after)", () => {
    expect(getSessionContext(d("2026-01-06T01:00:00Z")).nearDailyOpen).toBe(true);
  });

  it("01:01 is NOT near daily open (61 min after, > 60)", () => {
    const r = getSessionContext(d("2026-01-06T01:01:00Z")); // Tue 01:01
    expect(r.nearDailyOpen).toBe(false);
  });

  it("mid-day (12:00) is not near daily open", () => {
    expect(getSessionContext(d("2026-01-06T12:00:00Z")).nearDailyOpen).toBe(false);
  });

  it("daily proximity fires on weekends too (Sat 23:30)", () => {
    const r = getSessionContext(d("2026-01-10T23:30:00Z")); // Sat 23:30
    expect(r.label).toBe("weekend");
    expect(r.nearDailyOpen).toBe(true);
  });

  it("proximity line says 'opens in' before midnight", () => {
    const r = getSessionContext(d("2026-01-06T23:30:00Z")); // Tue 23:30 — 30 min before
    expect(r.nearDailyOpen).toBe(true);
    expect(r.block).toContain("opens in");
  });

  it("proximity line says 'opened' after midnight passes", () => {
    const r = getSessionContext(d("2026-01-06T00:30:00Z")); // Tue 00:30 — 30 min after
    expect(r.nearDailyOpen).toBe(true);
    expect(r.block).toContain("opened");
  });
});

// ─── Combined weekly + daily (Mon 00:00 both open simultaneously) ─────────────

describe("combined weekly and daily open proximity near Mon 00:00", () => {
  it("Sun 23:30 — both weekly and daily near (30 min before Mon 00:00)", () => {
    const r = getSessionContext(d("2026-01-11T23:30:00Z")); // Sun 23:30
    expect(r.nearWeeklyOpen).toBe(true);
    expect(r.nearDailyOpen).toBe(true);
  });

  it("combined block uses 'Weekly/daily' label when both near", () => {
    const r = getSessionContext(d("2026-01-11T23:14:00Z")); // Sun 23:14
    expect(r.nearWeeklyOpen).toBe(true);
    expect(r.nearDailyOpen).toBe(true);
    expect(r.block).toContain("Weekly/daily candle");
  });

  it("advisory mentions 'Weekly/daily opens' when both fire", () => {
    const r = getSessionContext(d("2026-01-11T23:14:00Z"));
    expect(r.block).toContain("Weekly/daily opens frequently print false moves");
  });

  it("Mon 00:30 — both flags still active (within their respective windows)", () => {
    const r = getSessionContext(d("2026-01-12T00:30:00Z")); // Mon 00:30 — 30 min after
    expect(r.nearWeeklyOpen).toBe(true); // within +2h of weekly open
    expect(r.nearDailyOpen).toBe(true);  // within +1h of daily open
  });
});

// ─── Weekly-only proximity (Sun afternoon, > 1h before midnight) ──────────────

describe("weekly-only proximity (Sun afternoon — past −12h weekly window start, but before daily window)", () => {
  it("Sun 15:00 — only weekly near, daily not active", () => {
    const r = getSessionContext(d("2026-01-11T15:00:00Z")); // Sun 15:00
    // mWeekly = Mon 00:00 - Sun 15:00 = 9h = 540 min → ≤ 720 → near
    // mDaily: mod=900, 900>720, 1440-900=540 → 540>60 → NOT near
    expect(r.nearWeeklyOpen).toBe(true);
    expect(r.nearDailyOpen).toBe(false);
    expect(r.block).toContain("Weekly candle");
    expect(r.block).not.toContain("Weekly/daily candle");
  });
});

// ─── Daily-only proximity (non-Monday, far from weekly open) ──────────────────

describe("daily-only proximity (Tuesday midnight boundary — not Monday)", () => {
  it("Tue 23:30 — daily near, weekly not near", () => {
    const r = getSessionContext(d("2026-01-06T23:30:00Z")); // Tue 23:30
    expect(r.nearWeeklyOpen).toBe(false);
    expect(r.nearDailyOpen).toBe(true);
    expect(r.block).toContain("Daily candle");
    expect(r.block).not.toContain("Weekly candle");
  });

  it("advisory uses 'Daily opens' label when only daily fires", () => {
    const r = getSessionContext(d("2026-01-06T23:30:00Z"));
    expect(r.block).toContain("Daily opens frequently print false moves");
  });
});

// ─── Overlap session labeling ─────────────────────────────────────────────────

describe("overlap session labeling", () => {
  it("asia_london block contains overlap description", () => {
    const r = getSessionContext(d("2026-01-06T08:00:00Z")); // Tue 08:00
    expect(r.label).toBe("asia_london");
    expect(r.block).toContain("Asia/London overlap");
  });

  it("london_new_york block contains overlap description", () => {
    const r = getSessionContext(d("2026-01-06T14:00:00Z")); // Tue 14:00
    expect(r.label).toBe("london_new_york");
    expect(r.block).toContain("London/New York overlap");
  });
});

// ─── Mid-session, nothing near (no proximity lines) ───────────────────────────

describe("mid-session, nothing near — proximity lines absent", () => {
  it("Wed 14:30 (london_new_york) — no proximity lines in block", () => {
    const r = getSessionContext(d("2026-01-07T14:30:00Z")); // Wed 14:30
    expect(r.label).toBe("london_new_york");
    expect(r.nearWeeklyOpen).toBe(false);
    expect(r.nearDailyOpen).toBe(false);
    // Neither "candle" nor "false moves" should appear
    expect(r.block).not.toContain("candle");
    expect(r.block).not.toContain("false moves");
  });

  it("Tue 10:00 (london) — no proximity lines", () => {
    const r = getSessionContext(d("2026-01-06T10:00:00Z"));
    expect(r.label).toBe("london");
    expect(r.nearWeeklyOpen).toBe(false);
    expect(r.nearDailyOpen).toBe(false);
    expect(r.block).not.toContain("candle");
  });

  it("Sat 12:00 (weekend, mid) — no proximity lines", () => {
    const r = getSessionContext(d("2026-01-10T12:00:00Z"));
    expect(r.label).toBe("weekend");
    expect(r.nearWeeklyOpen).toBe(false);
    expect(r.nearDailyOpen).toBe(false);
    expect(r.block).not.toContain("candle");
  });
});

// ─── Block format structure ───────────────────────────────────────────────────

describe("block format structure", () => {
  it("block always starts with '## Session context (UTC)'", () => {
    const r = getSessionContext(d("2026-01-06T10:00:00Z")); // Tue 10:00 London
    expect(r.block.startsWith("## Session context (UTC)")).toBe(true);
  });

  it("block contains 'Now: Tuesday 10:00 UTC.'", () => {
    const r = getSessionContext(d("2026-01-06T10:00:00Z"));
    expect(r.block).toContain("Now: Tuesday 10:00 UTC.");
  });

  it("block contains 'Now: Sunday' for a Sunday time", () => {
    const r = getSessionContext(d("2026-01-11T15:00:00Z")); // Sun 15:00
    expect(r.block).toContain("Now: Sunday");
  });

  it("block always contains 'Next handoffs:' line", () => {
    const r = getSessionContext(d("2026-01-06T10:00:00Z"));
    expect(r.block).toContain("Next handoffs:");
  });

  it("first handoff entry has a countdown in parentheses", () => {
    const r = getSessionContext(d("2026-01-06T10:00:00Z")); // Tue 10:00 London → next is 13:30
    // Format: "New York 13:30 (3h30m)"
    expect(r.block).toMatch(/New York 13:30 \(\d+h\d+m\)/);
  });

  it("subsequent handoffs do not have a countdown", () => {
    const r = getSessionContext(d("2026-01-06T10:00:00Z")); // Tue 10:00
    // Line format: ... · Asia 21:00 · <next without countdown>
    const handoffLine = r.block.split("\n").find((l) => l.startsWith("Next handoffs:"))!;
    const parts = handoffLine.replace("Next handoffs: ", "").split(" · ");
    // All parts after the first must NOT contain parentheses
    for (const part of parts.slice(1)) {
      expect(part).not.toMatch(/\(/);
    }
  });

  it("weekend block contains 'Weekend' handoff label on Fri afternoon", () => {
    const r = getSessionContext(d("2026-01-09T14:00:00Z")); // Fri 14:00
    expect(r.block).toContain("Weekend 21:00");
  });

  it("weekend block shows 'Asia' handoff after weekend end", () => {
    // On Sat, the next named handoff is Sun 21:00 (Asia/weekly open)
    const r = getSessionContext(d("2026-01-10T12:00:00Z")); // Sat 12:00
    expect(r.block).toContain("Asia 21:00");
  });

  it("handoff countdown format is Xh YYm (zero-padded minutes)", () => {
    // Tue 12:30 — next handoff is 13:30 = 60 min away
    const r = getSessionContext(d("2026-01-06T12:30:00Z"));
    expect(r.block).toMatch(/New York 13:30 \(1h00m\)/);
  });

  it("proximity and handoff lines both present when near daily open", () => {
    const r = getSessionContext(d("2026-01-06T23:30:00Z")); // Tue 23:30
    const lines = r.block.split("\n");
    expect(lines.some((l) => l.includes("Daily candle"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Next handoffs:"))).toBe(true);
  });
});

// ─── Handoff label correctness ────────────────────────────────────────────────

describe("handoff label correctness", () => {
  it("handoffs from Tue 00:00 are London, New York, Asia (in order)", () => {
    const r = getSessionContext(d("2026-01-06T00:01:00Z")); // Tue 00:01 (just past midnight)
    const handoffLine = r.block.split("\n").find((l) => l.startsWith("Next handoffs:"))!;
    expect(handoffLine).toContain("London 07:00");
    expect(handoffLine).toContain("New York 13:30");
    expect(handoffLine).toContain("Asia 21:00");
  });

  it("handoffs from Tue 21:01 cross into Wednesday (show day abbr for cross-day)", () => {
    const r = getSessionContext(d("2026-01-06T21:01:00Z")); // Tue 21:01 — just entered Asia
    const handoffLine = r.block.split("\n").find((l) => l.startsWith("Next handoffs:"))!;
    // Next handoffs should be Wed's London, New York, and Asia — with "Wed" day tag
    expect(handoffLine).toContain("Wed");
  });

  it("Sun 21:01 handoffs are Mon Asia, Mon London, Mon New York", () => {
    const r = getSessionContext(d("2026-01-11T21:01:00Z")); // Sun 21:01 — Asia session
    const handoffLine = r.block.split("\n").find((l) => l.startsWith("Next handoffs:"))!;
    // First is Asia 00:00 Mon, then London 07:00 Mon, then New York 13:30 Mon
    expect(handoffLine).toContain("Asia 00:00");
    expect(handoffLine).toContain("London 07:00");
    expect(handoffLine).toContain("New York 13:30");
  });
});
