import type { FlashAdapter } from './flash-adapter';
// Wallet-only recovery and valuation; never initialize/register the retired venue.
export async function getManualFlashWithdrawalAdapter(): Promise<FlashAdapter> {
  const { FlashAdapter } = await import('./flash-adapter');
  return new FlashAdapter();
}
