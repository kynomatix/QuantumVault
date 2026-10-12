# Phoenix autonomous defense bindings

Top-up and repayment opt-ins are independent. A missing top-up suggestion must
still permit a viable opted-in repayment. Top-up requires botHealthAllowed and
accountCarveAllowed because it moves account collateral. Repayment deliberately
does not require botHealthAllowed: reducing existing debt must remain possible
when that risk gate blocks additional exposure. It still requires authenticated
custody, fresh complete lender/oracle observations, reserve consent, bounded bot
wallet cash and the write-ahead repayment journal.

The server resolves last_auto_topup_attempt_at. Its request-key serialization is
either null or a UTC ISO timestamp with milliseconds, before hashing the loan and
timestamp fields. Equivalent offset representations bind to one key; invalid
timestamps require attention. Observation timestamps never replace this durable
attempt identity. Production bindings remain disabled pending live proofs.
