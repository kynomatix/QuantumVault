#!/usr/bin/env node
/**
 * Pyth on-chain price-account freshness probe — Phase 3a of docs/HERMES_EXIT_PLAN.md
 *
 * Reads Pyth "push oracle" price feed accounts directly from Solana mainnet
 * (no Hermes, no REST) and measures how stale they are. This is the baseline
 * measurement before we commit to relying on on-chain accounts instead of Hermes.
 *
 * Feeds covered:
 *   • Borrow-gate: SOL/USD, INF/USD, JitoSOL/USD
 *   • Flash perps (major): BTC/USD, ETH/USD
 *   • Flash perps (mid-cap alts): BONK/USD, WIF/USD
 *   • Flash perps (equity): AMZN/USD
 *   • Flash perps (commodity): CRUDEOIL/USD
 *
 * Usage:
 *   node scripts/probe-pyth-onchain-freshness.mjs [options]
 *
 * Options:
 *   --duration  <seconds>   Total run time   (default 300 = 5 min smoke test)
 *   --interval  <seconds>   Sample interval  (default 30)
 *   --threshold <seconds>   PASS/FAIL cutoff (default 90)
 *   --rpc       <url>       Override RPC URL (default: SOLANA_RPC_URL or Helius)
 *   --shard     <id>        Push-oracle shard id (default 0, the sponsored shard)
 *
 * 60-min full run (run this after the 5-min smoke passes):
 *   node scripts/probe-pyth-onchain-freshness.mjs --duration 3600 --interval 30
 *
 * Reads HELIUS_API_KEY / SOLANA_RPC_URL from the environment (same as the server).
 * No server imports. No writes. Throwaway script.
 */

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

// ── CJS imports (pyth SDK ships CJS) ────────────────────────────────────────
const { Connection, Keypair } = require("@solana/web3.js");
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");

// ── CLI arg helpers ──────────────────────────────────────────────────────────
function numArg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1 && process.argv[i + 1]) {
    const v = Number(process.argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`--${name} must be a positive number`);
      process.exit(1);
    }
    return v;
  }
  return dflt;
}
function strArg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

// ── Config ───────────────────────────────────────────────────────────────────
const DURATION_SEC  = numArg("duration",  300);
const INTERVAL_SEC  = numArg("interval",  30);
const THRESHOLD_SEC = numArg("threshold", 90);
const SHARD_ID      = numArg("shard",     0);

const RPC_URL = (() => {
  if (strArg("rpc", "")) return strArg("rpc", "");
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY)
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  // Public fallback — may rate-limit on many feeds
  console.warn("⚠  No SOLANA_RPC_URL or HELIUS_API_KEY found; using public RPC (may rate-limit)");
  return "https://api.mainnet-beta.solana.com";
})();

// ── Feed registry ────────────────────────────────────────────────────────────
// feedId = 32-byte hex (no 0x prefix) — from borrow-oracle-registry.ts and flash-constants.ts
const FEEDS = [
  // Borrow-gate feeds (server/vault/borrow-oracle-registry.ts)
  { symbol: "SOL/USD",      group: "borrow",    feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { symbol: "INF/USD",      group: "borrow",    feedId: "f51570985c642c49c2d6e50156390fdba80bb6d5f7fa389d2f012ced4f7d208f" },
  { symbol: "JitoSOL/USD",  group: "borrow",    feedId: "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb" },
  // Flash major perps (server/protocol/flash/flash-constants.ts)
  { symbol: "BTC/USD",      group: "flash",     feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { symbol: "ETH/USD",      group: "flash",     feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  // Flash mid-cap alts
  { symbol: "BONK/USD",     group: "flash-alt", feedId: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419" },
  { symbol: "WIF/USD",      group: "flash-alt", feedId: "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc" },
  // Flash equity
  { symbol: "AMZN/USD",     group: "flash-eq",  feedId: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a" },
  // Flash commodity (Crude Oil)
  { symbol: "CRUDEOIL/USD", group: "flash-com", feedId: "ce4c15100156d27c8bdd044d9804294e7bc0944dbb5b2b82a61a7aa85b6b3a5e" },
];

// ── Solana + Pyth setup ──────────────────────────────────────────────────────
const connection = new Connection(RPC_URL, "confirmed");

// Dummy keypair — read-only probe, never signs anything
const dummyKeypair = Keypair.generate();
const dummyWallet = {
  publicKey: dummyKeypair.publicKey,
  signTransaction:     async (tx) => tx,
  signAllTransactions: async (txs) => txs,
  payer: dummyKeypair,
};

const pythReceiver = new PythSolanaReceiver({ connection, wallet: dummyWallet });

// ── Sample state ─────────────────────────────────────────────────────────────
// Per feed: { ages: number[], errors: number, noAccount: boolean }
const state = Object.fromEntries(
  FEEDS.map((f) => [f.feedId, { ages: [], errors: 0, noAccount: false }])
);

// ── Single sample ────────────────────────────────────────────────────────────
async function sampleAll() {
  const nowSec = Math.floor(Date.now() / 1000);
  await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const feedIdBuf = Buffer.from(feed.feedId, "hex");
        const account = await pythReceiver.fetchPriceFeedAccount(SHARD_ID, feedIdBuf);
        if (!account) {
          state[feed.feedId].noAccount = true;
          return;
        }
        // priceMessage.publishTime is a BN (anchor / borsh i64)
        const publishTime = account.priceMessage.publishTime.toNumber();
        const ageSec = nowSec - publishTime;
        state[feed.feedId].ages.push(ageSec);
      } catch (err) {
        state[feed.feedId].errors += 1;
        // Log first error per feed only to avoid noise
        if (state[feed.feedId].errors === 1) {
          console.error(`  [${feed.symbol}] fetch error: ${err.message}`);
        }
      }
    })
  );
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function fmtSec(v) {
  if (v === null) return "  —  ";
  return `${v.toFixed(1)}s`.padStart(7);
}

function passFailSymbol(feed, s) {
  if (s.noAccount) return "NO_ACCT";
  if (!s.ages.length) return "NO_DATA";
  const mx = Math.max(...s.ages);
  return mx <= THRESHOLD_SEC ? "✓ PASS" : "✗ FAIL";
}

// ── Report ───────────────────────────────────────────────────────────────────
function printReport(elapsed) {
  const W = 95;
  console.log("\n" + "═".repeat(W));
  console.log(" Pyth On-Chain Freshness Report");
  console.log(
    ` Duration ${elapsed}s  |  Interval ${INTERVAL_SEC}s  |  Threshold ${THRESHOLD_SEC}s  |  Shard ${SHARD_ID}  |  RPC ${RPC_URL.slice(0, 60)}`
  );
  console.log("═".repeat(W));
  const hdr = [
    "Symbol".padEnd(14),
    "Group".padEnd(10),
    "Samples".padStart(7),
    "Min".padStart(7),
    "Median".padStart(7),
    "Max".padStart(7),
    "Errors".padStart(7),
    "Result".padStart(9),
  ].join("  ");
  console.log(hdr);
  console.log("─".repeat(W));
  for (const feed of FEEDS) {
    const s = state[feed.feedId];
    const mn  = s.ages.length ? Math.min(...s.ages) : null;
    const med = median(s.ages);
    const mx  = s.ages.length ? Math.max(...s.ages) : null;
    const row = [
      feed.symbol.padEnd(14),
      feed.group.padEnd(10),
      String(s.ages.length).padStart(7),
      fmtSec(mn),
      fmtSec(med),
      fmtSec(mx),
      String(s.errors).padStart(7),
      passFailSymbol(feed, s).padStart(9),
    ].join("  ");
    console.log(row);
  }
  console.log("─".repeat(W));

  const passes = FEEDS.filter((f) => {
    const s = state[f.feedId];
    return s.ages.length > 0 && Math.max(...s.ages) <= THRESHOLD_SEC;
  }).length;
  const noAcct = FEEDS.filter((f) => state[f.feedId].noAccount).length;
  const noData = FEEDS.filter(
    (f) => !state[f.feedId].noAccount && !state[f.feedId].ages.length
  ).length;
  const fails  = FEEDS.length - passes - noAcct - noData;

  console.log(
    `\n  ${passes} PASS  |  ${fails} FAIL  |  ${noAcct} NO_ACCT  |  ${noData} NO_DATA  (threshold: ≤${THRESHOLD_SEC}s)`
  );

  if (noAcct > 0) {
    const missing = FEEDS.filter((f) => state[f.feedId].noAccount).map((f) => f.symbol);
    console.log(`\n  NO_ACCT feeds have no sponsored on-chain account at shard ${SHARD_ID}.`);
    console.log(`  These will need Hermes or a different shard: ${missing.join(", ")}`);
  }
  if (noData > 0) {
    const nd = FEEDS.filter(
      (f) => !state[f.feedId].noAccount && !state[f.feedId].ages.length
    ).map((f) => f.symbol);
    console.log(`\n  NO_DATA feeds had zero successful reads (check errors above): ${nd.join(", ")}`);
  }

  console.log("\n  60-min full run:");
  console.log(
    "  node scripts/probe-pyth-onchain-freshness.mjs --duration 3600 --interval 30\n"
  );
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPyth On-Chain Freshness Probe`);
  console.log(`  Feeds    : ${FEEDS.length}`);
  console.log(`  Duration : ${DURATION_SEC}s`);
  console.log(`  Interval : ${INTERVAL_SEC}s`);
  console.log(`  Threshold: ${THRESHOLD_SEC}s`);
  console.log(`  Shard    : ${SHARD_ID}`);
  console.log(`  RPC      : ${RPC_URL.slice(0, 80)}\n`);

  const startMs = Date.now();
  const endMs   = startMs + DURATION_SEC * 1000;

  let sampleNum = 0;
  while (Date.now() < endMs) {
    sampleNum++;
    const remaining = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
    process.stdout.write(
      `  Sample #${sampleNum}  (${remaining}s remaining) ...`
    );
    const t0 = Date.now();
    await sampleAll();
    const tookMs = Date.now() - t0;
    process.stdout.write(` done in ${tookMs}ms\n`);

    const nextIn = Math.max(0, INTERVAL_SEC * 1000 - tookMs);
    if (Date.now() + nextIn < endMs) {
      await new Promise((r) => setTimeout(r, nextIn));
    } else {
      break;
    }
  }

  const elapsedSec = Math.round((Date.now() - startMs) / 1000);
  printReport(elapsedSec);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
