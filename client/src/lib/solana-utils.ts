import { Connection, TransactionSignature, Commitment } from '@solana/web3.js';

interface ConfirmOptions {
  signature: TransactionSignature;
  blockhash: string;
  lastValidBlockHeight: number;
}

export async function confirmTransactionWithFallback(
  connection: Connection,
  options: ConfirmOptions,
  maxRetries: number = 10,
  commitment: Commitment = 'processed'
): Promise<void> {
  const { signature, blockhash, lastValidBlockHeight } = options;
  
  // Immediately check if already confirmed (fastest path)
  try {
    const status = await connection.getSignatureStatus(signature);
    if (status?.value?.confirmationStatus) {
      if (status?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
      }
      console.log('Transaction already confirmed:', signature, status.value.confirmationStatus);
      return;
    }
  } catch (e) {
    // Continue to websocket confirmation
  }
  
  // Use WebSocket subscription for faster confirmation
  return new Promise((resolve, reject) => {
    let resolved = false;
    let subscriptionId: number | null = null;
    
    // Timeout after 30 seconds max
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (subscriptionId !== null) {
          connection.removeSignatureListener(subscriptionId).catch(() => {});
        }
        // Do a final check before rejecting
        connection.getSignatureStatus(signature, { searchTransactionHistory: true })
          .then(status => {
            if (status?.value?.confirmationStatus) {
              if (status?.value?.err) {
                reject(new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`));
              } else {
                resolve();
              }
            } else {
              reject(new Error('Transaction confirmation timed out. Check your wallet for status.'));
            }
          })
          .catch(() => reject(new Error('Transaction confirmation timed out. Check your wallet for status.')));
      }
    }, 30000);
    
    // Subscribe to signature status updates via WebSocket
    try {
      subscriptionId = connection.onSignature(
        signature,
        (result, context) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            if (subscriptionId !== null) {
              connection.removeSignatureListener(subscriptionId).catch(() => {});
            }
            if (result.err) {
              reject(new Error(`Transaction failed: ${JSON.stringify(result.err)}`));
            } else {
              console.log('Transaction confirmed via WebSocket:', signature);
              resolve();
            }
          }
        },
        commitment
      );
    } catch (wsError) {
      console.log('WebSocket subscription failed, falling back to polling:', wsError);
      // Fallback to polling if WebSocket fails
      clearTimeout(timeout);
      pollForConfirmation(connection, signature, maxRetries)
        .then(resolve)
        .catch(reject);
      return;
    }
    
    // Also poll as backup (in case WebSocket is slow/fails)
    const pollInterval = setInterval(async () => {
      if (resolved) {
        clearInterval(pollInterval);
        return;
      }
      try {
        const status = await connection.getSignatureStatus(signature);
        if (status?.value?.confirmationStatus) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            clearInterval(pollInterval);
            if (subscriptionId !== null) {
              connection.removeSignatureListener(subscriptionId).catch(() => {});
            }
            if (status?.value?.err) {
              reject(new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`));
            } else {
              console.log('Transaction confirmed via polling:', signature);
              resolve();
            }
          }
        }
      } catch (e) {
        // Continue polling
      }
    }, 400); // Poll every 400ms
  });
}

async function pollForConfirmation(
  connection: Connection, 
  signature: string, 
  maxRetries: number
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    
    if (status?.value?.confirmationStatus) {
      if (status?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
      }
      console.log('Transaction confirmed via fallback polling:', signature);
      return;
    }
    
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  
  throw new Error('Transaction confirmation timed out. Please check your wallet for status.');
}

export async function confirmTransactionFast(
  connection: Connection,
  signature: TransactionSignature,
): Promise<{ confirmed: boolean; error?: string }> {
  try {
    const status = await connection.getSignatureStatus(signature);
    if (status?.value?.err) {
      return { confirmed: false, error: JSON.stringify(status.value.err) };
    }
    if (status?.value?.confirmationStatus) {
      return { confirmed: true };
    }
    return { confirmed: false };
  } catch (e) {
    return { confirmed: false };
  }
}
