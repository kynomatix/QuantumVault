/**
 * Phase 4b break-glass recovery for a Flash agent-derived per-bot wallet.
 *
 * This is the LAST-RESORT, DB-independent path: given only the agent recovery
 * phrase and a bot's non-secret derivation index, it re-derives the per-bot wallet
 * (m/44'/501'/<botIndex>'/0'), closes any open positions, tops up gas from the
 * agent, sweeps ALL funds back to the agent wallet, and verifies the wallet is
 * empty. It does NOT read the encrypted key blob and does NOT need a logged-in
 * session — so it works even after total loss of the encrypted per-bot key (or the
 * whole DB, with a bounded index scan).
 *
 * Fund safety: fails closed on any unreadable balance or unfinished close/sweep.
 *
 * Usage (mnemonic via env ONLY — never pass it as a CLI arg / shell history):
 *   AGENT_MNEMONIC="word1 word2 ... word12" \
 *     npx tsx scripts/recover-flash-bot-wallet.ts --index <botIndex> [--version 1] [--dry-run]
 *
 * --index      REQUIRED. The bot's derivation_index (>= 1). The agent wallet itself
 *              is account 0' and is never a valid bot index.
 * --version    Derivation path version (default 1). Must match how the bot was created.
 * --dry-run    Re-derive + print the bot wallet address and its balances; do not move funds.
 */
import 'dotenv/config';
import {
  deriveKeypairFromMnemonic,
  deriveBotKeypairFromAgentSeed,
  BOT_DERIVATION_PATH_VERSION,
} from '../server/session-v3.js';
import { flashAdapter } from '../server/protocol/flash/flash-adapter.js';

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--index') out.index = argv[++i];
    else if (a === '--version') out.version = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const mnemonic = process.env.AGENT_MNEMONIC?.trim();
  if (!mnemonic) {
    console.error('ERROR: set the AGENT_MNEMONIC env var (never pass the phrase as a CLI arg).');
    process.exit(1);
  }
  const botIndex = Number(args.index);
  if (!Number.isInteger(botIndex) || botIndex < 1) {
    console.error('ERROR: --index must be an integer >= 1 (account 0\' is the agent wallet).');
    process.exit(1);
  }
  const version = args.version != null ? Number(args.version) : BOT_DERIVATION_PATH_VERSION;
  const dryRun = !!args.dryRun;

  const seed = Buffer.from(mnemonic, 'utf8');
  const agent = deriveKeypairFromMnemonic(seed);
  const botKp = deriveBotKeypairFromAgentSeed(seed, botIndex, version);
  const agentAddress = agent.publicKey.toBase58();
  const botWalletAddress = botKp.publicKey.toBase58();

  // Path-collision guard — a bot wallet can NEVER be the agent wallet.
  if (botWalletAddress === agentAddress) {
    console.error('FATAL: derived bot wallet equals the agent wallet — refusing (path collision).');
    process.exit(1);
  }

  console.log(`Agent wallet:      ${agentAddress}`);
  console.log(`Bot wallet (idx ${botIndex}, v${version}): ${botWalletAddress}`);

  await flashAdapter.initialize();

  // Report current state (fail closed on unreadable balances).
  let usdc: number;
  let sol: number;
  try {
    usdc = await flashAdapter.getWalletCollateralBalanceStrict(botWalletAddress);
    sol = await flashAdapter.getWalletSolBalance(botWalletAddress);
  } catch (err) {
    console.error(`FATAL: could not read bot wallet balances (failing closed): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const positions = await flashAdapter.getPositions(botWalletAddress);
  console.log(`Current: $${usdc.toFixed(6)} USDC, ${sol.toFixed(6)} SOL, ${positions.length} open position(s).`);

  if (dryRun) {
    console.log('--dry-run: no funds moved.');
    process.exit(0);
  }

  // 1) Close any open positions — fail closed if a close does not succeed.
  let closed = 0;
  for (const pos of positions) {
    console.log(`Closing ${pos.internalSymbol} position...`);
    const close = await flashAdapter.closePosition({
      agentPublicKey: botWalletAddress,
      agentSecretKey: botKp.secretKey,
      mainWalletAddress: agentAddress,
      internalSymbol: pos.internalSymbol,
      subaccountId: botWalletAddress,
    });
    if (!close.success) {
      console.error(`FATAL: failed to close ${pos.internalSymbol}: ${close.error}`);
      process.exit(1);
    }
    closed++;
  }

  // Best-effort cancel of leftover trigger orders.
  try {
    await flashAdapter.cancelAllOrders({
      agentPublicKey: botWalletAddress,
      agentSecretKey: botKp.secretKey,
      mainWalletAddress: agentAddress,
      subaccountId: botWalletAddress,
    });
  } catch (err) {
    console.warn(`cancelAllOrders failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Re-verify no positions remain.
  const stillOpen = await flashAdapter.getPositions(botWalletAddress);
  if (stillOpen.length > 0) {
    console.error(`FATAL: ${stillOpen.length} position(s) still open after close attempt — refusing to sweep.`);
    process.exit(1);
  }

  // 2) Gas top-up so the bot wallet can pay its own sweep fee.
  const gas = await flashAdapter.topUpBotWalletGas({
    mainSecretKey: agent.secretKey,
    botWalletAddress,
  });
  if (gas.error) {
    console.error(`FATAL: could not top up bot gas for sweep: ${gas.error}`);
    process.exit(1);
  }

  // 3) Sweep everything back to the agent wallet.
  const sweep = await flashAdapter.sweepBotWallet({
    subSecretKey: botKp.secretKey,
    destWalletAddress: agentAddress,
  });
  if (sweep.error) {
    console.error(`FATAL: sweep failed: ${sweep.error}`);
    process.exit(1);
  }

  // 4) Verify empty — positions + USDC + SOL all fail closed (mirrors the server).
  const residualPositions = await flashAdapter.getPositions(botWalletAddress);
  if (residualPositions.length > 0) {
    console.error(`FATAL: ${residualPositions.length} position(s) reopened during recovery — collateral locked. Stop the bot and retry.`);
    process.exit(1);
  }
  let usdcResidual: number;
  let solResidual: number;
  try {
    usdcResidual = await flashAdapter.getWalletCollateralBalanceStrict(botWalletAddress);
    solResidual = await flashAdapter.getWalletSolBalance(botWalletAddress);
  } catch (err) {
    console.error(`FATAL: could not verify wallet empty after sweep (failing closed): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (usdcResidual > 0) {
    console.error(`FATAL: $${usdcResidual.toFixed(6)} USDC still remains after sweep.`);
    process.exit(1);
  }
  const FLASH_SOL_DUST = 0.001;
  if (solResidual > FLASH_SOL_DUST) {
    console.error(`FATAL: ${solResidual.toFixed(6)} SOL still remains after sweep (SOL reclaim failed) — retry.`);
    process.exit(1);
  }

  console.log(`DONE: closed ${closed} position(s), swept $${sweep.usdcSwept.toFixed(2)} USDC + ${sweep.solReclaimed.toFixed(6)} SOL to the agent wallet.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
