# Phoenix connector folds (proposals only)

The candidate contracts live in shared/phoenix-connector-proposals.ts. They add no connector routes, grants, spend scope or implementation. All execution proposals say executable=false; unavailable implementation/capabilities are explicit. Owner-scoped account values belong only in authenticated incumbent connector responses, never public health. Account, queue and liability observations preserve fresh/stale/unknown and null versus zero.

| Incumbent owner | Proposed fold | Capability boundary |
| --- | --- | --- |
| C:/Apps/Replit/QuantumVault-gh/docs/work-orders/platform/claude-connector-00-auth-foundation/wo.md | Bind owned bot, separate wallet authority and trader PDA to existing scoped grant. | No Phoenix spend grant; custody proof remains in server binding. |
| C:/Apps/Replit/QuantumVault-gh/docs/work-orders/platform/claude-connector-01-read-diagnose/wo.md | Owned account, positions/orders, protective gaps, queues and original recovery IDs with observation time. | Native complete account/queue reader unavailable; defer implementation. No global diagnostics. |
| C:/Apps/Replit/QuantumVault-gh/docs/work-orders/platform/claude-connector-02-confirmation-ledger/wo.md | Exact venue/bot/action, amount, fee and queue leg proposal under existing one-use expiry/revoke/live revalidation. | Proposal is not executable; no new debt, yield or external-withdraw scope. |
| C:/Apps/Replit/QuantumVault-gh/docs/work-orders/platform/claude-connector-03-manage-archive/wo.md | PAUSED creation and archive with retained wallet/PDA/custody/journals/lender IDs and explicit liabilities. | No implicit funding; unknown liabilities prohibit destructive retirement. |
| C:/Apps/Replit/QuantumVault-gh/docs/work-orders/platform/claude-connector-04-internal-funds/wo.md | Bounded existing internal allocation/return proposals with exact queue and unresolved journal semantics. | Queued return is not cash. Borrow/yield/external withdrawals excluded; defer native execution. |
| C:/Apps/Replit/QuantumVault-gh/docs/work-orders/platform/claude-connector-05-lab-read/wo.md | Owner-only result/candle provenance with untrusted Pine label. | Research results grant no execution permission. |

Each incumbent owner must review its eventual fold in its own work order. U16 does not edit those contracts or widen connector authorization. The health projection follows the existing dependency-health-record work order at C:/Apps/Replit/QuantumVault-gh/docs/work-orders/platform/dependency-health-record/wo.md; this incumbent is still a draft, so U16 reuses the current health payload and its bounded cached-observation contract, without creating a competing health endpoint or readiness gate.
