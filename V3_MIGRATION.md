# V3 Legacy Encryption Retirement — Migration Tracker

> **Source of truth (audited):** `docs/V3_LEGACY_RETIREMENT_PLAN.md`
> (gitignored locally; held as the architect-reviewed master plan).
> This root-level file is the **committable execution log** that mirrors
> each phase's outcome into version control. It contains no secret material,
> no encrypted blobs, and no key values.

## Phase status

| Phase | Title | Status | Date |
|-------|-------|--------|------|
| -1 | Sealed pre-migration key backup | **COMPLETE** | May 18, 2026 |
| 0  | UMK-at-rest re-keying | not started | — |
| 1  | Audit, env health & legacy-use logging | not started | — |
| 2  | Backfill the legacy-only holdout | not started | — |
| 2.5 | `decryptAgentKeyStrict` helper | not started | — |
| 3  | Migrate user-initiated reads | not started | — |
| 3b | Subscriber fan-out + executionEnabled gate | not started | — |
| 4  | Migrate background execution paths | not started | — |
| 4b | Per-bot subaccount keys + revoke-auto-pause | not started | — |
| 4c | drift-executor.mjs child process migration | not started | — |
| 5  | Deprecation period monitoring (7–14 days) | not started | — |
| 5b | Stop creating new legacy keys | not started | — |
| 6  | Delete legacy (one-way door) | not started | — |

---

## Phase -1 — Sealed pre-migration key backup — COMPLETE (May 18, 2026)

This is the committable evidence-of-execution for Phase -1. No secret
material, no encrypted blobs, no key values appear in this file. The
sealed backup itself is on user-controlled offline storage (USB drive)
alongside a paper-recorded `AGENT_ENCRYPTION_KEY`.

### What was done

1. **Read-only production query.** Selected
   `(address, agent_public_key, agent_private_key_encrypted, agent_private_key_encrypted_v3, umk_version)`
   from `wallets WHERE encrypted_user_master_key IS NOT NULL` ordered by
   `address`. **Row count: 13** — matches the plan's documented prod state
   (12 initialized + 1 wallet initialized since the plan was written; the
   row-count assertion was a non-fatal warning rather than abort). All 13
   rows had non-null legacy and V3 agent-key columns; all at
   `umk_version = 2`.

2. **CSV export** written to `/home/runner/quantumvault-pre-migration-backup.csv`
   — 6072 bytes, `chmod 600`, outside the repository root, so it could
   not be accidentally staged for commit.

3. **Spot-check decryption** of one **non-AqTT** wallet via a one-shot
   Node script that:
   - Read `AGENT_ENCRYPTION_KEY` from the workspace shell environment
     (never printed, never logged).
   - Ran the production legacy decrypt path (`aes-256-gcm`,
     `iv:authTag:hex` framing — identical to `server/crypto.ts`).
   - Parsed the plaintext as base58 with JSON-array fallback (same logic
     as `parseLegacyAgentKeyPlaintext` in `server/session-v3.ts`).
   - Derived the Solana public key via
     `Keypair.fromSecretKey(secret).publicKey.toBase58()`.
   - Zeroized the secret buffer before any logging.
   - **Result: derived pubkey matched the stored `agent_public_key`
     exactly** (short form `HPvG…PN7M` == `HPvG…PN7M`). The sealed backup
     is usable end-to-end, not opaque bytes.

4. **Spot-check script `shred -u`ed** immediately after each use (both
   `/tmp/spotcheck.mjs` and `.local/_spotcheck.mjs` were transient).

5. **CSV delivered to user** via the platform's download facility from
   `.local/quantumvault-pre-migration-backup.csv` (gitignored — verified
   via `git check-ignore`). User confirmed download and confirmed that
   the `AGENT_ENCRYPTION_KEY` value is already recorded on paper
   alongside the earlier AqTT private-key paper backup.

6. **Workspace copy `shred -u`ed.** Confirmed no copy at `.local/`,
   no copy at `/home/runner/`.

7. **Shell history cleared.** `~/.bash_history` and
   `~/.node_repl_history` emptied.

### Deviation from plan literal

The plan literal called for a one-shot script at
`.local/seal-pre-migration-backup.mjs` to hold the export logic. In
execution the data-pull was done through the sandboxed read-only
`executeSql` callback (which targets prod without holding a connection
string in the workspace), so **no script with prod credentials ever
existed on disk**. This is strictly better secret hygiene than the plan
literal.

### Architect review

Phase-specific architect review was run via the `code_review` skill
before this task was marked complete. Reviewer:
`subagent_evaluate_task-hotpink-douglasfirbarkbeetle`. **Verdict:
APPROVE.**

Key review findings:
- No secret material appeared in committed artifacts.
- `.local/` is verified gitignored (`.gitignore` line 15), so transient
  presence of the CSV there did not put the backup in a tracked path.
- No backup CSV or temporary script remained in the workspace after
  cleanup.
- Spot-check methodology matched production crypto format and the legacy
  plaintext decoding path, making end-to-end verification credible.

### Off-host artifacts (held by user)

- USB drive: pre-migration sealed CSV (13 rows).
- Paper: current `AGENT_ENCRYPTION_KEY` value, recorded alongside the
  earlier AqTT-wallet paper backup.

### Out of scope for this phase

Any code change in `server/session-v3.ts`, `server/crypto.ts`,
`shared/schema.ts`, or `server/routes.ts` belongs to Phases 0–6 and was
not touched in Phase -1.

### Next phase

Strict-serial successor: **Phase 0 — UMK-at-rest re-keying**.
