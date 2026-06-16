# QuantumVault — DeFiLlama Adapter Submission

**Status:** Ready to submit (Option A — API-based).
**Upgrade path:** Option B (on-chain reads via an account-pubkey registry) — see bottom.

> This directory is the **canonical, version-controlled** submission package.
> `index.js` here is copy-paste ready for a DefiLlama-Adapters fork.
> (The older `docs/DEFILLAMA_ADAPTER.md` is a local note only — `docs/` is gitignored.)

The server side is already live: `GET https://myquantumvault.com/api/tvl` returns
`{ "usd_coin": <number> }` — the exact shape DeFiLlama polls — backed by
`storage.calculatePlatformTVL()`. **Do not change the endpoint;** this task is submission prep only.

---

## 1. Fork & create the adapter file

Fork https://github.com/DefiLlama/DefiLlama-Adapters, then create:

```
projects/quantumvault/index.js
```

Paste the contents of [`./index.js`](./index.js) (in this directory) verbatim.

## 2. PR template answers

| Field | Value |
|---|---|
| **Twitter/X** | (owner's handle) |
| **Website** | https://myquantumvault.com |
| **Audit link** | N/A (no vault/smart contract — funds sit in standard Pacifica accounts) |
| **Expected TVL** | ~$50K–$200K (early, growing). Current live ≈ $2.25K at time of submission prep. |
| **Chain** | Solana |
| **CoinGecko ID** | `usd-coin` (USDC-denominated) |
| **Short description** | QuantumVault is a Solana perpetuals bot trading platform. Users deploy automated trading bots on Pacifica Protocol with dedicated, server-managed keypairs. TVL is the total USDC across all user accounts. |
| **parentProtocol** | `pacifica` — ask the reviewer to add this; our TVL is a subset of Pacifica's. |

## 3. Test locally before opening the PR

```bash
git clone https://github.com/YOUR_FORK/DefiLlama-Adapters.git
cd DefiLlama-Adapters
pnpm install
node test.js projects/quantumvault/index.js
```

Expected output: `{ usd_coin: <current TVL in USD> }`.

## 4. Open the PR

1. Commit `projects/quantumvault/index.js` to your fork.
2. Open a PR against `DefiLlama/DefiLlama-Adapters` titled `Add QuantumVault`.
3. Fill in the PR template using the table in §2.
4. In the PR body, explicitly ask the reviewer to set **`parentProtocol: pacifica`** (our funds are
   a subset of Pacifica's on-chain TVL — this prevents double-counting).
5. Respond to reviewer questions; once merged, QuantumVault appears on DeFiLlama and the value
   refreshes automatically (DeFiLlama polls `/api/tvl` ~every 5 min).

---

## Account model (accurate — verified in code & on-chain)

QuantumVault is an **automated bot trading layer on Pacifica Protocol** (a Solana perpetuals
exchange). Each bot trades from a **dedicated, server-managed Pacifica account** that is a
**standalone ed25519 keypair** (`Keypair.generate()`, see `server/routes.ts` ~2117). That account:

- is **on-curve** (an ordinary keypair) — **NOT a PDA**;
- is **NOT derived from or controlled by** the user's agent wallet (`derivation_index = NULL`);
- is **NOT a Pacifica "native subaccount"** of the user's main account.

User USDC sits inside these Pacifica accounts, so QuantumVault's TVL is a **proper subset of
Pacifica's on-chain TVL** → list QuantumVault as a **child of Pacifica** (`parentProtocol = pacifica`).

> ⚠️ Do **not** describe these as "PDAs controlled by the user's agent keypair." That was an
> earlier mistaken description; it is factually wrong. The accounts are randomly generated keypairs.

---

## Option B — On-chain adapter (future upgrade)

Replace the API-based `tvl()` with direct on-chain reads (DeFiLlama reviewers prefer this for
long-term reliability — no API dependency).

**Key constraint:** because each bot's Pacifica account is a **randomly generated standalone
keypair** (not a PDA and not derived from the agent wallet), the account addresses **cannot be
derived** from anything. They must be read from a **registry of account pubkeys**:

1. Expose a public, read-only endpoint that lists every active bot's Pacifica account pubkey (the
   `protocol_subaccount_id` column on the bots table) — or read it from the DB if the adapter runs
   with DB access.
2. For each account pubkey, fetch its on-chain USDC balance on Pacifica (read the account's USDC
   token balance / decode Pacifica's account layout).
3. Sum the USDC balances across all accounts.

This requires the registry endpoint above plus Pacifica's account layout, so it's a follow-up — not
part of this submission.

---

## Maintenance

`/api/tvl` is backed by `storage.calculatePlatformTVL()`, which sums the most recent
`portfolio_daily_snapshots` balance per wallet (updated ~every 12 hours by the snapshot job). No
manual updates are needed — DeFiLlama polls about every 5 minutes and always gets the freshest
stored value.
