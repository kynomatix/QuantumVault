# Phoenix U16 operations

Phoenix is disabled for money actions by default. This unit installs gates and contracts, not production money IO. The registration, funding, order, queue, lender, parking, carry and AI composition still needs its separately reviewed native bindings and eligibility proofs. A flag cannot create those capabilities. Public prices and application liveness do not prove venue or custody readiness. Pacifica configuration and the legacy recovery adapters remain unchanged.

## Owner launch and gates

Only the owner may supply the separate launch word and set the server configuration. There is no client or connector endpoint for writing it. Building, testing, reviewing or merging this unit is not a launch grant. Before any live action, the conductor must reconcile live funds/debt/positions, resolve the activation punch list, finish Kimi review and post-merge review, and verify that Replit revision, configuration and schema match the reviewed batch. U15 acceptance and all U01–U16 acceptances are required. No migration is introduced here.

| Flag/config | Effect when enabled, with all prerequisites |
| --- | --- |
| PHOENIX_READS_ENABLED | Public REST/WS display observations only. No signing or funding. |
| PHOENIX_AI_SCANNER_ENABLED | Includes Phoenix display markets in AI scanning. |
| PHOENIX_AI_PAPER_ENABLED | Paper-only AI creation; no live graduation. |
| PHOENIX_NEW_RISK_ENABLED | Master admission for every Phoenix risk action; false kills expansion. |
| PHOENIX_OWNER_LAUNCH_AUTHORIZED | Separate owner launch grant; insufficient without a valid policy. |
| PHOENIX_CANARY_POLICY | Expiring owner/bot allowlist, stage, acceptance/drill/deployment attestations and caps. |
| PHOENIX_PROVISIONING_ENABLED | Bounded registration of the exact deterministic allowlisted creation ID. |
| PHOENIX_FUNDING_ENABLED | Bounded wallet funding and venue deposits. |
| PHOENIX_ENTRY_ENABLED | Entries within leverage and complete all-market bot exposure caps. |
| PHOENIX_PARKING_ENABLED | Bounded new parking/entry settlement, with persisted opt-in. |
| PHOENIX_BORROW_ENABLED | Manual open/grow, top-up, collateral release and debt deployment. |
| PHOENIX_AUTO_DEFENSE_ENABLED | Automatic collateral top-up, with per-action persisted consent; repayment is independent. |
| PHOENIX_CARRY_ENABLED | New carry chains and parking expansion under fresh economics/consent. |
| PHOENIX_AI_LIVE_ENABLED | AI graduation/entries through the same gated creation, funding and order primitives. |

Every boolean requires the exact string true. The policy is private server JSON, never returned by health. Its fields are: version (1), authorizationId, ownerWallet, botIds, maxBots (1–5), expiresAt (epoch ms, at most 24 hours ahead), stage, acceptedUnits (U01 through U16), reviewedDeployment (true), recoveryDrillPassed (true), and caps. The owner chooses positive integer string caps: maxRegistrationLamports, maxTransferUsdcMicros, maxExposureUsdcMicros, maxDebtUsdcMicros, maxParkUsdcMicros, maxCollateralRaw, collateralMint and maxLeverage (1–20). These are ceilings, not suggested amounts. Missing/malformed/expired policy, wrong owner, unlisted bot, unknown exposure or exceeded cap denies risk. No runnable grant or live address is committed.

Transfer and registration caps apply per immutable action; exposure/debt/collateral caps apply to the fresh bot total plus proposed addition. Parking is capped per chain. Cohort size bounds the number of eligible bots; these are not cumulative lifetime deposit quotas. The reviewed all-market execution reader must supply canaryExposureMicros, including existing exposure; outstanding order journals serialize admission under the existing bot lock. Absent aggregate binding denies entries. Existing funding, parking and borrowing exclusions remain in force. Monetary intent caps and risk admission are rechecked at signer/send boundaries; lost acknowledgements retain a journal and never authorize another send.

Stages advance in this order: trading, parking, manual_debt, defense, carry. Debt requires parking enabled, defense requires borrowing enabled, carry requires defense enabled. Each stage still needs its own flag and actual reviewed bindings. Begin with one allowlisted bot and the owner's smallest approved caps. Never advance because a flag was toggled or a health response was green.

## Expand and abort

Expansion needs a fresh owner grant, reviewed source/config/schema match, a completed recovery drill, and authoritative cohort evidence: no unresolved journals, dropped queue returns, protection gaps or unhealthy/unknown debt; fresh account/RPC/API reads; verified eligibility/co-signing; measured queue fees/delay and liquid debt reserve. Observe at least one complete settlement and reconciliation cycle for the current stage and every money leg before moving to the next. The owner sets the observation window and acceptable measured delay/cost ceilings in the launch record. No window or ceiling means no expansion. Resolve the U09–U14 pre-activation punch list before activating the affected features. The U16 retry ingress must-fix is included in this change.

Abort immediately for scope/cap/identity mismatch, unbound/ambiguous outcome, stale or unavailable execution authority, protection gap, unexpected fee/queue drop/delay, lost liquid repayment buffer, unhealthy/unknown debt, denied eligibility, or unmatched deployment/config/schema. Set PHOENIX_NEW_RISK_ENABLED=false and revoke the launch grant. Retain custody, all journals, queue identities, lender IDs, old adapters and read/recovery workers. Investigate and obtain a new owner word before re-arming. A process shutdown also irreversibly latches Phoenix risk off before the existing bounded HTTP/storage drain; it does not erase recovery state.

## Recovery drill and rollback

Run this drill with fake IO and the focused FRACTAL files first. A real-money drill requires the owner's separate launch word; this build performs no live actions.

1. Record authoritative owned positions/orders, lender debt/collateral, wallet cash, venue collateral, queued returns and pending journals. Unknown amounts remain unknown.
2. Prepare a capped entry/funding/borrow/park chain, then kill risk before signing, after signing, after the durable attempt and while a return is queued. Verify no additional risk send, no blind resend and no loss of identity or journal.
3. Reconcile the exact original signatures and finalized receipts. An API timeout/cache miss is not evidence of absence. Queued return is not settled cash; dropped return needs operator attention.
4. With the grant expired and bot removed from the canary, verify owned reconciliation, reduce-only close/cancel, explicit withdraw/unwrap/wallet return, repay and unwind still operate through authenticated native bindings, fresh authority, existing consent and write-ahead journals. For an existing idle/carry chain, withdrawal/unwrap may complete after kill; a new park/deposit cannot. Repayment never depends on the top-up switch.
5. Restart with risk off and resume original IDs. Keep legacy Pacifica/retired adapter recovery installed while any obligation, custody identity, queue receipt or ambiguous journal remains. Never delete/recycle a bot or signer to implement rollback. A rollback deployment must retain the Phoenix recovery code/schema even if older entry code is restored.
6. Discharge positions, cancel orders, finish withdrawals, repay liabilities and verify finalized zero balances/debt plus no unresolved operations. Only then may a separately reviewed owner action retire recovery adapters/custody. Check that Pacifica retry ingress still queues through a transient bot lookup failure.

## Health and metrics

Repay and unwind still require a readable, fresh, complete lender snapshot at
broadcast. Disabling new risk does not bypass lender observations, authenticated
custody, original consent, repayment limits or write-ahead recovery journals.

The existing /health and /api/health HTTP 200/application readiness contract is preserved. The dependency-health-record projection adds dependencies.phoenix: adapter/SDK pin version, eligibility, RPC/API/WS timestamps/freshness, bounded queue count/oldest age/drops, unresolved journals, protection gaps and debt health. Application ready stays separate from venueReady/custodyReady. Request handlers only read cached bounded observations: no probes, DB calls, signatures, errors, wallets, bot IDs, endpoints or policy JSON.

The public reader feeds validated API/WS observations; unknown/stale observations cannot become healthy zeroes. SDK verification is pin_only, not installed/chain attestation. The complete custody cohort sampler is deferred until the native account/queue/journal/protection/debt bindings exist. Its explicit trusted record interface accepts a complete fixed-field sample and refuses partial/invalid data. Until installed, RPC/custody/aggregate metrics remain unknown/null and venueReady remains false. These metrics are operational signals, never execution authorization.
