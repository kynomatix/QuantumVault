# Phoenix automatic debt defense (U12)

Phoenix remains disabled. `PHOENIX_AUTO_DEFENSE_ENABLED` is independent of
borrowing, trading and public reads. Production installation is deliberately
absent, matching U11's unresolved reviewed lender/settlement bindings.

The existing defender scan selects proven routes and independent top-up/repay
opt-ins. Phoenix dispatch occurs before any legacy account-wallet spend code.
Flash behavior, scheduler timing, account-level health observations and managed
SOL/INF-loop safety ownership are unchanged. Loops never enter this defender.

For a reviewed installation, compose `createPhoenixDefenseRuntime` with U11's
`PhoenixBorrowService`, `PhoenixBorrowStore` and `phoenix-lend-context`. Install
`automaticDefenseAuthorizer` as the service IO's `authorizeAutomatic`. The source
must read persisted owner/bot consent and reviewed limits, current loan identity,
strict balances and lender observations, and enumerate unresolved U11 journals
before proposing another action. It must persist/deduplicate attention through
the incumbent health reporting path. No HTTP input may provide these bindings.
An environment variable alone cannot install this composition.

Top-up uses only explicitly authorized, already held account collateral, capped
at the suggestion and reviewed per-attempt limit. Its bot reserve must remain
liquid. It cannot carve an account loan, swap, grow debt or deploy cash. Repayment
uses only authorized settled bot USDC, capped at fresh debt, the recorded target
and the reviewed limit. Bot gas is self-funded. Queued Phoenix returns, margin
and estimated parked value never count as cash. An unavailable route reports
needs-attention; it cannot request a withdrawal and promise an urgent repayment.

Lender and oracle freshness are separate from venue liveness. Authorization is
checked at selection, each primitive, and before broadcast. Durable preparation
atomically claims the existing ten-minute cooldown with the journal insert;
unresolved journals exclude subsequent requests even after that cooldown.
Opt-ins are rechecked under the bot lock at prepare, primitive claim and signature
recording. Replays retain request identity, amount and debt floor. Ambiguous
outcomes require U11's authoritative reconciliation; elapsed time never retries
a possibly submitted primitive. No schema migration is required.

Manual U11 repayment/reconciliation remains independent of the new-risk gate.
An existing automatic repayment can also resume after that gate closes while
its repayment opt-in and fresh lender/cash authorization remain valid. Revoked
authority or a stranded top-up reports attention and preserves its journal for
explicit recovery; the scanner cannot start another spend to work around it.
