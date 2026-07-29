import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

import {
  assessResetBlockerRows,
  type ResetBlockerRows,
} from "../../server/vault/reset-blocker-policy";

const OLD_AGENT = "11111111111111111111111111111111";
const OTHER_AGENT = "So11111111111111111111111111111111111111112";

function clean(overrides: Partial<ResetBlockerRows> = {}): ResetBlockerRows {
  return {
    classicPositions: [],
    loopPositions: [],
    operations: [],
    tradingBots: [],
    aiTraderBots: [],
    protocolSubaccounts: [],
    orphanedSubaccounts: [],
    observedAgentPublicKey: OLD_AGENT,
    ...overrides,
  };
}

function trading(overrides: Record<string, unknown> = {}) {
  return {
    driftSubaccountId: null,
    protocolSubaccountId: null,
    subaccountAuthMode: "external_key",
    subaccountStatus: "active",
    botSubaccountKeyEncrypted: null,
    botSubaccountKeyEncryptedV3: "v3-key",
    ...overrides,
  } as any;
}

function protocol(overrides: Record<string, unknown> = {}) {
  return {
    protocolSubaccountId: "external-account",
    agentPublicKey: OLD_AGENT,
    status: "active",
    subaccountKeyEncryptedV3: "pooled-v3-key",
    lastVerifiedEmptyAt: null,
    ...overrides,
  } as any;
}

describe("reset agent-authority custody policy", () => {
  it("allows a completely clean wallet", () => {
    expect(assessResetBlockerRows(clean())).toEqual({ blocked: false });
  });

  it.each([
    { label: "classic position", rows: { classicPositions: [{ status: "open" }] } },
    { label: "loop position", rows: { loopPositions: [{ status: "hold" }] } },
    { label: "operation", rows: { operations: [{ status: "pending" }] } },
  ])("blocks active vault state: $label", ({ rows }) => {
    expect(assessResetBlockerRows(clean(rows as any))).toEqual({
      blocked: true,
      reason: "active_vault_state",
    });
  });

  it("treats driftSubaccountId=0 as linked agent custody", () => {
    expect(assessResetBlockerRows(clean({
      tradingBots: [trading({ driftSubaccountId: 0, protocolSubaccountId: null, subaccountAuthMode: "main_plus_id" })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it("blocks linked main_plus_id even when stale per-bot ciphertext exists", () => {
    expect(assessResetBlockerRows(clean({
      tradingBots: [trading({
        driftSubaccountId: 7,
        subaccountAuthMode: "main_plus_id",
        botSubaccountKeyEncryptedV3: "misleading-stale-key",
      })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it("ignores whitespace-only protocol linkage when no numeric link exists", () => {
    expect(assessResetBlockerRows(clean({
      tradingBots: [trading({ protocolSubaccountId: "   ", botSubaccountKeyEncryptedV3: null })],
    }))).toEqual({ blocked: false });
  });

  it.each([
    { label: "V3", keys: { botSubaccountKeyEncryptedV3: "v3-key", botSubaccountKeyEncrypted: null } },
    { label: "legacy", keys: { botSubaccountKeyEncryptedV3: null, botSubaccountKeyEncrypted: "legacy-key" } },
  ])("blocks a linked active external-key bot with a $label key", ({ keys }) => {
    expect(assessResetBlockerRows(clean({
      tradingBots: [trading({ protocolSubaccountId: "external", ...keys })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it("blocks a linked external-key bot with no independently stored key", () => {
    expect(assessResetBlockerRows(clean({
      tradingBots: [trading({ protocolSubaccountId: "external", botSubaccountKeyEncryptedV3: null })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it.each(["active", "none", "pending", "error", "provisioning", "future_v9", null])(
    "blocks linked keyed external bot regardless of legacy status %s",
    (status) => {
      expect(assessResetBlockerRows(clean({
        tradingBots: [trading({ protocolSubaccountId: "external", subaccountStatus: status })],
      }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
    },
  );

  it("blocks linked unknown/null auth modes", () => {
    expect(assessResetBlockerRows(clean({
      tradingBots: [trading({ protocolSubaccountId: "external", subaccountAuthMode: null })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it("blocks both independently keyed and keyless AI linkages", () => {
    expect(assessResetBlockerRows(clean({
      aiTraderBots: [{ protocolSubaccountId: "ai-account", botSubaccountKeyEncryptedV3: "ai-v3" }],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
    expect(assessResetBlockerRows(clean({
      aiTraderBots: [{ protocolSubaccountId: "ai-account", botSubaccountKeyEncryptedV3: null }],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it("allows an AI row with no trimmed external linkage regardless of stale key material", () => {
    expect(assessResetBlockerRows(clean({
      aiTraderBots: [{ protocolSubaccountId: "   ", botSubaccountKeyEncryptedV3: "stale-v3" }],
    }))).toEqual({ blocked: false });
  });

  it.each([
    { status: "reserving", reason: "custody_transition_in_flight" },
    { status: "stuck_funds", reason: "agent_authority_custody" },
    { status: "future_v9", reason: "custody_transition_in_flight" },
    { status: null, reason: "custody_transition_in_flight" },
  ])("blocks matching protocol row status $status", ({ status, reason }) => {
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ status })],
    }))).toEqual({ blocked: true, reason });
  });

  it("blocks a matching active registry row with or without a retained key", () => {
    expect(assessResetBlockerRows(clean({ protocolSubaccounts: [protocol()] })))
      .toEqual({ blocked: true, reason: "agent_authority_custody" });
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ subaccountKeyEncryptedV3: null })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it("allows only a retained-key, verified-empty spare", () => {
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ status: "spare", lastVerifiedEmptyAt: new Date(0) })],
    }))).toEqual({ blocked: false });
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ status: "spare", lastVerifiedEmptyAt: null })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ status: "spare", lastVerifiedEmptyAt: new Date(0), subaccountKeyEncryptedV3: null })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it("ignores a protocol row explicitly owned by another valid generation", () => {
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ agentPublicKey: OTHER_AGENT, status: "stuck_funds" })],
    }))).toEqual({ blocked: false });
  });

  it.each([null, "", "not-a-solana-public-key"])("blocks malformed generation on a linked protocol row %s", (agentPublicKey) => {
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ agentPublicKey })],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
  });

  it.each([null, "", "   "])("allows unlinked protocol scaffolding regardless of nullable generation: %s", (protocolSubaccountId) => {
    expect(assessResetBlockerRows(clean({
      protocolSubaccounts: [protocol({ protocolSubaccountId, agentPublicKey: null, status: null })],
    }))).toEqual({ blocked: false });
  });

  it("blocks matching and malformed orphans but ignores a different valid generation", () => {
    expect(assessResetBlockerRows(clean({ orphanedSubaccounts: [{ agentPublicKey: OLD_AGENT }] })))
      .toEqual({ blocked: true, reason: "agent_authority_custody" });
    expect(assessResetBlockerRows(clean({
      orphanedSubaccounts: [{ agentPublicKey: OLD_AGENT, retryCount: 500 } as any],
    }))).toEqual({ blocked: true, reason: "agent_authority_custody" });
    expect(assessResetBlockerRows(clean({ orphanedSubaccounts: [{ agentPublicKey: OTHER_AGENT }] })))
      .toEqual({ blocked: false });
    expect(assessResetBlockerRows(clean({ orphanedSubaccounts: [{ agentPublicKey: "malformed" }] })))
      .toEqual({ blocked: true, reason: "agent_authority_custody" });
  });
});

describe("reset coordination source guards", () => {
  it("has no production caller of the deprecated direct protocol-link writer", () => {
    const root = resolve(__dirname, "../../server");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "storage.ts") files.push(full);
      }
    };
    walk(root);
    const callers = files.filter((file) => readFileSync(file, "utf8").includes("assignProtocolSubaccountId("));
    expect(callers).toEqual([]);
  });

  it.each([
    ["prepareExternalSubaccountReservation", "claimSpareSubaccount"],
    ["claimSpareSubaccount", "finalizeReusedSubaccount"],
    ["createAgentAuthorityTradingBot", "allocateBotDerivationIndex"],
    ["createOrphanedSubaccount", "getOrphanedSubaccounts"],
  ])("keeps coordinated storage section %s DB-only", (startName, endName) => {
    const source = readFileSync(resolve(__dirname, "../../server/storage.ts"), "utf8");
    const start = source.indexOf(`async ${startName}(`);
    const end = source.indexOf(`async ${endName}(`, start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = source.slice(start, end);
    expect(section).toContain("pg_advisory_xact_lock");
    expect(section).not.toMatch(/fetch\s*\(|setTimeout\s*\(|sweepBotWallet|transferBetweenSubaccounts|provisionFundedSubaccount|provisionBotWallet/);
  });

  it("atomically finalizes the regular-bot status and exact reservation owner", () => {
    const storageSource = readFileSync(resolve(__dirname, "../../server/storage.ts"), "utf8");
    const start = storageSource.indexOf("async finalizeReusedSubaccount(");
    const end = storageSource.indexOf("async releaseReservationToSpare(", start);
    const section = storageSource.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(section).toContain("return db.transaction(async (tx)");
    expect(section).toContain("tx.update(protocolSubaccounts)");
    expect(section).toContain("tx.update(tradingBots)");
    expect(section).toContain("params.terminalSubaccountStatus === 'active'");
    expect(section).toContain("THEN 'active' ELSE 'error'");
    expect(section).toContain("isNotNull(tradingBots.botSubaccountKeyEncryptedV3)");
    expect(section).not.toMatch(/\bdb\.update\(/);

    const routeSource = readFileSync(resolve(__dirname, "../../server/routes.ts"), "utf8");
    expect(routeSource.match(/terminalSubaccountStatus:/g)).toHaveLength(3);
    expect(routeSource).toContain("terminalSubaccountStatus: (req as any)._flashProvisionAmbiguous ? 'error' : 'active'");
    expect(routeSource).toContain("terminalSubaccountStatus: 'active'");
    expect(routeSource).toContain("terminalSubaccountStatus: provision.ambiguous ? 'error' : 'active'");
  });
});
