/**
 * SOL Loop Vault — P1a: dust-size mainnet probe.
 *
 * Proves the ATOMIC loop transaction end-to-end (kills the tx-size unknown):
 *
 *   OPEN : wrap P SOL -> flash-borrow F WSOL -> swap (P+F) WSOL -> LST
 *          -> operate(deposit LST, borrow F) -> flash-payback F
 *   CLOSE: flash-borrow ~debt -> operate(repay MAX, withdraw MAX)
 *          -> swap LST -> WSOL -> flash-payback -> unwrap leftovers
 *
 * Uses a DEDICATED throwaway wallet (never a product/agent wallet):
 *   node scripts/probe-sol-loop.mjs gen         # create probe wallet, print address
 *   ...fund it with ~0.15 SOL from Phantom...
 *   node scripts/probe-sol-loop.mjs open        # build + SIMULATE only (default)
 *   node scripts/probe-sol-loop.mjs open --send # actually execute on mainnet
 *   node scripts/probe-sol-loop.mjs status      # live position + balances
 *   node scripts/probe-sol-loop.mjs close --send
 *
 * Flags: --lst jupSOL|JitoSOL|INF|mSOL   (default jupSOL)
 *        --sol 0.05                      (principal, default 0.05)
 *        --leverage 2                    (default 2)
 *        --slippage-bps 50               (default 50)
 *
 * Money notes (owner-run, dust-size):
 *   - positionId 0 mints a position NFT: ~0.0215 SOL rent, NOT recoverable on
 *     close (known platform-wide; the NFT is reusable for later probes — the
 *     nftId is saved in the state file and reused automatically).
 *   - Everything else round-trips: flash fee is 0 on Jupiter Lend, swap cost
 *     at this size is < 0.01%.
 *   - Wallet file: .local/qntsol/probe-wallet.json (gitignored). Sweep the
 *     leftover SOL back to Phantom when done.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const DIR = ".local/qntsol";
const WALLET_PATH = path.join(DIR, "probe-wallet.json");
const STATE_PATH = path.join(DIR, "probe-state.json");

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const VAULTS_URL = "https://lite-api.jup.ag/lend/v1/borrow/vaults";
const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_IX_URL = "https://lite-api.jup.ag/swap/v1/swap-instructions";

// Pinned by vaultId (the authority); symbol asserted against the live API.
const LSTS = {
  jupsol: { vaultId: 4, symbol: "JupSOL" },
  jitosol: { vaultId: 5, symbol: "JitoSOL" },
  inf: { vaultId: 42, symbol: "INF" },
  msol: { vaultId: 47, symbol: "mSOL" },
};

const TX_SIZE_LIMIT = 1232;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const SEND = process.argv.includes("--send");

function rpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  throw new Error("Set SOLANA_RPC_URL or HELIUS_API_KEY");
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url.split("?")[0]} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function loadState() {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {};
}
function saveState(patch) {
  const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ---------- tiny hand-rolled SPL instructions (spl-token import is unreliable here) ----------
function ataFor(web3, owner, mint) {
  return web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new web3.PublicKey(TOKEN_PROGRAM).toBuffer(), mint.toBuffer()],
    new web3.PublicKey(ATA_PROGRAM),
  )[0];
}
function ixCreateAtaIdempotent(web3, payer, owner, mint) {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(ATA_PROGRAM),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataFor(web3, owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new web3.PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}
function ixSyncNative(web3, account) {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(TOKEN_PROGRAM),
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  });
}
function ixCloseAccount(web3, account, dest, owner) {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(TOKEN_PROGRAM),
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}
function deserializeJupIx(web3, ix) {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new web3.PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

async function resolveVault(lstKey) {
  const reg = LSTS[lstKey.toLowerCase()];
  if (!reg) throw new Error(`Unknown LST '${lstKey}'. Options: ${Object.values(LSTS).map((l) => l.symbol).join(", ")}`);
  const vaults = await fetchJson(VAULTS_URL);
  const v = vaults.find((x) => Number(x.id) === reg.vaultId);
  if (!v) throw new Error(`vaultId ${reg.vaultId} not in API`);
  const sym = v.supplyToken?.symbol || "?";
  if (sym.toUpperCase() !== reg.symbol.toUpperCase()) throw new Error(`vaultId ${reg.vaultId} serves ${sym}, expected ${reg.symbol} — refusing`);
  if ((v.borrowToken?.address || "") !== WSOL_MINT) throw new Error(`vault ${reg.vaultId} does not borrow WSOL — refusing`);
  return { vaultId: reg.vaultId, symbol: reg.symbol, lstMint: v.supplyToken.address, minBorrowRaw: BigInt(v.minimumBorrowing || "0") };
}

async function loadWallet(web3) {
  if (!existsSync(WALLET_PATH)) throw new Error(`No probe wallet. Run: node scripts/probe-sol-loop.mjs gen`);
  const secret = Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, "utf8")));
  return web3.Keypair.fromSecretKey(secret);
}

async function jupQuote(inputMint, outputMint, amountRaw, slippageBps) {
  const u = `${QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  return fetchJson(u);
}
async function jupSwapIxs(quote, userPublicKey) {
  return fetchJson(SWAP_IX_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: false }),
  });
}

async function loadAlts(web3, connection, addresses) {
  const uniq = [...new Set(addresses)];
  const out = [];
  for (const addr of uniq) {
    const r = await connection.getAddressLookupTable(new web3.PublicKey(addr));
    if (r.value) out.push(r.value);
  }
  return out;
}

async function buildAndRun(web3, connection, wallet, instructions, alts, label, onSent) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new web3.TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(alts);
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([wallet]);
  const size = tx.serialize().length;
  const fits = size <= TX_SIZE_LIMIT;
  console.log(`\n[${label}] tx size: ${size} / ${TX_SIZE_LIMIT} bytes ${fits ? "✅ FITS" : "❌ TOO BIG"} (${instructions.length} ixs, ${alts.length} ALTs)`);
  if (!fits) return { fits, size };

  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.log(`[${label}] simulation FAILED:`, JSON.stringify(sim.value.err));
    console.log((sim.value.logs || []).slice(-14).join("\n"));
    return { fits, size, simOk: false };
  }
  console.log(`[${label}] simulation ✅ OK — ${sim.value.unitsConsumed} CU`);
  if (!SEND) {
    console.log(`[${label}] dry run only. Re-run with --send to execute on mainnet.`);
    return { fits, size, simOk: true };
  }
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  console.log(`[${label}] sent: ${sig}`);
  // Write-ahead: persist the pending record BEFORE confirming, so a lost
  // confirmation (blockhash expiry, RPC drop) never orphans a live position
  // from the tooling. Caller decides what "pending" means for its leg.
  if (onSent) onSent(sig);
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`${label} FAILED on-chain: ${JSON.stringify(conf.value.err)} (sig ${sig})`);
  console.log(`[${label}] ✅ CONFIRMED  https://solscan.io/tx/${sig}`);
  return { fits, size, simOk: true, signature: sig };
}

function cuIxs(web3, limit) {
  return [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ];
}

async function cmdGen(web3) {
  if (existsSync(WALLET_PATH)) {
    const kp = await loadWallet(web3);
    console.log(`Probe wallet already exists: ${kp.publicKey.toBase58()}`);
    return;
  }
  mkdirSync(DIR, { recursive: true });
  const kp = web3.Keypair.generate();
  writeFileSync(WALLET_PATH, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`Probe wallet created: ${kp.publicKey.toBase58()}`);
  console.log(`Fund it with ~0.15 SOL (0.05 principal + 0.0215 one-time NFT rent + fees + buffer).`);
  console.log(`File: ${WALLET_PATH} (gitignored — throwaway; sweep funds back when done).`);
}

async function cmdOpen(web3, connection) {
  const wallet = await loadWallet(web3);
  const prior = loadState();
  // Never open on top of an existing (or possibly-existing) position: a second
  // open would mint a new NFT and OVERWRITE the first position's bookkeeping,
  // orphaning live debt from the tooling.
  if (prior.nftId && !prior.closed) {
    throw new Error(
      `State shows an unclosed probe position (nftId ${prior.nftId}, openSig ${prior.openSig || "?"}, confirm=${prior.openConfirm || "?"}). ` +
      `Run 'close --send' first (or verify the open tx never landed on Solscan, then delete ${STATE_PATH}).`,
    );
  }
  const lstKey = arg("lst", "jupSOL");
  const principalSol = Number(arg("sol", "0.05"));
  const leverage = Number(arg("leverage", "2"));
  const slippageBps = Number(arg("slippage-bps", "50"));
  if (!(leverage > 1 && leverage <= 4)) throw new Error("--leverage must be in (1, 4] for the probe");
  if (!(principalSol >= 0.01 && principalSol <= 0.2)) throw new Error("--sol must be 0.01–0.2 (this is a dust probe)");

  const vault = await resolveVault(lstKey);
  const P = BigInt(Math.round(principalSol * 1e9));
  const F = BigInt(Math.round(principalSol * (leverage - 1) * 1e9)); // flash = borrowed leg
  const S = P + F; // total WSOL to swap into LST
  if (F < vault.minBorrowRaw) throw new Error(`debt ${F} < vault minimum ${vault.minBorrowRaw}`);

  const bal = await connection.getBalance(wallet.publicKey);
  const needed = Number(P) + 25_000_000 + 5_000_000; // principal + NFT rent + fees/rent buffer
  console.log(`Probe wallet ${wallet.publicKey.toBase58()}: ${(bal / 1e9).toFixed(4)} SOL (needs ~${(needed / 1e9).toFixed(4)})`);
  // Funding is required even for a dry run: the SDK predicts the position NFT
  // id via an on-chain simulation against THIS wallet, and the simulation
  // replays the real principal transfer. (Verified: an unfunded signer fails
  // getOperateIx with "No return data found in logs".)
  if (bal < needed) throw new Error(`Underfunded (even a dry run needs the funds in place). Send ${((needed - bal) / 1e9).toFixed(4)} more SOL to ${wallet.publicKey.toBase58()}.`);

  console.log(`OPEN plan: ${principalSol} SOL principal @ ${leverage}x on ${vault.symbol} (vault ${vault.vaultId})`);
  console.log(`  wrap ${Number(P) / 1e9} + flash ${Number(F) / 1e9} -> swap ${Number(S) / 1e9} WSOL -> ${vault.symbol} -> deposit + borrow ${Number(F) / 1e9} -> payback`);

  const quote = await jupQuote(WSOL_MINT, vault.lstMint, S.toString(), slippageBps);
  const minOut = BigInt(quote.otherAmountThreshold);
  console.log(`  swap quote: ${quote.outAmount} ${vault.symbol} raw (min ${minOut}), impact ${Number(quote.priceImpactPct).toFixed(6)}%`);
  const swapResp = await jupSwapIxs(quote, wallet.publicKey.toBase58());

  const flash = await import("@jup-ag/lend/flashloan");
  const borrowMod = await import("@jup-ag/lend/borrow");
  const BN = (await import("bn.js")).default;
  const wsolMintPk = new web3.PublicKey(WSOL_MINT);
  const { borrowIx, paybackIx } = await flash.getFlashloanIx({
    amount: new BN(F.toString()),
    asset: wsolMintPk,
    signer: wallet.publicKey,
    connection,
  });

  // Reuse a previously-minted (now empty) position NFT if we have one.
  const reuseNftId = prior.lst === vault.symbol && prior.vaultId === vault.vaultId && prior.closed && prior.nftId ? prior.nftId : 0;
  const operate = await borrowMod.getOperateIx({
    vaultId: vault.vaultId,
    positionId: reuseNftId,
    colAmount: new BN(minOut.toString()),        // deposit (positive)
    debtAmount: new BN(F.toString()),            // borrow  (positive)
    connection,
    signer: wallet.publicKey,
  });
  const nftId = reuseNftId || Number(operate.nftId);
  console.log(`  position NFT: ${reuseNftId ? `REUSING ${reuseNftId} (no rent)` : `minting new (nftId ${nftId}, ~0.0215 SOL rent)`}`);

  const wsolAta = ataFor(web3, wallet.publicKey, wsolMintPk);
  const instructions = [
    ...cuIxs(web3, 1_400_000),
    ixCreateAtaIdempotent(web3, wallet.publicKey, wallet.publicKey, wsolMintPk),
    web3.SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wsolAta, lamports: Number(P) }),
    ixSyncNative(web3, wsolAta),
    ...(swapResp.setupInstructions || []).map((ix) => deserializeJupIx(web3, ix)),
    borrowIx,
    deserializeJupIx(web3, swapResp.swapInstruction),
    ...operate.ixs,
    paybackIx,
  ];

  const altAddrs = [...(swapResp.addressLookupTableAddresses || [])];
  const alts = [...(await loadAlts(web3, connection, altAddrs)), ...(operate.addressLookupTableAccounts || [])];

  const res = await buildAndRun(web3, connection, wallet, instructions, alts, "OPEN", (sig) => {
    // Write-ahead (before confirm): if confirmation is lost, the position
    // record still exists so status/close can find it.
    saveState({
      lst: vault.symbol, vaultId: vault.vaultId, lstMint: vault.lstMint, nftId,
      depositedLstRaw: minOut.toString(), debtRaw: F.toString(), principalRaw: P.toString(),
      leverage, openSig: sig, openConfirm: "pending", closed: false,
    });
  });
  if (res.signature) {
    saveState({ openConfirm: "confirmed" });
    console.log(`State saved -> ${STATE_PATH}. Unwind with: node scripts/probe-sol-loop.mjs close --send`);
  }
}

async function cmdClose(web3, connection) {
  const wallet = await loadWallet(web3);
  const st = loadState();
  if (!st.nftId || st.closed) throw new Error("No open probe position in state file.");
  if (st.closeSigPending) {
    console.log(`⚠️  A previous close was sent but never confirmed (sig ${st.closeSigPending}).`);
    console.log(`   Check it on Solscan first — if it landed, the position is already closed and this re-run will fail harmlessly (atomic).`);
  }
  const slippageBps = Number(arg("slippage-bps", "50"));
  const vault = await resolveVault(st.lst);
  if (vault.vaultId !== st.vaultId) throw new Error("state/vault mismatch — refusing");

  // Flash slightly more than the recorded debt to cover accrued interest
  // (5.5%/yr over probe-scale hours is dust; 2% buffer is fat). operate(repay
  // MAX) takes only what is actually owed; the surplus stays in the WSOL ATA
  // and goes back out in the payback.
  const debt = BigInt(st.debtRaw);
  const F2 = (debt * 102n) / 100n;

  console.log(`CLOSE plan: repay MAX + withdraw MAX on ${st.lst} nft ${st.nftId}; flash ${Number(F2) / 1e9} WSOL buffer`);
  const quote = await jupQuote(st.lstMint, WSOL_MINT, st.depositedLstRaw, slippageBps);
  const minOut = BigInt(quote.otherAmountThreshold);
  if (minOut <= debt) throw new Error(`swap minOut ${minOut} <= debt ${debt} — would not cover payback, aborting`);
  console.log(`  swap quote: ${st.depositedLstRaw} ${st.lst} raw -> ${quote.outAmount} WSOL raw (min ${minOut})`);
  const swapResp = await jupSwapIxs(quote, wallet.publicKey.toBase58());

  const flash = await import("@jup-ag/lend/flashloan");
  const borrowMod = await import("@jup-ag/lend/borrow");
  const wsolMintPk = new web3.PublicKey(WSOL_MINT);
  const { borrowIx, paybackIx } = await flash.getFlashloanIx({
    amount: new (await import("bn.js")).default(F2.toString()),
    asset: wsolMintPk,
    signer: wallet.publicKey,
    connection,
  });
  const operate = await borrowMod.getOperateIx({
    vaultId: st.vaultId,
    positionId: st.nftId,
    colAmount: borrowMod.MAX_WITHDRAW_AMOUNT, // withdraw everything
    debtAmount: borrowMod.MAX_REPAY_AMOUNT,   // repay everything
    connection,
    signer: wallet.publicKey,
  });

  const wsolAta = ataFor(web3, wallet.publicKey, wsolMintPk);
  const instructions = [
    ...cuIxs(web3, 1_400_000),
    ixCreateAtaIdempotent(web3, wallet.publicKey, wallet.publicKey, wsolMintPk),
    ...(swapResp.setupInstructions || []).map((ix) => deserializeJupIx(web3, ix)),
    borrowIx,
    ...operate.ixs,
    deserializeJupIx(web3, swapResp.swapInstruction),
    paybackIx,
    ixCloseAccount(web3, wsolAta, wallet.publicKey, wallet.publicKey), // unwrap leftovers
  ];
  const alts = [
    ...(await loadAlts(web3, connection, swapResp.addressLookupTableAddresses || [])),
    ...(operate.addressLookupTableAccounts || []),
  ];

  const res = await buildAndRun(web3, connection, wallet, instructions, alts, "CLOSE", (sig) => {
    // Write-ahead: record the attempt WITHOUT marking closed — a failed close
    // must not let the next open reuse an NFT that still carries a position.
    saveState({ closeSigPending: sig });
  });
  if (res.signature) {
    saveState({ closed: true, closeSig: res.signature, closeSigPending: null });
    const bal = await connection.getBalance(wallet.publicKey);
    console.log(`Probe wallet now holds ${(bal / 1e9).toFixed(4)} SOL. NFT ${st.nftId} stays reusable for the next probe.`);
  }
}

async function cmdStatus(web3, connection) {
  const wallet = await loadWallet(web3);
  const st = loadState();
  const bal = await connection.getBalance(wallet.publicKey);
  console.log(`Probe wallet ${wallet.publicKey.toBase58()}: ${(bal / 1e9).toFixed(4)} SOL`);
  console.log(`State: ${JSON.stringify(st, null, 2)}`);
  if (st.nftId && st.vaultId) {
    const borrowMod = await import("@jup-ag/lend/borrow");
    const pos = await borrowMod.getCurrentPosition({ vaultId: st.vaultId, positionId: st.nftId, connection });
    console.log(`Live position (LEDGER units — scale by exchange prices for true amounts):`);
    console.log(`  colRaw ${pos?.colRaw?.toString?.()}  debtRaw ${pos?.debtRaw?.toString?.()}  tick ${pos?.tick}  liq ${pos?.userLiquidationStatus}`);
  }
}

async function main() {
  const cmd = process.argv[2];
  const web3 = await import("@solana/web3.js");
  if (cmd === "gen") return cmdGen(web3);
  const connection = new web3.Connection(rpcUrl(), "confirmed");
  if (cmd === "open") return cmdOpen(web3, connection);
  if (cmd === "close") return cmdClose(web3, connection);
  if (cmd === "status") return cmdStatus(web3, connection);
  console.log("Usage: node scripts/probe-sol-loop.mjs gen|open|close|status [--send] [--lst jupSOL] [--sol 0.05] [--leverage 2]");
}

main().catch((e) => {
  console.error("PROBE ERROR:", e?.message || e);
  process.exit(1);
});
