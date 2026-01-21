const DRIFT_DATA_API_BASE = 'https://data.api.drift.trade';

interface DriftTradingSnapshot {
  ts: number;
  accountBalance: string;
  unrealizedPnl: string;
  cumulativeRealizedPnl: string;
  unsettledPnl: string;
  cumulativeSettledPnl: string;
  cumulativeFunding: string;
  cumulativeFeePaid: string;
  cumulativeFeeRebate: string;
  cumulativeTakerVolume: string;
  cumulativeMakerVolume: string;
}

interface DriftAccountMetrics {
  cumulativeRealizedPnl: string;
  cumulativeMakerVolume: string;
  cumulativeTakerVolume: string;
  cumulativeFeePaid: string;
  cumulativeFeeRebate: string;
}

interface DriftAccountData {
  accountId: string;
  snapshots: DriftTradingSnapshot[];
  metrics: DriftAccountMetrics;
}

interface DriftTradingResponse {
  success: boolean;
  accounts: DriftAccountData[];
}

export interface WalletVolumeData {
  walletAddress: string;
  cumulativeVolume: number;
  cumulativeFees: number;
  cumulativePnl: number;
  accountCount: number;
}

export interface PlatformVolumeFromDrift {
  totalVolume: number;
  totalFees: number;
  walletData: WalletVolumeData[];
}

export async function fetchWalletTradingStats(authorityAddress: string): Promise<WalletVolumeData | null> {
  try {
    const response = await fetch(`${DRIFT_DATA_API_BASE}/authority/${authorityAddress}/snapshots/trading`, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) {
      console.warn(`[DriftAPI] Failed to fetch stats for ${authorityAddress}: ${response.status}`);
      return null;
    }
    
    const data: DriftTradingResponse = await response.json();
    
    if (!data.success || !data.accounts || data.accounts.length === 0) {
      return {
        walletAddress: authorityAddress,
        cumulativeVolume: 0,
        cumulativeFees: 0,
        cumulativePnl: 0,
        accountCount: 0,
      };
    }
    
    let totalVolume = 0;
    let totalFees = 0;
    let totalPnl = 0;
    
    for (const account of data.accounts) {
      if (account.metrics) {
        const takerVol = parseFloat(account.metrics.cumulativeTakerVolume) || 0;
        const makerVol = parseFloat(account.metrics.cumulativeMakerVolume) || 0;
        const fees = parseFloat(account.metrics.cumulativeFeePaid) || 0;
        const pnl = parseFloat(account.metrics.cumulativeRealizedPnl) || 0;
        
        totalVolume += takerVol + makerVol;
        totalFees += fees;
        totalPnl += pnl;
      }
    }
    
    return {
      walletAddress: authorityAddress,
      cumulativeVolume: totalVolume,
      cumulativeFees: totalFees,
      cumulativePnl: totalPnl,
      accountCount: data.accounts.length,
    };
  } catch (error) {
    console.error(`[DriftAPI] Error fetching stats for ${authorityAddress}:`, error);
    return null;
  }
}

export async function fetchPlatformVolumeFromDrift(agentWalletAddresses: string[]): Promise<PlatformVolumeFromDrift> {
  const results = await Promise.all(
    agentWalletAddresses.map(addr => fetchWalletTradingStats(addr))
  );
  
  const validResults = results.filter((r): r is WalletVolumeData => r !== null);
  
  const totalVolume = validResults.reduce((sum, r) => sum + r.cumulativeVolume, 0);
  const totalFees = validResults.reduce((sum, r) => sum + r.cumulativeFees, 0);
  
  return {
    totalVolume,
    totalFees,
    walletData: validResults,
  };
}
