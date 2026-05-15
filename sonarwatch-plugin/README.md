# QuantumVault SonarWatch Plugin

This directory contains the source for the QuantumVault plugin that ships in
the [`sonarwatch/portfolio`](https://github.com/sonarwatch/portfolio) monorepo
to surface QuantumVault positions on `jup.ag/portfolio`.

It is kept here so the plugin and the public API it consumes
(`/api/public/portfolio`) evolve together.

## Layout

```
sonarwatch-plugin/
└── quantumvault/
    ├── constants.ts        # platformId + Platform metadata
    ├── types.ts            # mirror of the public API response contract
    ├── positionsFetcher.ts # fetches, maps to PortfolioElement[]
    └── index.ts            # exports platforms / jobs / fetchers
```

## How it works

The fetcher calls **one** endpoint:

```
GET https://myquantumvault.com/api/public/portfolio?wallet=<owner>
```

The endpoint:
- Returns HTTP 200 with `{ protocols: [] }` for unknown wallets (never 404).
- Is rate-limited per IP and per wallet, with a 30s server-side cache.
- Returns a `protocols[]` array of blocks. Each block has `status: 'ok' |
  'partial' | 'error' | 'circuit_open' | 'unavailable'` so the plugin can
  render partial results when one protocol (or one subaccount within a
  protocol) is down.

The fetcher maps blocks to SonarWatch elements:

| Block id        | Element                                              |
|-----------------|------------------------------------------------------|
| `agent_wallet`  | `multiple` element labelled "Agent Wallet (idle)"    |
| `pacifica`, ... | `leverage` element grouped by protocol               |

Per-protocol error/circuit-open blocks are silently skipped so the rest of
the portfolio still renders.

## Submitting the PR

1. Fork [`sonarwatch/portfolio`](https://github.com/sonarwatch/portfolio).
2. From the repo root, scaffold a new plugin with the SonarWatch generator,
   then replace its files with the contents of `sonarwatch-plugin/quantumvault/`:

   ```bash
   nx generate @nx/plugin:plugin quantumvault
   cp -r /path/to/quantumvault-repo/sonarwatch-plugin/quantumvault/* \
         packages/plugins/src/plugins/quantumvault/
   ```

3. Wire the plugin into the SonarWatch plugin index
   (`packages/plugins/src/index.ts`):

   ```ts
   import * as quantumvault from './plugins/quantumvault';
   // ...add quantumvault to the platforms / fetchers exports.
   ```

4. Run the fetcher locally against a real QuantumVault wallet:

   ```bash
   QUANTUMVAULT_API_BASE=https://myquantumvault.com \
     nx run plugins:run-fetcher --fetcherId=quantumvault-positions \
                                --owner=<solana-wallet-address>
   ```

   Verify the output shape matches `PortfolioElement[]`.

5. Open a PR against `sonarwatch/portfolio` with:
   - A short description of the QuantumVault platform.
   - A sample fetcher output.
   - A link to the public endpoint contract (this README and
     `server/public-portfolio.ts` in the QuantumVault repo).

## Endpoint contract

```ts
type ProtocolStatus = 'ok' | 'partial' | 'error' | 'circuit_open' | 'unavailable';

interface PortfolioPosition {
  symbol: string;            // e.g. "BTC"
  side: 'long' | 'short';
  size: number;              // base-asset size, always positive
  entryPrice: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
}

interface PortfolioProtocolBlock {
  id: string;                // 'agent_wallet' | 'pacifica' | 'drift' | ...
  status: ProtocolStatus;
  error?: string;
  balance: Record<string, number>;
  positions: PortfolioPosition[];
}

interface PortfolioResponse {
  asOf: number;              // unix ms
  wallet: string;
  protocols: PortfolioProtocolBlock[];
}
```

No bot IDs, secrets, or internal identifiers are ever returned — only the
fields above.
