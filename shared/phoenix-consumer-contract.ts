/** Phoenix provisioning owns funding even when registration/deposit is pending.
 * Client settings retries must never create a separate generic deposit. */
export function consumerFundingHandled(bot: {
  activeProtocol?: unknown; funded?: unknown; fundingWarning?: unknown; fundingManagedBy?: unknown;
}): boolean {
  return bot.activeProtocol === 'phoenix' || bot.fundingManagedBy === 'phoenix'
    || bot.funded === true || typeof bot.fundingWarning === 'string';
}
