/** Runtime retirement never disposes of a user's wallet, balance or position. */
export const FLASH_RETIRED_MESSAGE = "Flash trading has closed. New bots, trading and automatic fund actions are disabled. You can still withdraw USDC from your existing bot wallet.";
export function assertProtocolRuntimeAvailable(protocol: string): void {
  if (protocol === 'flash') throw new Error(FLASH_RETIRED_MESSAGE);
}
