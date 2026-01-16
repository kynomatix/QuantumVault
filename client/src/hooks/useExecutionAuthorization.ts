import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { useToast } from './use-toast';

interface ExecutionStatus {
  executionEnabled: boolean;
  executionExpiresAt: Date | null;
  emergencyStopTriggered: boolean;
  emergencyStopAt: Date | null;
}

export function useExecutionAuthorization() {
  const wallet = useWallet();
  const { toast } = useToast();
  
  const [executionEnabled, setExecutionEnabled] = useState(false);
  const [executionLoading, setExecutionLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [emergencyStopTriggered, setEmergencyStopTriggered] = useState(false);

  const fetchExecutionStatus = useCallback(async (): Promise<ExecutionStatus | null> => {
    try {
      const res = await fetch('/api/auth/execution-status', { credentials: 'include' });
      if (res.ok) {
        const data: ExecutionStatus = await res.json();
        setExecutionEnabled(data.executionEnabled);
        setEmergencyStopTriggered(data.emergencyStopTriggered);
        return data;
      }
      return null;
    } catch (err) {
      console.error('Failed to fetch execution status:', err);
      return null;
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchExecutionStatus();
  }, [fetchExecutionStatus]);

  const unlockSession = useCallback(async (): Promise<string | null> => {
    if (!wallet.publicKey || !wallet.signMessage) {
      return null;
    }
    
    try {
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: wallet.publicKey.toBase58(), purpose: 'unlock_umk' }),
      });
      if (!nonceRes.ok) {
        throw new Error('Failed to get signing nonce');
      }
      const { nonce, message } = await nonceRes.json();
      
      toast({ title: 'Session expired', description: 'Please sign to reconnect your wallet.' });
      
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await wallet.signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);
      
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          walletAddress: wallet.publicKey.toBase58(),
          nonce,
          signature: signatureBase58,
          purpose: 'unlock_umk',
        }),
      });
      
      if (!verifyRes.ok) {
        throw new Error('Failed to reconnect session');
      }
      
      const verifyData = await verifyRes.json();
      return verifyData.sessionId || null;
    } catch (err) {
      console.error('Failed to unlock session:', err);
      return null;
    }
  }, [wallet, toast]);

  const enableExecution = useCallback(async (): Promise<boolean> => {
    if (!wallet.publicKey || !wallet.signMessage) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return false;
    }
    
    setExecutionLoading(true);
    try {
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionRes.ok) {
        throw new Error('Session check failed');
      }
      let sessionData = await sessionRes.json();
      
      if (sessionData.sessionMissing) {
        const newSessionId = await unlockSession();
        if (!newSessionId) {
          throw new Error('Failed to reconnect session. Please try again.');
        }
        sessionData = { hasSession: true, sessionId: newSessionId };
      }
      
      if (!sessionData.hasSession || !sessionData.sessionId) {
        throw new Error('No active session. Please reconnect your wallet.');
      }
      
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: wallet.publicKey.toBase58(), purpose: 'enable_execution' }),
      });
      if (!nonceRes.ok) {
        throw new Error('Failed to get signing nonce');
      }
      const { nonce, message } = await nonceRes.json();
      
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await wallet.signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);
      
      const enableRes = await fetch('/api/auth/enable-execution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sessionId: sessionData.sessionId,
          nonce,
          signature: signatureBase58,
        }),
      });
      
      if (!enableRes.ok) {
        const errorData = await enableRes.json();
        throw new Error(errorData.error || 'Failed to enable execution');
      }
      
      setExecutionEnabled(true);
      toast({ title: 'Automated trading enabled', description: 'Your bots can now execute trades via webhooks.' });
      return true;
    } catch (err: unknown) {
      const error = err as Error;
      if (error.message?.includes('User rejected')) {
        toast({ title: 'Signature cancelled', variant: 'destructive' });
      } else {
        toast({ title: 'Failed to enable execution', description: error.message, variant: 'destructive' });
      }
      return false;
    } finally {
      setExecutionLoading(false);
    }
  }, [wallet, toast, unlockSession]);

  const revokeExecution = useCallback(async (): Promise<boolean> => {
    if (!wallet.publicKey || !wallet.signMessage) {
      toast({ title: 'Wallet not connected', variant: 'destructive' });
      return false;
    }
    
    setExecutionLoading(true);
    try {
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionRes.ok) {
        throw new Error('Session check failed');
      }
      let sessionData = await sessionRes.json();
      
      if (sessionData.sessionMissing) {
        const newSessionId = await unlockSession();
        if (!newSessionId) {
          throw new Error('Failed to reconnect session. Please try again.');
        }
        sessionData = { hasSession: true, sessionId: newSessionId };
      }
      
      if (!sessionData.hasSession || !sessionData.sessionId) {
        throw new Error('No active session. Please reconnect your wallet.');
      }
      
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: wallet.publicKey.toBase58(), purpose: 'revoke_execution' }),
      });
      if (!nonceRes.ok) {
        throw new Error('Failed to get signing nonce');
      }
      const { nonce, message } = await nonceRes.json();
      
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await wallet.signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);
      
      const revokeRes = await fetch('/api/auth/revoke-execution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sessionId: sessionData.sessionId,
          nonce,
          signature: signatureBase58,
        }),
      });
      
      if (!revokeRes.ok) {
        const errorData = await revokeRes.json();
        throw new Error(errorData.error || 'Failed to revoke execution');
      }
      
      setExecutionEnabled(false);
      toast({ title: 'Automated trading disabled' });
      return true;
    } catch (err: unknown) {
      const error = err as Error;
      if (error.message?.includes('User rejected')) {
        toast({ title: 'Signature cancelled', variant: 'destructive' });
      } else {
        toast({ title: 'Failed to revoke execution', description: error.message, variant: 'destructive' });
      }
      return false;
    } finally {
      setExecutionLoading(false);
    }
  }, [wallet, toast, unlockSession]);

  return {
    executionEnabled,
    executionLoading,
    statusLoading,
    emergencyStopTriggered,
    enableExecution,
    revokeExecution,
    refetchStatus: fetchExecutionStatus,
  };
}
