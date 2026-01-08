import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const DRIFT_PROGRAM_ID = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';

const MARKET_INDICES: Record<string, number> = {
  'SOL-PERP': 0,
  'BTC-PERP': 1,
  'ETH-PERP': 2,
  'APT-PERP': 3,
  'MATIC-PERP': 4,
  'ARB-PERP': 5,
};

let driftClient: any = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;

async function initializeDriftClient() {
  if (driftClient) return;
  if (isInitializing && initPromise) {
    await initPromise;
    return;
  }
  
  isInitializing = true;
  
  initPromise = (async () => {
    try {
      const { DriftClient, initialize, BulkAccountLoader, Wallet } = await import('@drift-labs/sdk');
      
      const env = 'mainnet-beta';
      initialize({ env });
      
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      const connection = new Connection(rpcUrl, 'confirmed');
      
      const dummyKeypair = Keypair.generate();
      const wallet = new Wallet(dummyKeypair);
      
      const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 5000);
      
      driftClient = new DriftClient({
        connection,
        wallet: wallet as any,
        programID: new PublicKey(DRIFT_PROGRAM_ID),
        accountSubscription: {
          type: 'polling',
          accountLoader: bulkAccountLoader,
        },
      });
      
      await driftClient.subscribe();
      console.log('Drift client initialized for price feeds');
    } catch (error) {
      console.error('Failed to initialize Drift client:', error);
      driftClient = null;
    } finally {
      isInitializing = false;
    }
  })();
  
  await initPromise;
}

export async function getMarketPrice(market: string): Promise<number | null> {
  const marketIndex = MARKET_INDICES[market];
  if (marketIndex === undefined) {
    console.log(`Unknown market: ${market}`);
    return null;
  }
  
  try {
    await initializeDriftClient();
    
    if (!driftClient) {
      return null;
    }
    
    const { convertToNumber, PRICE_PRECISION } = await import('@drift-labs/sdk');
    const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
    
    if (!oracleData || !oracleData.price) {
      return null;
    }
    
    const price = convertToNumber(oracleData.price, PRICE_PRECISION);
    return price;
  } catch (error) {
    console.error(`Failed to get price for ${market}:`, error);
    return null;
  }
}

export async function getAllPrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  
  try {
    await initializeDriftClient();
    
    if (!driftClient) {
      return prices;
    }
    
    const { convertToNumber, PRICE_PRECISION } = await import('@drift-labs/sdk');
    
    for (const [market, index] of Object.entries(MARKET_INDICES)) {
      try {
        const oracleData = driftClient.getOracleDataForPerpMarket(index);
        if (oracleData && oracleData.price) {
          prices[market] = convertToNumber(oracleData.price, PRICE_PRECISION);
        }
      } catch (e) {
        console.error(`Failed to get price for ${market}:`, e);
      }
    }
  } catch (error) {
    console.error('Failed to get all prices:', error);
  }
  
  return prices;
}
