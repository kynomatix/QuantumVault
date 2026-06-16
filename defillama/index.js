// QuantumVault — DeFiLlama TVL Adapter
//
// Copy this file into a DefiLlama-Adapters fork at: projects/quantumvault/index.js
//
// TVL = the sum of every QuantumVault user's USDC across their server-managed
// Pacifica trading accounts PLUS any uninvested USDC still sitting in their
// agent wallets, aggregated server-side from 12-hourly portfolio snapshots.
// Denominated in USDC (CoinGecko id: usd-coin, treated 1:1 with USD).
//
// ACCOUNT MODEL (important for reviewers): QuantumVault is an automated bot
// trading layer on top of Pacifica Protocol (a Solana perpetuals exchange).
// Each bot trades from a dedicated, server-managed Pacifica account that is a
// STANDALONE ed25519 keypair (created with Keypair.generate()). It is NOT a PDA,
// NOT derived from or controlled by the user's wallet, and NOT a Pacifica
// "native subaccount" of the user's main account.
//
// DOUBLE-COUNT NOTE: those balances live INSIDE Pacifica Protocol accounts, so
// QuantumVault's TVL is a proper subset of Pacifica's on-chain TVL. Ask the
// DeFiLlama reviewer to set parentProtocol = pacifica (child relationship) so
// the value is not double-counted in chain/category totals.

async function tvl() {
  const response = await fetch("https://myquantumvault.com/api/tvl");
  if (!response.ok) throw new Error(`TVL fetch failed: ${response.status}`);
  const data = await response.json();
  // { usd_coin: <number> }  — total USDC in USD terms (1:1 peg)
  return data;
}

module.exports = {
  timetravel: false,
  misrepresentedTokens: false,
  methodology:
    "Sum of every QuantumVault user's USDC across their server-managed Pacifica " +
    "trading accounts plus uninvested USDC in their agent wallets, aggregated " +
    "from 12-hourly on-chain portfolio snapshots. QuantumVault is an automated " +
    "bot trading layer on Pacifica Protocol (Solana perpetuals); each bot trades " +
    "from a dedicated standalone Pacifica account (a generated keypair, not a PDA " +
    "and not derived from the user's wallet). These balances are a subset of " +
    "Pacifica's TVL, so QuantumVault is a child of Pacifica.",
  solana: {
    tvl,
  },
};
