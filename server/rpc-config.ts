const DRIFT_ENV = (process.env.DRIFT_ENV || 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const IS_MAINNET = DRIFT_ENV === 'mainnet-beta';

export function getPrimaryRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) {
    return process.env.SOLANA_RPC_URL;
  }
  if (IS_MAINNET && process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return IS_MAINNET ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
}

export function getBackupRpcUrl(): string | null {
  if (process.env.TRITON_ONE_RPC) {
    let url = process.env.TRITON_ONE_RPC;
    // Ensure URL has protocol prefix
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }
    return url;
  }
  return null;
}

export function getAllRpcUrls(): string[] {
  const urls: string[] = [getPrimaryRpcUrl()];
  const backup = getBackupRpcUrl();
  if (backup) {
    urls.push(backup);
  }
  return urls;
}
