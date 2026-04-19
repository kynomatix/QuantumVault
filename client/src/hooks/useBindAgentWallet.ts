import { useToast } from '@/hooks/use-toast';
import { safeResponseJson } from '@/lib/safe-fetch';
import bs58 from 'bs58';

interface WalletLike {
  signMessage?: ((msg: Uint8Array) => Promise<Uint8Array>) | undefined;
  publicKey?: { toBase58(): string } | null;
}

export function useBindAgentWallet(wallet: WalletLike) {
  const { toast } = useToast();

  const bindAgentWallet = async (): Promise<boolean> => {
    try {
      if (!wallet.signMessage || !wallet.publicKey) {
        toast({
          title: 'Wallet not connected',
          description: 'Please connect your wallet to authorize the agent.',
          variant: 'destructive',
        });
        return false;
      }
      toast({
        title: 'Authorizing agent wallet...',
        description: 'Please approve the signing request in your wallet.',
      });
      const prepareRes = await fetch('/api/agent/prepare-bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!prepareRes.ok) {
        const err = await safeResponseJson(prepareRes);
        throw new Error(err.error || 'Failed to prepare bind');
      }
      const { message } = await prepareRes.json();
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await wallet.signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);
      const confirmRes = await fetch('/api/agent/confirm-bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ signature: signatureBase58 }),
      });
      if (!confirmRes.ok) {
        const err = await safeResponseJson(confirmRes);
        throw new Error(err.error || 'Failed to bind agent wallet');
      }
      toast({
        title: 'Agent wallet authorized',
        description: 'Your bot can now execute trades.',
      });
      return true;
    } catch (error: any) {
      if (error?.message?.includes('User rejected')) {
        toast({
          title: 'Signing cancelled',
          description: 'You declined the wallet signing request.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Authorization failed',
          description: error.message,
          variant: 'destructive',
        });
      }
      return false;
    }
  };

  return bindAgentWallet;
}
