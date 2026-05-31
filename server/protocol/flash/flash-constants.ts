/**
 * Flash Trade protocol constants.
 *
 * Partner attribution on Flash is done ENTIRELY via the on-chain partner wallet
 * `FLASH_BUILDER_WALLET` — NOT via any text/string code. (The string "QuantumVault"
 * is a Pacifica builder-code concept and does NOT apply to Flash.) Flash trade
 * instructions take `privilege: Privilege.Referral` plus two PublicKeys
 * (tokenStakeAccount, userReferralAccount) — there is no string field anywhere in
 * the on-chain path. The 10% fee rebate (1000 bps) accrues to the partner wallet.
 *
 * Program IDs are read from the flash-sdk PoolConfig JSON (PoolConfig.fromIdsByName)
 * and reproduced here for documentation and Phase 2 direct-client construction.
 */

// ── On-chain program IDs (mainnet-beta, Crypto.1 pool) ──────────────────────
export const FLASH_PROGRAM_ID = 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn';
export const FLASH_COMPOSABILITY_PROGRAM_ID = 'FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm';
export const FLASH_FB_NFT_REWARD_PROGRAM_ID = 'FBRWDXSLysNbFQk64MQJcpkXP8e4fjezsGabV8jV7d7o';
export const FLASH_REWARD_DISTRIBUTION_PROGRAM_ID = 'FARNT7LL119pmy9vSkN9q1ApZESPaKHuuX5Acz1oBoME';

// ── Pool / collateral ────────────────────────────────────────────────────────
export const FLASH_PRIMARY_POOL = 'Crypto.1';

/** Native USDC on Solana mainnet. Used as collateral for short positions. */
export const FLASH_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Conservative minimum transfer amount for deposits/withdrawals.
 * Flash does not document an explicit minimum; $10 matches the Pacifica/Drift
 * floor and prevents micro-dust transactions.  Revisit when exact protocol
 * minimum is confirmed.
 *
 * TODO(flash-phase2): confirm Flash's actual minimum collateral amount.
 */
export const FLASH_MIN_TRANSFER_USDC = 10;

// ── Partner / referral ───────────────────────────────────────────────────────
/**
 * Partner wallet address for the Flash Trade referral program. This is the ONLY
 * attribution identifier Flash uses — there is no string code (unlike Pacifica,
 * which uses the text builder code "QuantumVault"). On-chain, the partner wallet
 * owns a `tokenStakeAccount`; rebates accrue to it when trades pass
 * `privilege: Privilege.Referral`. 10% fee rebate (FLASH_BUILDER_REBATE_BPS) on
 * routed trades.
 *
 * TODO(flash-phase2): derive the partner tokenStakeAccount PDA from this wallet
 * and thread it (plus each trader's userReferralAccount PDA) into trade
 * instructions via getReferralAccounts(). See flash-sdk PerpetualsClient.
 */
export const FLASH_BUILDER_WALLET = 'AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez';
/** 10% fee rebate expressed in basis points. Accrues to FLASH_BUILDER_WALLET. */
export const FLASH_BUILDER_REBATE_BPS = 1000;

// ── Market specification ─────────────────────────────────────────────────────
/**
 * Per-asset spec for every tradeable Flash mainnet perp market.
 *
 * This array is the EXHAUSTIVE STATIC FALLBACK: it enumerates every distinct
 * tradeable asset across all 9 non-deprecated mainnet-beta pools in the
 * flash-sdk PoolConfig (Crypto.1, Virtual.1, Governance.1, Community.1/2,
 * Trump.1, Ore.1, Equity.1 — Remora.1 has no markets). The live path
 * (`loadFlashMarketsFromPoolConfig` in flash-markets.ts) reads the same
 * PoolConfig at runtime and supersedes this list; this constant is only used
 * when that runtime read fails or returns empty, so the bot-creation flow and
 * QuantumLab always have a complete market list to validate against.
 *
 * Field derivation (both here and in the runtime loader — keep in sync via
 * scripts/gen-flash-specs is NOT wired; regenerate with the inline generator):
 *   tickSize  = 10^(-usdPrecision)    from the PoolConfig custody
 *   lotSize   = 10^(-tokenPrecision)  from the PoolConfig custody
 *   maxLeverage, pythTicker, pythPriceId, isVirtual = directly from PoolConfig
 *   category  = derived from pythTicker prefix (Crypto./FX./Metal./Commodities./Equity.)
 * Softer fields (minOrderSizeUsd, maintenanceMarginWeight, estimatedSlippagePct,
 * riskTier) are CONSERVATIVE DEFAULTS pending Phase 2 calibration against Flash docs.
 *
 * `isVirtual` flags synthetic-pricing custodies (forex, metals, equities, and a
 * few crypto like BNB). Virtual does NOT mean untradeable — Flash trades these
 * via synthetic custodies; the flag is surfaced for risk display only.
 */
export interface FlashMarketSpec {
  internalSymbol: string;
  flashSymbol: string;
  pool: string;
  maxLeverage: number;
  tickSize: number;
  lotSize: number;
  minOrderSizeBase: number;
  minOrderSizeUsd: number;
  maintenanceMarginWeight: number;
  estimatedSlippagePct: number;
  riskTier: 'recommended' | 'caution' | 'high_risk';
  fullName: string;
  category: string[];
  isVirtual: boolean;
  /** Pyth feed symbol, e.g. "Crypto.SOL/USD", "FX.EUR/USD", "Equity.US.NVDA/USD". */
  pythTicker: string;
  /** Pyth Hermes hex price-feed id (no 0x prefix). */
  pythPriceId: string;
}

export const FLASH_MARKET_SPECS: FlashMarketSpec[] = [
  {
    internalSymbol: 'SOL-PERP',
    flashSymbol: 'SOL',
    pool: 'Crypto.1',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'recommended',
    fullName: "Solana",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.SOL/USD',
    pythPriceId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  },
  {
    internalSymbol: 'BTC-PERP',
    flashSymbol: 'BTC',
    pool: 'Crypto.1',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'recommended',
    fullName: "Bitcoin",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.BTC/USD',
    pythPriceId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  },
  {
    internalSymbol: 'ETH-PERP',
    flashSymbol: 'ETH',
    pool: 'Crypto.1',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'recommended',
    fullName: "Ethereum",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.ETH/USD',
    pythPriceId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  },
  {
    internalSymbol: 'ZEC-PERP',
    flashSymbol: 'ZEC',
    pool: 'Crypto.1',
    maxLeverage: 10,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Zcash",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.ZEC/USD',
    pythPriceId: 'be9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24',
  },
  {
    internalSymbol: 'BNB-PERP',
    flashSymbol: 'BNB',
    pool: 'Crypto.1',
    maxLeverage: 50,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "BNB",
    category: ['crypto'],
    isVirtual: true,
    pythTicker: 'Crypto.BNB/USD',
    pythPriceId: '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
  },
  {
    internalSymbol: 'XAU-PERP',
    flashSymbol: 'XAU',
    pool: 'Virtual.1',
    maxLeverage: 100,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'caution',
    fullName: "Gold",
    category: ['commodity', 'metal'],
    isVirtual: true,
    pythTicker: 'Metal.XAU/USD',
    pythPriceId: '765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
  },
  {
    internalSymbol: 'XAG-PERP',
    flashSymbol: 'XAG',
    pool: 'Virtual.1',
    maxLeverage: 100,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'caution',
    fullName: "Silver",
    category: ['commodity', 'metal'],
    isVirtual: true,
    pythTicker: 'Metal.XAG/USD',
    pythPriceId: 'f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e',
  },
  {
    internalSymbol: 'EUR-PERP',
    flashSymbol: 'EUR',
    pool: 'Virtual.1',
    maxLeverage: 500,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.02,
    riskTier: 'caution',
    fullName: "Euro",
    category: ['forex'],
    isVirtual: true,
    pythTicker: 'FX.EUR/USD',
    pythPriceId: 'a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b',
  },
  {
    internalSymbol: 'GBP-PERP',
    flashSymbol: 'GBP',
    pool: 'Virtual.1',
    maxLeverage: 500,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.02,
    riskTier: 'caution',
    fullName: "British Pound",
    category: ['forex'],
    isVirtual: true,
    pythTicker: 'FX.GBP/USD',
    pythPriceId: '84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1',
  },
  {
    internalSymbol: 'CRUDEOIL-PERP',
    flashSymbol: 'CRUDEOIL',
    pool: 'Virtual.1',
    maxLeverage: 5,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'caution',
    fullName: "Crude Oil (WTI)",
    category: ['commodity'],
    isVirtual: true,
    pythTicker: 'Commodities.WTIN6/USD',
    pythPriceId: 'ce4c15100156d27c8bdd044d9804294e7bc0944dbb5b2b82a61a7aa85b6b3a5e',
  },
  {
    internalSymbol: 'USDJPY-PERP',
    flashSymbol: 'USDJPY',
    pool: 'Virtual.1',
    maxLeverage: 500,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.02,
    riskTier: 'caution',
    fullName: "US Dollar / Japanese Yen",
    category: ['forex'],
    isVirtual: true,
    pythTicker: 'FX.USD/JPY',
    pythPriceId: 'ef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52',
  },
  {
    internalSymbol: 'USDCNH-PERP',
    flashSymbol: 'USDCNH',
    pool: 'Virtual.1',
    maxLeverage: 500,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.02,
    riskTier: 'caution',
    fullName: "US Dollar / Chinese Yuan",
    category: ['forex'],
    isVirtual: true,
    pythTicker: 'FX.USD/CNH',
    pythPriceId: 'eef52e09c878ad41f6a81803e3640fe04dceea727de894edd4ea117e2e332e66',
  },
  {
    internalSymbol: 'NATGAS-PERP',
    flashSymbol: 'NATGAS',
    pool: 'Virtual.1',
    maxLeverage: 10,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'caution',
    fullName: "Natural Gas",
    category: ['commodity'],
    isVirtual: true,
    pythTicker: 'Commodities.NGDN6/USD',
    pythPriceId: '1c597df8d6db7b35d20eb6ca5430e462425eddfe84ebc63530118d7389a43318',
  },
  {
    internalSymbol: 'JUP-PERP',
    flashSymbol: 'JUP',
    pool: 'Governance.1',
    maxLeverage: 50,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Jupiter",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.JUP/USD',
    pythPriceId: '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
  },
  {
    internalSymbol: 'PYTH-PERP',
    flashSymbol: 'PYTH',
    pool: 'Governance.1',
    maxLeverage: 50,
    tickSize: 0.0001,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Pyth Network",
    category: ['crypto'],
    isVirtual: true,
    pythTicker: 'Crypto.PYTH/USD',
    pythPriceId: '0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
  },
  {
    internalSymbol: 'JTO-PERP',
    flashSymbol: 'JTO',
    pool: 'Governance.1',
    maxLeverage: 10,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Jito",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.JTO/USD',
    pythPriceId: 'b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2',
  },
  {
    internalSymbol: 'KMNO-PERP',
    flashSymbol: 'KMNO',
    pool: 'Governance.1',
    maxLeverage: 50,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Kamino",
    category: ['crypto'],
    isVirtual: true,
    pythTicker: 'Crypto.KMNO/USD',
    pythPriceId: 'b17e5bc5de742a8a378b54c9c75442b7d51e30ada63f28d9bd28d3c0e26511a0',
  },
  {
    internalSymbol: 'HYPE-PERP',
    flashSymbol: 'HYPE',
    pool: 'Governance.1',
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Hyperliquid",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.HYPE/USD',
    pythPriceId: '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b',
  },
  {
    internalSymbol: 'MEGA-PERP',
    flashSymbol: 'MEGA',
    pool: 'Governance.1',
    maxLeverage: 5,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'high_risk',
    fullName: "MegaETH",
    category: ['crypto'],
    isVirtual: true,
    pythTicker: 'Crypto.MEGA/USD',
    pythPriceId: '',
  },
  {
    internalSymbol: 'BONK-PERP',
    flashSymbol: 'BONK',
    pool: 'Community.1',
    maxLeverage: 25,
    tickSize: 1e-8,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'high_risk',
    fullName: "Bonk",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.BONK/USD',
    pythPriceId: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  },
  {
    internalSymbol: 'PENGU-PERP',
    flashSymbol: 'PENGU',
    pool: 'Community.1',
    maxLeverage: 25,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'high_risk',
    fullName: "Pudgy Penguins",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.PENGU/USD',
    pythPriceId: 'bed3097008b9b5e3c93bec20be79cb43986b85a996475589351a21e67bae9b61',
  },
  {
    internalSymbol: 'PUMP-PERP',
    flashSymbol: 'PUMP',
    pool: 'Community.1',
    maxLeverage: 25,
    tickSize: 0.000001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'high_risk',
    fullName: "Pump.fun",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.PUMP/USD',
    pythPriceId: '7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9',
  },
  {
    internalSymbol: 'WIF-PERP',
    flashSymbol: 'WIF',
    pool: 'Community.2',
    maxLeverage: 25,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'high_risk',
    fullName: "dogwifhat",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.WIF/USD',
    pythPriceId: '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
  },
  {
    internalSymbol: 'FARTCOIN-PERP',
    flashSymbol: 'FARTCOIN',
    pool: 'Trump.1',
    maxLeverage: 25,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'high_risk',
    fullName: "Fartcoin",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.FARTCOIN/USD',
    pythPriceId: '58cd29ef0e714c5affc44f269b2c1899a52da4169d7acc147b9da692e6953608',
  },
  {
    internalSymbol: 'ORE-PERP',
    flashSymbol: 'ORE',
    pool: 'Ore.1',
    maxLeverage: 5,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'high_risk',
    fullName: "ORE",
    category: ['crypto'],
    isVirtual: false,
    pythTicker: 'Crypto.ORE/USD',
    pythPriceId: '142b804c658e14ff60886783e46e5a51bdf398b4871d9d8f7c28aa1585cad504',
  },
  {
    internalSymbol: 'SPY-PERP',
    flashSymbol: 'SPY',
    pool: 'Equity.1',
    maxLeverage: 20,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "S&P 500 ETF",
    category: ['equity', 'stocks'],
    isVirtual: false,
    pythTicker: 'Equity.US.SPY/USD',
    pythPriceId: '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
  },
  {
    internalSymbol: 'NVDA-PERP',
    flashSymbol: 'NVDA',
    pool: 'Equity.1',
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "NVIDIA",
    category: ['equity', 'stocks'],
    isVirtual: true,
    pythTicker: 'Equity.US.NVDA/USD',
    pythPriceId: 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
  },
  {
    internalSymbol: 'TSLA-PERP',
    flashSymbol: 'TSLA',
    pool: 'Equity.1',
    maxLeverage: 20,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Tesla",
    category: ['equity', 'stocks'],
    isVirtual: true,
    pythTicker: 'Equity.US.TSLA/USD',
    pythPriceId: '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
  },
  {
    internalSymbol: 'AAPL-PERP',
    flashSymbol: 'AAPL',
    pool: 'Equity.1',
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Apple",
    category: ['equity', 'stocks'],
    isVirtual: true,
    pythTicker: 'Equity.US.AAPL/USD',
    pythPriceId: '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
  },
  {
    internalSymbol: 'AMD-PERP',
    flashSymbol: 'AMD',
    pool: 'Equity.1',
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "AMD",
    category: ['equity', 'stocks'],
    isVirtual: true,
    pythTicker: 'Equity.US.AMD/USD',
    pythPriceId: '3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e',
  },
  {
    internalSymbol: 'AMZN-PERP',
    flashSymbol: 'AMZN',
    pool: 'Equity.1',
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: "Amazon",
    category: ['equity', 'stocks'],
    isVirtual: true,
    pythTicker: 'Equity.US.AMZN/USD',
    pythPriceId: 'b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a',
  },
];

// ── Pyth Hermes price IDs (hex, strip leading 0x for the API) ───────────────
// Derived from FLASH_MARKET_SPECS so the price path (getPrice/getAllPrices)
// stays in lockstep with the market list — every tradeable market has a feed id.
export const FLASH_PYTH_PRICE_IDS: Record<string, string> = Object.fromEntries(
  FLASH_MARKET_SPECS
    .filter((s) => s.pythPriceId.length > 0)
    .map((s) => [s.internalSymbol, s.pythPriceId]),
);
