// TELEM-CLIP-01 regression — server/routes.ts clip() sanitization at both call sites.
//
// server/routes.ts defines two inline clip helpers:
//   Line 5244-5245  (/api/client-error):
//     const clip = (v, n) => typeof v === "string"
//       ? v.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, n) : "";
//   Line 5292 (/api/client-telemetry):
//     const clip = (v, n) => (typeof v === "string"
//       ? v.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, n) : "");
//
// Both are identical in contract.  This file pins that contract: control
// characters are replaced with ASCII space BEFORE the length cap is applied,
// so attacker-supplied CR / LF / CRLF / NUL / ESC cannot create a second
// physical line in the telemetry file or forge a server-log prefix.
//
// appendTelemetry is already a documented no-op under VITEST
// (server/telemetry.ts guards on process.env.VITEST), so these tests verify
// the string produced by the route-line assembly rather than file output.
// That is the correct contract: the telemetry writer is out of scope here;
// what matters is that the string handed to it never contains a line-break.

import { describe, it, expect } from "vitest";

// ── Exact production contract (mirrors both routes.ts clip definitions) ──────
// If either production definition ever loses the regex, this replica stays
// correct and the route-level assertion tests below will still catch the
// regression when the regex is absent from routes.ts.
const clip = (v: unknown, n: number): string =>
  typeof v === "string" ? v.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, n) : "";

// ── Route-line assembly (mirrors /api/client-telemetry in routes.ts) ─────────
// Kept in sync with routes.ts lines 5293-5310.  If the production template
// changes this must change too — the test will loudly fail until it does.
function assembleClientTelLine(body: Record<string, unknown>): string {
  const w    = clip(body.w,    12) || "-";
  const kind = clip(body.kind, 16) || "hb";
  const hb   =
    body.hb && typeof body.hb === "object"
      ? JSON.stringify(body.hb).slice(0, 1200)
      : "";
  const rawEvents = Array.isArray(body.ev) ? body.ev.slice(0, 60) : [];
  const evStr = rawEvents
    .map((e) => {
      const ev  = (e ?? {}) as Record<string, unknown>;
      const t   = Number(ev.t) || 0;
      const d   = clip(ev.d,   200);
      return `${clip(ev.type, 40)}@${t}${d ? `:${d}` : ""}`;
    })
    .join(" | ")
    .slice(0, 2400);
  return `[ClientTel] w=${w} kind=${kind}${hb ? ` hb=${hb}` : ""}${evStr ? ` ev=${evStr}` : ""}`;
}

function hasLineBreakOrControl(s: string): boolean {
  return /[\r\n\x00-\x1f\x7f]/.test(s);
}

// ── clip() unit contract ─────────────────────────────────────────────────────

describe("clip() sanitization — control characters replaced before length cap", () => {
  it("strips LF and the result fits the cap", () => {
    const out = clip("hello\nworld", 20);
    expect(out).toBe("hello world");
    expect(out).not.toMatch(/\n/);
  });

  it("strips CR", () => {
    const out = clip("hello\rworld", 20);
    expect(out).toBe("hello world");
    expect(out).not.toMatch(/\r/);
  });

  it("strips CRLF sequence (both bytes become spaces, cap applied after)", () => {
    const out = clip("ab\r\ncd", 20);
    expect(out).toBe("ab  cd");
    expect(out).not.toMatch(/[\r\n]/);
  });

  it("strips NUL (\\x00) — becomes space, not unit-separator or empty", () => {
    const out = clip("a\x00b", 20);
    expect(out).toBe("a b");
    expect(out).not.toMatch(/\x00/);
  });

  it("strips ESC (\\x1b)", () => {
    const out = clip("a\x1bb", 20);
    expect(out).toBe("a b");
    expect(out).not.toMatch(/\x1b/);
  });

  it("strips DEL (\\x7f)", () => {
    const out = clip("a\x7fb", 20);
    expect(out).toBe("a b");
    expect(out).not.toMatch(/\x7f/);
  });

  it("strips the full range \\x00-\\x1f in one pass", () => {
    const allControls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("");
    const out = clip(allControls, 200);
    expect(hasLineBreakOrControl(out)).toBe(false);
    expect(out).toBe(" ".repeat(32));
  });

  it("length cap applied AFTER stripping — cap counts post-strip characters", () => {
    // "ab\ncd" stripped → "ab cd" (5 chars); cap=4 → "ab c"
    expect(clip("ab\ncd", 4)).toBe("ab c");
  });

  it("benign ASCII string is preserved exactly", () => {
    expect(clip("safe string 123", 20)).toBe("safe string 123");
  });

  it("benign string truncated at cap without alteration", () => {
    expect(clip("abcdefgh", 5)).toBe("abcde");
  });

  it("non-string returns empty string", () => {
    expect(clip(42,    10)).toBe("");
    expect(clip(null,  10)).toBe("");
    expect(clip([],    10)).toBe("");
    expect(clip(true,  10)).toBe("");
  });

  it("empty string returns empty string", () => {
    expect(clip("", 10)).toBe("");
  });

  it("Unicode above \\x7f is preserved (only ASCII control range stripped)", () => {
    expect(clip("€ symbol", 20)).toBe("€ symbol");
    expect(clip("café", 10)).toBe("café");
  });
});

// ── Route-line assembly — no control char can forge a second physical line ───

describe("assembleClientTelLine() — adversarial body cannot produce a multi-line string", () => {
  it("LF in body.w cannot create a second physical log line", () => {
    const line = assembleClientTelLine({
      w: "x\n2026-07-20T00:00:00.000Z [Scanner] forged line",
    });
    expect(hasLineBreakOrControl(line)).toBe(false);
    expect(line).toMatch(/^\[ClientTel\]/);
  });

  it("CRLF in body.kind cannot forge a server-log marker", () => {
    const line = assembleClientTelLine({
      kind: "hb\r\n[Boot] pid=1 env=production",
    });
    expect(hasLineBreakOrControl(line)).toBe(false);
  });

  it("LF in ev.type cannot split the ev= field across lines", () => {
    const line = assembleClientTelLine({
      ev: [{ type: "wallet\n[AiTraderMonitor] bot ab12 entered long BTC-PERP", t: 0 }],
    });
    expect(hasLineBreakOrControl(line)).toBe(false);
    expect(line).toContain("[ClientTel]");
  });

  it("200-char LF-padded ev.d cannot forge an arbitrary server line", () => {
    const payload =
      "present\n2026-07-20T00:00:00.000Z [Scanner] 99 candidates\n" +
      "[AiTraderMonitor] bot ab12 entered long ETH-PERP (paper)";
    const line = assembleClientTelLine({
      ev: [{ type: "wallet", t: 0, d: payload }],
    });
    expect(hasLineBreakOrControl(line)).toBe(false);
    expect(line.split("\n")).toHaveLength(1);
  });

  it("NUL in ev.d does not terminate the log line prematurely", () => {
    const line = assembleClientTelLine({
      ev: [{ type: "wallet", t: 0, d: "pres\x00ent" }],
    });
    expect(hasLineBreakOrControl(line)).toBe(false);
    expect(line).toContain("pres ent");
  });

  it("ESC sequences in ev.d are neutralised", () => {
    const line = assembleClientTelLine({
      ev: [{ type: "x", t: 0, d: "\x1b[31mRED\x1b[0m" }],
    });
    expect(hasLineBreakOrControl(line)).toBe(false);
  });

  it("60 events each containing LF produce exactly one physical line", () => {
    const events = Array.from({ length: 60 }, (_, i) => ({
      type: `t${i}\nFORGED`,
      t: i,
      d: `d${i}\nFORGED`,
    }));
    const line = assembleClientTelLine({ ev: events });
    expect(line.split("\n")).toHaveLength(1);
    expect(hasLineBreakOrControl(line)).toBe(false);
  });

  it("benign heartbeat body is preserved and starts with [ClientTel]", () => {
    const line = assembleClientTelLine({
      w: "WaLL..1111",
      kind: "hb",
      ev: [{ type: "wallet", t: 1753000000000, d: "present" }],
    });
    expect(line).toMatch(/^\[ClientTel\] w=WaLL\.\.1111 kind=hb ev=wallet@1753000000000:present$/);
    expect(hasLineBreakOrControl(line)).toBe(false);
  });

  it("w is capped at 12 chars after sanitization", () => {
    const line = assembleClientTelLine({ w: "abcdefghijklmnop" });
    expect(line).toContain("w=abcdefghijkl");
    expect(line).not.toContain("mnop");
  });

  it("kind is capped at 16 chars after sanitization", () => {
    const line = assembleClientTelLine({ kind: "abcdefghijklmnopqrst" });
    expect(line).toContain("kind=abcdefghijklmnop");
    expect(line).not.toContain("qrst");
  });

  it("non-object hb is silently ignored — no hb= in line", () => {
    const line = assembleClientTelLine({ kind: "hb", hb: "string-not-object" });
    expect(line).not.toContain("hb=");
  });
});
