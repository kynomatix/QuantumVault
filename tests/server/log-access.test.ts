/**
 * Pins for the read-only log access API (server/log-access.ts).
 *
 * Focus: the redaction second-net. The primary defenses are policy-level
 * (error_log context never holds secrets; telemetry lines are console output)
 * — these tests pin that the scrubber catches the common secret shapes that
 * could slip through, and that it does NOT mangle the log content reviewers
 * actually need (tx sigs, wallet addresses, market symbols, numbers).
 */
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it, expect, vi } from "vitest";

const storageTarget = vi.hoisted(() => ({
  getErrorStats: vi.fn(async () => []),
  listErrors: vi.fn(async () => []),
}));
const telemetrySnapshotMock = vi.hoisted(() => vi.fn(() => ({
  queueLength: 3,
  queueBytes: 144,
  droppedLines: 7,
  drainerRunning: true,
  consecutiveFailures: 2,
})));

vi.mock("../../server/storage", () => ({ storage: storageTarget }));
vi.mock("../../server/telemetry", () => ({
  getTelemetryWriterSnapshot: telemetrySnapshotMock,
}));

import { redactSensitive, registerLogAccessRoutes } from "../../server/log-access";

let currentServer: Server | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  telemetrySnapshotMock.mockReturnValue({
    queueLength: 3,
    queueBytes: 144,
    droppedLines: 7,
    drainerRunning: true,
    consecutiveFailures: 2,
  });
  delete process.env.LOG_READ_TOKEN;
  if (currentServer) {
    currentServer.closeAllConnections?.();
    await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
    currentServer = undefined;
  }
});

async function startServer(token?: string): Promise<string> {
  if (token === undefined) delete process.env.LOG_READ_TOKEN;
  else process.env.LOG_READ_TOKEN = token;
  const app = express();
  registerLogAccessRoutes(app);
  currentServer = createServer(app);
  await new Promise<void>((resolve) => currentServer!.listen(0, "127.0.0.1", resolve));
  const address = currentServer.address();
  if (!address || typeof address === "string") throw new Error("no ephemeral test port");
  return `http://127.0.0.1:${address.port}`;
}

async function getSummary(base: string, token?: string) {
  const response = await fetch(`${base}/api/logs/summary`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

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

  it("redacts connection-string credentials but keeps host/db visible", () => {
    const out = redactSensitive(
      "pg error connecting to postgres://quantum_user:sup3rS3cretPW@ep-cool-host.neon.tech/maindb?sslmode=require"
    );
    expect(out).not.toContain("sup3rS3cretPW");
    expect(out).toContain("quantum_user");
    expect(out).toContain("ep-cool-host.neon.tech/maindb");
  });

  it("redacts bare JWTs not prefixed by Bearer", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    const out = redactSensitive(`session dump: { token2: ${jwt} }`);
    expect(out).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c");
    expect(out).toContain("[REDACTED-JWT]");
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

describe("GET /api/logs/summary telemetry writer health", () => {
  const token = "read-only-token-123456";

  it("retains dedicated bearer authentication", async () => {
    let base = await startServer();
    expect((await getSummary(base)).status).toBe(503);
    await new Promise<void>((resolve) => currentServer!.close(() => resolve()));
    currentServer = undefined;

    base = await startServer(token);
    expect((await getSummary(base, "wrong-token-value")).status).toBe(401);
    expect(telemetrySnapshotMock).not.toHaveBeenCalled();
  });

  it("returns the exact bounded writer snapshot under telemetry.writer", async () => {
    const base = await startServer(token);
    const response = await getSummary(base, token);
    expect(response.status).toBe(200);
    expect(response.body.telemetry.writer).toEqual({
      queueLength: 3,
      queueBytes: 144,
      droppedLines: 7,
      drainerRunning: true,
      consecutiveFailures: 2,
    });
    expect(Object.keys(response.body.telemetry.writer).sort()).toEqual([
      "consecutiveFailures",
      "drainerRunning",
      "droppedLines",
      "queueBytes",
      "queueLength",
    ]);
  });

  it("keeps the summary available and returns writer null when the snapshot throws", async () => {
    telemetrySnapshotMock.mockImplementationOnce(() => {
      throw new Error("must not escape or appear in the response");
    });
    const base = await startServer(token);
    const response = await getSummary(base, token);
    expect(response.status).toBe(200);
    expect(response.body.telemetry).toMatchObject({
      present: false,
      bytes: 0,
      lastLineAt: null,
      writer: null,
    });
    expect(JSON.stringify(response.body)).not.toContain("must not escape");
  });
});
