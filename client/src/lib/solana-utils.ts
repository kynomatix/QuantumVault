import { Connection, TransactionSignature } from '@solana/web3.js';

interface ConfirmOptions {
  signature: TransactionSignature;
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function confirmTransactionWithFallback(
  connection: Connection,
  options: ConfirmOptions,
  maxRetries: number = 30
): Promise<void> {
  const { signature, blockhash, lastValidBlockHeight } = options;
  
  try {
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });
    return;
  } catch (confirmError: any) {
    if (!confirmError.message?.includes('block height exceeded')) {
      throw confirmError;
    }
    
    console.log('Block height exceeded, checking if transaction succeeded...');
    
    for (let i = 0; i < maxRetries; i++) {
      const status = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      });
      
      if (status?.value?.confirmationStatus === 'confirmed' || 
          status?.value?.confirmationStatus === 'finalized') {
        console.log('Transaction confirmed via fallback check:', signature);
        return;
      }
      
      if (status?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error('Transaction confirmation timed out. Please check your wallet for status.');
  }
}
