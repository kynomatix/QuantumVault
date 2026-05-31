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

// ── Pyth Hermes price IDs (hex, strip leading 0x for the API) ───────────────
// Sourced from flash-sdk PoolConfig.json (Crypto.1 pool).
// These are the Pyth price feed IDs used by Flash's own oracle infrastructure.
export const FLASH_PYTH_PRICE_IDS: Record<string, string> = {
  'SOL-PERP':     'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'BTC-PERP':     'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH-PERP':     'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'JITOSOL-PERP': '67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb',
  'ZEC-PERP':     'be9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24',
};

// ── Market specification ─────────────────────────────────────────────────────
/**
 * Per-token tick sizes (USD price precision) and lot sizes (base token
 * precision) derived from the Crypto.1 PoolConfig.
 *
 * tickSize  = 10^(-usdPrecision)   from PoolConfig token entry
 * lotSize   = 10^(-tokenPrecision) from PoolConfig token entry
 *
 * maintenanceMarginWeight is set to 0.5% (50 bps) which matches Flash's
 * documented maintenance margin at max standard leverage.
 * TODO(flash-phase2): confirm exact maintenance margin from Flash docs.
 */
export interface FlashMarketSpec {
  internalSymbol: string;
  flashSymbol: string;
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
}

export const FLASH_MARKET_SPECS: FlashMarketSpec[] = [
  {
    internalSymbol: 'SOL-PERP',
    flashSymbol: 'SOL',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'recommended',
    fullName: 'Solana',
    category: ['L1', 'crypto'],
  },
  {
    internalSymbol: 'BTC-PERP',
    flashSymbol: 'BTC',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.000001,
    minOrderSizeBase: 0.000001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'recommended',
    fullName: 'Bitcoin',
    category: ['L1', 'crypto'],
  },
  {
    internalSymbol: 'ETH-PERP',
    flashSymbol: 'ETH',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.0001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.05,
    riskTier: 'recommended',
    fullName: 'Ethereum',
    category: ['L1', 'crypto'],
  },
  {
    internalSymbol: 'JITOSOL-PERP',
    flashSymbol: 'JitoSOL',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.1,
    riskTier: 'caution',
    fullName: 'Jito Staked SOL',
    category: ['LST', 'crypto'],
  },
  {
    internalSymbol: 'ZEC-PERP',
    flashSymbol: 'ZEC',
    maxLeverage: 100,
    tickSize: 0.01,
    lotSize: 0.0001,
    minOrderSizeBase: 0.001,
    minOrderSizeUsd: 0.1,
    maintenanceMarginWeight: 0.005,
    estimatedSlippagePct: 0.2,
    riskTier: 'caution',
    fullName: 'Zcash',
    category: ['privacy', 'crypto'],
  },
];

// BNB is present in the Crypto.1 pool but marked isVirtual=true.
// Virtual custodies are not directly tradeable; they use synthetic pricing.
// Phase 2 may add BNB support once we understand Flash's virtual custody mechanics.
// TODO(flash-phase2): evaluate virtual BNB market support.
