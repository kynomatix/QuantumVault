/** Proven executor routes, not venue liveness or a generic trading capability. */
export interface AutoDefenseCapabilities { topup: boolean; repay: boolean }
export function autoDefenseProtocols(phoenix: AutoDefenseCapabilities): ('flash' | 'phoenix')[] {
  // Retain the existing Flash defender. No other legacy venue gains a spend path.
  return phoenix.topup || phoenix.repay ? ['flash', 'phoenix'] : ['flash'];
}
export function autoDefenseOptedIn(bot: { autoCollateralTopUp: boolean; autoRepayEnabled: boolean }, caps: AutoDefenseCapabilities) {
  return (caps.topup && bot.autoCollateralTopUp) || (caps.repay && bot.autoRepayEnabled);
}
