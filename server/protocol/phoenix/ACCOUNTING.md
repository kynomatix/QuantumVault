# Phoenix reconciliation and accounting (U07 + U08)

Phoenix remains disabled. These modules neither sign nor submit transactions. The
accounting service accepts only a trusted provider's finalized, complete account
snapshot and paginated fill/liquidation/ADL/funding history from a proved flat
registration origin. No production history provider is installed. A terminal REST
page alone is not proof that every event family is indexed through the snapshot.
Native funding attribution, timestamp units, fee/PnL semantics and fee-tier evidence
must be verified for that provider before live activation. Rise FillRecord is mapped
by trader ID, portfolio/subaccount indices, native instruction coordinates and
transaction signature. Monetary strings must be exact USDC micro-units; precision
is never silently rounded. Unknown native fill IDs can be enriched later.

Reconciliation replays from registration on every run, including reconnects. It
rejects cursor loops, missing pages, regressed watermarks, inconsistent positions,
lost durable events and changed known money. An opening plus adds and partial closes
is one position epoch until flat. Flips close the old epoch and open the residual;
gross realization belongs to the closed epoch and signed fees split proportionally,
with integer remainder retained by the new epoch. Net PnL is gross minus signed
venue fees plus signed funding credits. Liquidations and ADL use the same chain of
before/after quantities. Missing PnL/fees/funding leaves accounting incomplete.
Funding requires an explicit opening-event binding, so a late settlement updates
its original closed epoch even if another position has since opened.

Migration 189 follows repeat-boot CREATE IF NOT EXISTS guards. A transaction locks
the bot, verifies owner/trader/confirmed registration, checks revision and all prior
events, derives epochs again, and persists events, epochs, provenance and equity
snapshots atomically. Replays deduplicate rows and order links. Snapshots are content
addressed and retained; observations at a new time are distinct evidence. U05 order
links require matching transaction signatures, market and receipt fill IDs. Neither
an IOC completion nor a reconciliation clears ambiguous orders/cancellations or
changes a U04 transfer/withdrawal state. Bad fresh evidence invalidates current
accounting without deleting older evidence.

Equity sums wallet USDC, valued wallet collateral, venue equity, parked value and
proved separate transit value, less external debt. Queue, free margin and unrealized
PnL are memorandum components, never added again. U04 does not yet prove a distinct
debited/uncredited transit asset: persisted pending returns must bind an unresolved
U04 operation and retain unknown valuation. Missing component valuation means
unknown total equity. Aggregate equity is never sizing authority. Trading PnL is
not a deposit/yield/network-cost basis, so legacy percentage PnL stays unknown.

Both shared reconciliation entrypoints explicitly route Phoenix before legacy
adapter resolution. Wallet financial snapshots use the Phoenix ledger; the public
snapshot job persists via reconciliation instead of the legacy estimated series.
Owner detail is available at GET /api/phoenix/bots/:botId/accounting (wallet auth);
active published performance is available at GET
/api/phoenix/performance/:publishedBotId. Public responses omit payer, trader,
transaction, subscription and operation identifiers. Historical records remain
visible when current evidence is stale, with current status unknown. No legacy
Pacifica rows are repurposed; existing Pacifica branches retain their behavior.

Provenance captures the subscriber bot, payer, subscription, creator, epoch, exact
fills, signed fees and funding. The first epoch binding is retained across replay.
It is not a payable obligation. Creator payouts and Flight fees remain disabled;
the shared creator entry/retry paths reject Phoenix before claiming or sending.
The following prerequisite work orders were still draft at implementation:

- C:/Apps/Replit/QuantumVault-gh/docs/work-orders/marketplace/profit-share-creator-earnings-truth
- C:/Apps/Replit/QuantumVault-gh/docs/work-orders/marketplace/profit-share-durable-obligation-ledger
- C:/Apps/Replit/QuantumVault-gh/docs/work-orders/marketplace/profit-share-payment-claim-settlement

No pending cash, unknown PnL or ambiguous submission can authorize a Phoenix payout.
Accepted incumbent semantics and a separate reviewed activation are required.
