# Phoenix carry deployment and recovery

Production carry is disabled. Enabling a switch cannot install the reviewed
queue observer, verified accounting history, vault builder, lender executor,
authenticated custody, deployment pins or owner canary grant. Deployment must
bind complete bot snapshots, measured queue delay and fees, authoritative lender
and oracle observations, exact vault/loan identities, bounded separate repayment
reserves and persisted user consent. Queued collateral is never wallet cash.

U13 owns the durable chain; U04 owns funding children, U10 owns signed vault
attempts and U11 owns lender journals. Recovery preserves the original intent,
leg, request key and signature. A claimed leg without a receipt emits an operator
reconciliation warning. Missing receipts, timeouts and lost acknowledgements do
not prove absence and cannot authorize a second broadcast. Operators inspect the
durable child and authoritative finalized history before resolving it.

Borrow retries are bounded at observation time as well as initial submission.
U11 may retry the same durable lender key only after an authoritative observation
marks the prior attempt absent and fresh lender/oracle state, original consent,
reserve and all amount limits still pass. There is no timer-based resend, new
request key, unbounded borrowing or retry inferred from a missing signature.
Repay/unwind can recover after risk is disabled, but require readable fresh lender
state at broadcast. No live queue, fee or lender proof is supplied by these docs.

Post-borrow parking uses the completed borrow's persisted authorization, never an
HTTP amount. Its U10 snapshot must bind that authorization to credited bot cash
and park consent; idle auto-park opt-in is not required for this bounded path.
