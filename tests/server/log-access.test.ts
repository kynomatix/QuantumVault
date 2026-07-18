/**
 * Pins for the read-only log access API (server/log-access.ts).
 *
 * Focus: the redaction second-net. The primary defenses are policy-level
 * (error_log context never holds secrets; telemetry lines are console output)
 * — these tests pin that the scrubber catches the common secret shapes that
 * could slip through, and that it does NOT mangle the log content reviewers
 * actually need (tx sigs, wallet addresses, market symbols, numbers).
 */
import { describe, it, expect } from "vitest";
import { redactSensitive } from "../../server/log-access";

describe("redactSensitive", () => {
  it("redacts secret-looking key=value pairs in multiple syntaxes", () => {
    expect(redactSensitive("api_key=abc123def456")).not.toContain("abc123def456");
    expect(redactSensitive('{"password":"hunter2secret"}')).not.toContain("hunter2secret");
    expect(redactSensitive("token: sometokenvalue123")).not.toContain("sometokenvalue123");
    expect(redactSensitive("PRIVATE_KEY=5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF"))
      .not.toContain("5Kb8kLf9");
    expect(redactSensitive("mnemonic = word1 word2word3word4")).not.toContain("word2word3word4");
  });

  it("redacts bearer tokens and api-key shapes", () => {
    expect(redactSensitive("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"))
      .not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redactSensitive("used key sk-or-v1-0123456789abcdef0123456789abcdef"))
      .not.toContain("0123456789abcdef");
  });

  it("keeps normal log content intact (tx sigs, wallets, symbols, numbers)", () => {
    const line =
      "2026-07-18T04:00:00Z [Datafeed] SOL/USDT 15m: okx=0c/84.7s(unavailable) total=84.7s candles=0 " +
      "wallet=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU tx=5j1ZXsg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU7xKXtg2CW87d97TXJSDpbD5jBkheTq";
    const out = redactSensitive(line);
    expect(out).toContain("SOL/USDT");
    expect(out).toContain("okx=0c/84.7s(unavailable)");
    expect(out).toContain("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(out).toContain("candles=0");
  });

  it("keeps scanner/breaker telemetry lines untouched", () => {
    const lines = [
      "[Scanner] SWEEP TOTAL: 3 scanned, 87 skipped-by-timeout, 0 errors, 2 candidates in 279.1s",
      "[OKX] SOURCE DOWN: 3 consecutive network failures - skipping OKX for all symbols for 15min",
    ];
    for (const l of lines) expect(redactSensitive(l)).toBe(l);
  });
});
