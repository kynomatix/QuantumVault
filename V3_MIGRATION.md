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
| 0  | UMK-at-rest re-keying | **COMPLETE** | May 18, 2026 |
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

---

## Phase 0 — UMK-at-rest re-keying — COMPLETE (May 18, 2026)

This is the committable evidence-of-execution for Phase 0. No secret
material, no encrypted blobs, and no key values appear in this file.

### What was done

1. **New env secret `UMK_STORAGE_SECRET`** (64 hex chars) added to the
   workspace via the Replit secrets store. Value is also paper-recorded
   alongside `AGENT_ENCRYPTION_KEY` per the sealed-backup convention.
   Length is validated at startup; format errors are loud.

2. **Re-key path implemented in `server/session-v3.ts`.** The login flow
   `initializeWalletSecurity` now branches:
   - **v1 → v3:** legacy single-wallet path regenerates the UMK and
     writes it sealed under the v3 storage key. Unchanged user-visible
     behavior; `umk_version` flips from 1 to 3.
   - **v2 → v3 (the migration core):** the existing UMK is decrypted
     with the v2 storage key (derived from `SESSION_SECRET` +
     wallet-specific salt) and **immediately** re-sealed under the v3
     storage key (derived with the new domain prefix `"UMK_V3"` +
     `UMK_STORAGE_SECRET` + wallet-specific salt). The re-key and the
     `umk_version = 3` flag are written in a **single SQL UPDATE** so
     no partial state can be observed by a concurrent reader. If v2
     decrypt fails the request errors loudly — the code never silently
     regenerates a UMK on a v2 wallet, which would orphan
     `umk_encrypted_for_execution` (sealed under
     `SERVER_EXECUTION_KEY`, which is independent of UMK storage).
   - **v3 steady state:** noop re-derivation under the v3 key.
   - **Brand-new (shell) wallets:** the `isNewWallet` branch writes
     `umk_version = 3` directly. No v1/v2 row is ever created going
     forward from this code path.

3. **Storage-key domain separation.** `getStorageKeyV2` retains the
   pre-existing derivation. `getStorageKeyV3` introduces a fresh
   domain prefix (`"UMK_V3"`) and concatenates `UMK_STORAGE_SECRET`
   before the wallet salt, so v3-sealed blobs are cryptographically
   distinct from v2-sealed blobs even if `SESSION_SECRET` were ever
   exposed. The two functions never share a code path.

4. **Storage interface methods added** in `server/storage.ts`:
   - `getUmkVersionDistribution()` — operator-facing histogram over
     `wallets.umk_version`, used to confirm the v2-tail drains as
     active users sign in.
   - `hasAnyUmkV3OrAbove()` — boolean input to the startup health
     check below.

5. **Startup health check** added in `server/db.ts`
   (`checkUmkStorageSecretHealth`) and wired into `server/index.ts`
   immediately after `ensureSchema()`. Behavior:
   - If at least one row has `umk_version >= 3` **and**
     `UMK_STORAGE_SECRET` is missing/malformed → **process refuses to
     boot.** This prevents a deploy without the v3 secret from silently
     locking re-keyed users out of their UMK.
   - On a fresh DB with no v3 rows yet, the check is a no-op so the
     first Phase 0 deploy can boot before any user has signed in.
   - Length validation is a fixed 64 hex chars to match the documented
     secret format.

### What was NOT done (out of scope, deferred to later phases)

- `agent_private_key_encrypted` (legacy AES-GCM path) is **untouched**.
  Phase 0 only re-keys the UMK at rest; legacy agent-key reads and
  writes continue exactly as before. Phase 1 begins audit logging on
  the legacy path; Phases 3–4 migrate readers; Phase 6 deletes it.
- `umk_encrypted_for_execution` (sealed under `SERVER_EXECUTION_KEY`)
  is **not** re-keyed in this phase — it's already independent of the
  UMK-storage secret and lives on its own rotation timeline.
- No backfill job was added. The v2-tail drains naturally as active
  users sign in; cold/inactive wallets stay at `umk_version = 2` until
  Phase 2 (legacy-only holdout backfill) addresses them.

### Verification

- `npx tsc --noEmit` — all new/changed files (`server/session-v3.ts`,
  `server/db.ts`, `server/storage.ts`, `server/index.ts`) are
  typeclean. Pre-existing typecheck errors in unrelated files
  (`server/routes.ts`, `server/protocol/pacifica/*`) are unchanged.
- Workflow restart succeeded; startup log shows
  `[Startup] UMK_STORAGE_SECRET configured (v3 rows present: no)`
  confirming the health check ran with the secret set on a fresh
  Phase-0 deploy.
- No exception path leaks plaintext UMK bytes; all in-memory buffers
  go through the existing v3-key utilities that already follow the
  zeroize-after-use convention from the v3 module.

### Architect review

A phase-specific architect review was run via the `code_review` skill
before this task was marked complete; verdict and reviewer alias
recorded in the merged PR notes.

### Next phase

Strict-serial successor: **Phase 1 — Audit, env health & legacy-use
logging**.

---

## Phase 1 — Audit, env health & legacy-use logging (COMPLETE)

**Date:** May 19, 2026
**Risk:** LOW (log-only)
**Status:** ✅ Complete, awaiting merge

### What was done

1. **Audit grep baseline (G15) confirmed clean.**
   `rg "agentPrivateKeyEncrypted|getAgentKeypair" server/lab/ server/protocol/`
   → zero hits. Confirms no agent-key reads have leaked into the
   QuantumLab child process or the protocol-adapter layer.

2. **Env-var presence verified in dev workspace.** All three of
   `AGENT_ENCRYPTION_KEY`, `UMK_STORAGE_SECRET`, and
   `SERVER_EXECUTION_KEY` are set. Staging/prod must be verified
   pre-deploy (operator checklist; the new startup log will surface
   any drift loudly on boot).

3. **`[Security][LegacyKeyUsed]` deprecation WARN added** to
   `decryptAgentKeyWithFallback` in `server/session-v3.ts`. Fires on
   **every** invocation of the deprecated fallback helper and prints
   a 5-frame stack slice for caller identification, plus flags for
   `hasV3 / hasLegacy / hasUmk`. Never prints any key material. This
   is the deprecation telemetry that Phases 3–4 will use to enumerate
   readers and Phase 5 will use to gate on zero-callers for ≥7 days.

4. **Deprecation JSDoc added** to `decryptAgentKeyWithFallback`
   warning future contributors: only `migrateAgentKeyToV3` may use
   the fallback variant; every other caller must use the strict
   helper added in Phase 2.5.

5. **`[Startup][SecurityConfig]` INFO log added** via the new
   `logSecurityConfigSummary()` in `server/db.ts`, wired into
   `server/index.ts` immediately after the UMK health check. Logs
   presence (never values) of the three encryption env vars plus the
   set of V3-relevant `wallets` columns actually present in the live
   schema (queried via `information_schema.columns`, not the ORM
   definition, so a drifted prod schema is surfaced loudly).

6. **Dual-write paths reverified UNCHANGED.**
   `server/routes.ts:2533` (unlock_umk new-wallet creation) and
   `server/routes.ts:3648` (reset-agent-wallet) both still call
   `legacyEncrypt` + `encryptAgentKeyV3` + `updateWalletAgentKeys`
   + `updateWalletAgentKeyV3`. Per architect finding A3, new-wallet
   legacy writes MUST continue until Phase 5b — touching them here
   would break new sign-ups until Phase 3 lands.

7. **Offline-key backup outreach to wallet
   `BgCdZBajRhMFdktJA2oP2vUonGvQuanQ9KDSVpwEZSnV`** (agent pubkey
   `GdBRstEGW38Mvyh2w5Z8LJDD8XhgmJSqhPT2PNyjtqPs`, the only non-AqTT
   user with a configured bot) is documented as a manual operator
   action. The sealed CSV from Phase -1 already protects this user;
   the outreach is an additional layer. Outcome to be recorded in
   the production operator log when contact is made or attempted.

### What was NOT done (out of scope, deferred)

- **No legacy writes stopped.** That is Phase 5b, gated on the
  deprecation log being silent for ≥7 days.
- **No call sites migrated.** Phase 3 onward, one phase per surface.
- **No new `decryptAgentKeyStrict` helper.** That is Phase 2.5.

### Verification

- `npm run check` (tsc) — no new errors in
  `server/session-v3.ts`, `server/db.ts`, or `server/index.ts`.
- Workflow restart succeeded; startup logs show both new lines:
  - `[Startup] UMK_STORAGE_SECRET configured (v3 rows present: no)`
  - `[Startup][SecurityConfig] envVars={...:true,:true,:true} walletColumns=[...8 columns...]`
- The WARN fires on every fallback-helper call (manually verified by
  inspecting the code path; no prod call yet because no user has
  signed in since restart — production deploy will produce live
  telemetry within minutes of the first authenticated request).

### Next phase

Strict-serial successor: **Phase 2 — Backfill the legacy-only
holdout** (passive; no code change).

---

## Phase 2 — Backfill the legacy-only holdout (COMPLETE — DEFERRED)

**Date:** May 19, 2026
**Risk:** LOW (passive — no code changes)
**Status:** ✅ Holdout identified and documented; auto-backfill deferred to user's next sign-in.

### What was done

1. **Re-read Phase 2 of the master plan** (`docs/V3_LEGACY_RETIREMENT_PLAN.md`).
2. **Identified the legacy-only holdout** via:
   `SELECT address, umk_version, user_salt IS NOT NULL AS has_salt,
     encrypted_user_master_key IS NOT NULL AS has_umk,
     agent_public_key IS NOT NULL AS has_agent_pubkey, execution_enabled
     FROM wallets
    WHERE agent_private_key_encrypted IS NOT NULL
      AND agent_private_key_encrypted_v3 IS NULL;`

   **Production query result, 2026-05-19T00:08:11.943Z** (read-only
   replica, via `executeSql({ environment: "production" })`):

   | metric | value |
   |---|---|
   | legacy_only | **1** |
   | dual (legacy + V3) | 13 |
   | v3_only | 0 |
   | total wallet rows | 21 |

   The single legacy-only row:
   - `HKFTntqTcNGPFQ4tL7kouZRp7bZJscM1x1iFEFEKWq43` — umk_version=0,
     has_salt=false, has_umk=false, has_agent_pubkey=true,
     execution_enabled=false. Legacy agent key only; predates V3
     entirely. Matches the "1 legacy-only holdout" cohort in the
     master plan exactly. The dual cohort has grown from 11 to 13
     since the plan was drafted (two new sign-ups, both correctly
     dual-encrypted by the unchanged routes.ts:2533 path).

   Same query was also run against the dev DB at execution time
   and returned an identical single-row result (the dev mirror has
   a copy of this wallet), so dev and prod agree.

3. **Auto-backfill path verified against current code** (read-only):
   `initializeWalletSecurity` (`server/session-v3.ts:178-298`) treats
   `user_salt IS NULL` as `isNewWallet = true`, generates a fresh UMK,
   and writes user_salt + encrypted_user_master_key + umk_version=3 in
   one request. The post-login `migrateAgentKeyToV3` hook
   (`server/session-v3.ts:290-293`) then re-encrypts the existing
   legacy agent key as V3 using that fresh UMK and writes
   `agent_private_key_encrypted_v3`. Two writes, same request, no
   manual intervention — preserves the `agentPublicKey` (CRITICAL
   rule 1: never regenerate the keypair, funds are tied to it).

### What was NOT done (out of scope per Phase 2 anti-drift rules)

- **No code changes.** Phase 2 is passive verification only.
- **No manual backfill script.** The `initializeWalletSecurity` +
  `migrateAgentKeyToV3` flow is the canonical path.

### Outcome / disposition

- The holdout is **deferred** until they next sign in. The Phase 1
  `[Security][LegacyKeyUsed]` deprecation log will surface them
  automatically if they hit any code path that uses the fallback
  helper. If they remain dormant through the Phase 5 deprecation
  window, the operator runbook will surface them again as part of
  the Phase 5 acceptance gate.
- Outreach to ask this user to sign in once is a manual operator
  action (their wallet address, not their identity, is what the
  system has). Recorded here for tracking; outcome to be updated
  in the operator log if/when contact is made.

### Next phase

Strict-serial successor: **Phase 2.5 — Strict-mode decrypt helper**
(`decryptAgentKeyStrict`, add-only, in `server/session-v3.ts` only).
