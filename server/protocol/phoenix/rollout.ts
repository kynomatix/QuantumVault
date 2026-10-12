/** Owner-controlled server configuration. No route, connector or client may write it.
 * A flag never installs execution IO, custody, eligibility or production proofs. */
export const PHOENIX_RISK_FLAGS = {
  create: 'PHOENIX_PROVISIONING_ENABLED', fund: 'PHOENIX_FUNDING_ENABLED',
  entry: 'PHOENIX_ENTRY_ENABLED', borrow: 'PHOENIX_BORROW_ENABLED',
  topup: 'PHOENIX_BORROW_ENABLED', defense: 'PHOENIX_AUTO_DEFENSE_ENABLED',
  park: 'PHOENIX_PARKING_ENABLED', carry: 'PHOENIX_CARRY_ENABLED', ai: 'PHOENIX_AI_LIVE_ENABLED',
} as const;
export type PhoenixRiskAction = keyof typeof PHOENIX_RISK_FLAGS;
export type PhoenixRecoveryAction = 'reconcile' | 'close' | 'cancel' | 'withdraw' | 'unwrap' | 'wallet_return' | 'repay' | 'unwind' | 'unpark';
export const PHOENIX_RECOVERY_ACTIONS: readonly PhoenixRecoveryAction[] =
  ['reconcile', 'close', 'cancel', 'withdraw', 'unwrap', 'wallet_return', 'repay', 'unwind', 'unpark'];
let shutdownLatched = false;
/** Process-local irreversible latch; restart under an owner-approved configuration to re-arm. */
export function stopPhoenixNewRisk(): void { shutdownLatched = true; }
const stages = ['trading', 'parking', 'manual_debt', 'defense', 'carry'] as const;
export interface PhoenixCanaryPolicy {
  version: 1; authorizationId: string; ownerWallet: string; botIds: string[]; maxBots: number;
  expiresAt: number; stage: typeof stages[number]; acceptedUnits: string[];
  reviewedDeployment: true; recoveryDrillPassed: true;
  caps: { maxRegistrationLamports: string; maxTransferUsdcMicros: string; maxExposureUsdcMicros: string;
    maxDebtUsdcMicros: string; maxParkUsdcMicros: string; maxCollateralRaw: string; collateralMint: string; maxLeverage: string };
}
export interface PhoenixRiskRequest {
  ownerWallet: string; botId: string; registrationLamports?: string; transferUsdcMicros?: string;
  notionalMicros?: string; leverage?: string; debtUsdcMicros?: string; parkUsdcMicros?: string;
  collateralRaw?: string; collateralMint?: string;
}
const integer = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && !/[\r\n]/.test(v);
const positive = (v: unknown): v is string => integer(v) && BigInt(v) > 0n;
const label = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) && !/[\r\n]/.test(v);
let cachedPolicyText: string | undefined;
let cachedPolicy: PhoenixCanaryPolicy | null = null;
export function readPhoenixCanaryPolicy(env: NodeJS.ProcessEnv = process.env, now = Date.now()): PhoenixCanaryPolicy | null {
  const text = env.PHOENIX_CANARY_POLICY;
  if (text === cachedPolicyText) return cachedPolicy && cachedPolicy.expiresAt > now
    && cachedPolicy.expiresAt <= now + 86_400_000 ? cachedPolicy : null;
  cachedPolicyText = text; cachedPolicy = null;
  try {
    if (!env.PHOENIX_CANARY_POLICY || env.PHOENIX_CANARY_POLICY.length > 8192) return null;
    const p = JSON.parse(env.PHOENIX_CANARY_POLICY) as PhoenixCanaryPolicy;
    if (p.version !== 1 || !label(p.authorizationId) || !label(p.ownerWallet)
      || !Number.isSafeInteger(p.expiresAt)
      || !stages.includes(p.stage) || p.reviewedDeployment !== true || p.recoveryDrillPassed !== true
      || !Number.isInteger(p.maxBots) || p.maxBots < 1 || p.maxBots > 5
      || !Array.isArray(p.botIds) || !p.botIds.length || p.botIds.length > p.maxBots
      || p.botIds.some(id => !label(id)) || new Set(p.botIds).size !== p.botIds.length
      || !Array.isArray(p.acceptedUnits) || Array.from({length: 16}, (_,i) => `U${String(i+1).padStart(2,'0')}`).some(u => !p.acceptedUnits.includes(u))) return null;
    const c = p.caps;
    if (!c || !label(c.collateralMint) || !positive(c.maxLeverage) || BigInt(c.maxLeverage) > 20n
      || ![c.maxRegistrationLamports,c.maxTransferUsdcMicros,c.maxExposureUsdcMicros,c.maxDebtUsdcMicros,c.maxParkUsdcMicros,c.maxCollateralRaw].every(positive)) return null;
    Object.freeze(p.botIds); Object.freeze(p.acceptedUnits); Object.freeze(p.caps);
    cachedPolicy = Object.freeze(p);
    return p.expiresAt > now && p.expiresAt <= now + 86_400_000 ? p : null;
  } catch { return null; }
}
export function phoenixFeatureEnabled(action: PhoenixRiskAction, env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const p = readPhoenixCanaryPolicy(env, now);
  if (shutdownLatched || !p || env.PHOENIX_NEW_RISK_ENABLED !== 'true' || env.PHOENIX_OWNER_LAUNCH_AUTHORIZED !== 'true'
    || env[PHOENIX_RISK_FLAGS[action]] !== 'true') return false;
  const minimum = {create:0,fund:0,entry:0,ai:0,park:1,borrow:2,topup:2,defense:3,carry:4}[action];
  if (stages.indexOf(p.stage) < minimum) return false;
  // Higher-risk stages require the preceding feature bindings to stay explicitly enabled.
  if (minimum >= 2 && env.PHOENIX_PARKING_ENABLED !== 'true') return false;
  if (minimum >= 3 && env.PHOENIX_BORROW_ENABLED !== 'true') return false;
  if (minimum >= 4 && env.PHOENIX_AUTO_DEFENSE_ENABLED !== 'true') return false;
  return true;
}
export function phoenixCanaryAllows(action: PhoenixRiskAction | PhoenixRecoveryAction, r: PhoenixRiskRequest,
  env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  // This authorizes no custody or spend by itself. Existing ownership, consent,
  // limits, freshness and durable execution checks remain mandatory for recovery.
  if ((PHOENIX_RECOVERY_ACTIONS as readonly string[]).includes(action)) return true;
  if (!phoenixFeatureEnabled(action as PhoenixRiskAction,env,now)) return false;
  const p = readPhoenixCanaryPolicy(env,now)!;
  if (r.ownerWallet !== p.ownerWallet || !p.botIds.includes(r.botId)) return false;
  const bounded = (v: unknown, max: string) => integer(v) && BigInt(v) <= BigInt(max);
  switch (action) {
    case 'create': return bounded(r.registrationLamports,p.caps.maxRegistrationLamports);
    case 'fund': return bounded(r.transferUsdcMicros,p.caps.maxTransferUsdcMicros);
    case 'entry': return bounded(r.notionalMicros,p.caps.maxExposureUsdcMicros) && positive(r.leverage) && bounded(r.leverage,p.caps.maxLeverage);
    case 'borrow': return bounded(r.debtUsdcMicros,p.caps.maxDebtUsdcMicros)
      && r.collateralMint === p.caps.collateralMint && bounded(r.collateralRaw,p.caps.maxCollateralRaw);
    case 'topup': case 'defense': return r.collateralMint === p.caps.collateralMint && bounded(r.collateralRaw,p.caps.maxCollateralRaw);
    case 'park': case 'carry': return bounded(r.parkUsdcMicros,p.caps.maxParkUsdcMicros);
    case 'ai': return true; // Entry, funding and registration primitives enforce their own monetary caps.
    default: return false;
  }
}
/** Current complete ALL-market bot exposure from the trusted execution reader.
 * Missing data is a hard denial; an intent cap alone is not an aggregate cap. */
export function phoenixExposureAllows(current: string | undefined, entryMax: string,
  env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const p = readPhoenixCanaryPolicy(env,now);
  return !!p && integer(current) && integer(entryMax)
    && BigInt(current) + BigInt(entryMax) <= BigInt(p.caps.maxExposureUsdcMicros);
}
