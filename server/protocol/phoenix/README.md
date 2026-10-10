# Phoenix U01 public read boundary

Disabled by default. PHOENIX_READS_ENABLED must equal true exactly. This enables unauthenticated display reads only; it cannot enable trading, account registration, signing, deposits or withdrawals. Phoenix is explicitly rejected by the money adapter registry. Pacifica default and startup remain unchanged. Account/schema/venue selectors are not widened.

## SDK compatibility and public evidence

The wire/conversion boundary is pinned to @ellipsis-labs/rise version 0.6.1 and SDK source commit hash: 573b773a6a7b38f941aed3a6f0602bc648346114. This is a source compatibility pin, not an installed SDK or executable SDK integration. No npm dependency is added; package.json and package-lock.json are unchanged. Existing ws is reused. No Solana Kit/web3 object or PDA crosses into a signer.

Sources: https://registry.npmjs.org/@ellipsis-labs%2frise/0.6.1 and https://github.com/Ellipsis-Labs/rise-public/tree/573b773a6a7b38f941aed3a6f0602bc648346114 . Published production program and wallet USDC constants are checked against SDK core/constants.ts; Ember and wrapped collateral also match https://docs.phoenix.trade/phoenix/collateral-and-accounts/collateral . Public exchange canonicalMint must match the pinned wrapped collateral mint before any catalog is accepted. These are published addresses, not deployed binary or upgrade authority attestation.

Public GET /v1/view/exchange and /v1/view/exchange/status were read unsigned on 2026-10-11. The catalog contained 94 markets. Every published market is retained, with exact venue spelling (including kBONK) and a normalized SYMBOL-PERP mapping. No BTC/ETH/SOL allowlist. Active, disabled, missing, stale and unknown states remain distinct. The status was active and gated with withdrawalsAvailable true; this does not establish onboarding eligibility.

The verified wss://perp-api.phoenix.trade/v1/ws subscriptions are exchange and allMids. Exchange returns version 1 encodedSnapshot/base64+zstd metadata with sequenceNumber; U01 does not decode compressed payloads. First snapshot, reconnect, updates and gaps invalidate metadata; a bounded REST snapshot repairs it. allMids publishes complete price maps with slot/slotIndex: older/duplicate frames are ignored; jumps are accepted as full replacements. Prices expire after 15 seconds and are always display-only. Metadata expires after 120 seconds; read failures retain stale values with reasons, never zero balances or guessed prices.

## Budgets and limits

Numeric venue quotas are unpublished in the verified sources. PHOENIX_READ_REFRESH_MS accepts 30000 through 60000 milliseconds, default 60000. One two-endpoint snapshot at a time, coalesced calls, 5-second HTTP deadlines, 2 MB response limit, fixed GET allowlist, no redirects, and at least a 60-second hold on 429 respecting longer Retry-After. WS uses one connection, two public subscriptions, 256 KiB frames, 5-second handshake, 45-second liveness timeout, and exponential reconnect delay from 5 to 60 seconds. There is no event backlog. Unknown schemas fail stale/unknown. Encoded metadata is invalidation-only, so frequent updates may keep metadata conservatively stale. No user request triggers upstream I/O.

## Amounts, fees and withdrawals

Conversions accept decimal strings and use bigint. Base lots floor amount times 10^baseLotsDecimals; negative decimals divide. Price first floors to micro-USD, then converts using tickSize and baseLotsDecimals. Raw tickSize is not a dollar tick: BTC tickSize 100 with decimals 4 is USD 1. Lot and tick display values remain decimal strings. Precision outside the reviewed range is unknown; invalid conversion parameters throw. There is no guessed minimum notional or transfer amount. Published maker/taker rates are fractions, not basis points or account-specific fee quotes; maximum leverage is informational only.

Withdrawal availability and the published withdrawQueue account are timestamped observations. No verified public queue-length, settlement-status endpoint or measured/published delay was found; those fields remain explicit unknowns. A queue address is not evidence of queue length, completion or duration. No withdrawal was attempted. The Equity detail is rendered only for a Phoenix bot while Equity is visible, showing Withdrawal delay not yet measured until a sourced fresh observation exists. Queued funds are never represented as spendable wallet cash. The app-only 0.50 USDC fee is not imported.

All debt, carry, parking and recycling capabilities are unavailable. Recycling permanence and account quota are unknown. Wallet funds, venue collateral, withdrawable balance and queued returns are separate unknown observations. U01 folds only the small pure PhoenixTraderIdentity type into the contract; U02 still owns durable identity, schema constraints/migrations, allocation, policy binding, recovery and operation replay identities.

## Legacy method audit

All 62 declarations in ProtocolAdapter were checked against the current worktree. This table describes correspondence, not structural ProtocolAdapter conformance. No legacy method can be dispatched to this read-only reader.

| Legacy method | U01 disposition |
| --- | --- |
| initialize | Separate startPhoenixPublicReads / refresh; not a money adapter. |
| shutdown | Separate reader/stream shutdown; stale retained observations. |
| healthCheck | No legacy method; publicReads and timestamped observations expose health. |
| getCapabilities | Separate PhoenixReadCapabilities; every money operation explicitly unavailable. |
| getMarkets | Implemented on public reader with observation, status, exact lots/ticks and unknown minimum. |
| getPrice | Implemented on public reader as a timestamped display observation; never order authority. |
| getAllPrices | Separate getPrices; all published mids mapped against full catalog, 15-second expiry. |
| getCachedPrices (optional) | Separate getPrices; synchronous clone, no I/O, preserves stale state. |
| getCachedPriceMeta (optional) | Included in getPrices observation; no legacy numeric fallback. |
| getCachedMarketSymbols (optional) | Included in getMarkets; stale and disabled markets remain distinguishable. |
| getOrderbook | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getFundingRate | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getMaintenanceMarginWeight | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| quantizeOrderSize | Pure phoenixBaseUnitsToLots helper only; no executable order sizing. |
| quantizePrice | Pure phoenixPriceUsdToTicks helper only; no executable order pricing. |
| getAccountInfo | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getFeeRateQuote (optional) | Unsupported account quote; published market rates are display-only, not tier authority. |
| getOrderFeeRateQuote (optional) | Unsupported order quote; public schedule does not authorize sizing. |
| getPositions | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getStrictPositionForMarket (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getBalances | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getEquityHistory | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getTradeHistory | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getBatchAccountInfo | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getBatchPositions | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| placeMarketOrder | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| placeLimitOrder | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| cancelOrder | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| cancelAllOrders | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| closePosition | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| setLeverage | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| setMarginMode | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| placeStopOrder (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| setTpSl (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getLiveBreakevenAuthoritySnapshot (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| moveLiveBreakevenStop (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| cancelStopOrder (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| cancelTpSlOrders (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| executeDeposit | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| executeWithdraw | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| transferBetweenSubaccounts | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| fundBotWalletCollateral (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| createSubaccount | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| listSubaccounts | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| discoverSubaccounts | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| closeSubaccount (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| subaccountExists (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getWalletCollateralBalance (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getOpenOrders (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getOpenStopOrders (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getOpenProtectiveOrders (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| verifySubaccountEmpty (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| assessAgentWalletResetStateStrict (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| reuseSubaccount (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| waitForMainAccountBalance (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| getAdapterDiagnostics (optional) | Separate cached readiness endpoint; no legacy diagnostics adapter. |
| settlePnl | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| subscribeToFills (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| subscribeToPositionUpdates (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| subscribeToOrderUpdates (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| prepareBindMessage (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |
| confirmBind (optional) | Unsupported: no implementation or route into Phoenix; money registry rejects registration. |

## Venue comparison audit

All 126 discovery literal candidates were found verbatim in the current sources and checked by path/context. Existing database and request allowlists exclude Phoenix; U01 does not change them. Public reader registration is separate and the money registry additionally rejects Phoenix. Existing Flash/Pacifica/Drift money branches cannot be reached through this reader. The full line/context mapping is in the U01 handback VENUE-AUDIT.json. Computed dispatch and default-adapter paths were also checked at the registry boundary: missing Phoenix never falls back to Pacifica there. Later units must explicitly revise their own account/execution/UI branches before activation; this audit is not permission to widen an allowlist.

## Validation scope

TEST-RISK: REQUIRED. Owner requested focused FRACTAL tests for conversion, malformed/unknown data, all-market coverage, queue/capability separation, stale prices, WS ordering/gaps/reconnects, bounded transport, default-off isolation and withdrawal rendering. No full suite, local tests, installs or builds. Exact candidate hash and FRACTAL counts belong in the handback report. Kimi review and any freeze remain separate gates.
