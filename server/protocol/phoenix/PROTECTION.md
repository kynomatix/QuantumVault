# Phoenix U06 protection and safety

Phoenix remains disabled. There is no live signer, RPC writer, deployment pin or
HTTP enable switch. The protection and safety services accept injected IO for
reviewed integration; manual, automatic and breakeven requests share `protect`.
The production routes retain explicit unavailable outcomes. Pausing a Phoenix bot
stops ingress and reports unknown cancellation/close state, without entering
Pacifica custody or claiming that pausing itself cancelled anything.

## Native contract

Verified against Ellipsis-Labs/rise-public, sourceCommitHash:
573b773a6a7b38f941aed3a6f0602bc648346114 (Rise 0.6.1). Relevant upstream paths are
`ts/src/core/ixBuilders`, `ts/src/accounts`, `ts/src/conditionalOrders.ts` and
`ts/src/pdas.ts`. Public descriptions: https://docs.phoenix.trade/sdk/orders and
https://docs.phoenix.trade/phoenix/matching-engine/take-profit-stop-loss.

| Account/surface | Read authority | Cancellation instruction |
| --- | --- | --- |
| Market orderbook, including conditional parents | Finalized market order IDs, trader and position | `CancelAll` / `global:cancel_all`; book/arena accounts only |
| Trader `ConditionalOrderCollection` (parent-attached and position-native/orphan triggers) | Program-owned PDA `conditional_orders` + trader, complete active-index inventory, both trigger slots, parent ID, sequence, raw maximum/fillable/filled quantities and position sequence | `CancelConditionalOrder` / `global:cancel_conditional_order`; index 1–191, both disable booleans true; trader/book/collection writable |
| Asset-specific `StopLosses`, containing two standalone `StopLoss` slots | Program-owned PDA `stoploss` + trader + asset u64 LE, initialized flag, both slots, funding key and quantities | `CancelStopLoss` / `global:cancel_stop_loss`; direction GreaterThan=0 or LessThan=1; funder/stop-loss account writable |

`CancelAll` alone is never accepted as proof that all three surfaces are empty.
Each conditional cancellation names a collection index; standalone cancellation
names a direction. The native instructions have no expected-sequence argument.
The service checks sequence immediately before signing and requires a finalized
post-state, but cannot eliminate an external writer's on-chain index-reuse race.
Exclusive bot authority remains a prerequisite for future live enablement.

`PlacePositionConditionalOrder` uses explicit asset ID, one trigger, opposite
trade side, IOC kind=0, trigger ticks, bounded execution ticks and exact base-lot
quantity. Both triggers are native reduce-only. TP slippage is explicitly 0–25
bps and SL 0–1000 bps; neither field may be omitted. Buy limits round down and
sell limits round up to remain inside the selected bound. These bounds limit
execution price; IOC protection does not guarantee a fill through a market gap.

Entries require a complete, fresh, finalized protection inventory, an existing
conditional collection, a flat position and no unresolved orders/triggers. The
U05 IOC and two 100%-of-position native protection legs share one transaction;
the SL instruction comes before TP. A rejected bracket rolls back the entry.
Partial IOC fills therefore receive protection for the resulting position. No
collection is silently created or funded: provisioning/rent and live IO must be
reviewed before enablement. Missing or unknown protection stops entries.

## Reconciliation and recovery

The normalized reader retains raw quantities and reconciles remaining available
lots, capped by the current position. Percent-based detached triggers use the
current position percentage. Parent IDs that disappear while triggers remain are
reported as orphans. Fully detached triggers have a null parent; a stale position
sequence or opposite position flip cannot satisfy protection. The standalone
account is always included, even when the collection is absent.

Replacement refuses live parents, captures authoritative before-state and
cancels every existing target-asset trigger before installing SL then TP. It
checks position side, epoch, sequence and amount before each placement. A
breakeven change may not loosen an existing stop. Success requires exactly two
matching legs with the intended side, ticks and remaining position quantity.
Each transaction has a durable U02 write-ahead attempt and a bound finalized
receipt. Progress, before/after snapshots and surviving legs persist in the
operation record; a failed TP replacement explicitly retains the surviving SL.
Unknown submission outcomes remain pending across restart, without blind resend.

Pause cancels the book first and re-reads accounts before every subsequent step.
A parent cancellation may remove its children; already absent legs are skipped
only after authoritative reads. Final success also checks for outstanding local
transactions that could still land. Incomplete API responses, stale reads and
unavailable receipts never establish cancellation or flatness.

Close uses the U05 reduce-only executor and independent position evidence; it
does not require protection reads or an entry capability. A failed cancellation
does not suppress a requested close. A partial close remains incomplete until
the settled order and fresh, signature-bound position proof both show zero.
Withdrawal/transfer admission is not blocked merely by unresolved protection.
No Phoenix fallback uses Pacifica. Production safety remains unavailable until
reviewed IO is installed, explicitly reported rather than simulated success.

Migration 188 extends the U02 operation kinds and attempt ceiling, separates
active protection replacement from funding exclusion, and keeps cancellations
admissible. Catalog guards preserve existing healthy constraints/indexes on
repeat boot, following migration 186. Readiness checks cover the final schema.
