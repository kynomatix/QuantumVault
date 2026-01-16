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
      console.log('[EnableExecution] Starting...');
      
      // Step 1: Check session status
      const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionRes.ok) {
        throw new Error('Session check failed');
      }
      let sessionData = await sessionRes.json();
      console.log('[EnableExecution] Session check:', { hasSession: sessionData.hasSession, sessionMissing: sessionData.sessionMissing });
      
      // Step 2: Unlock session if missing (user signs first message)
      if (sessionData.sessionMissing) {
        console.log('[EnableExecution] Session missing, unlocking...');
        const newSessionId = await unlockSession();
        if (!newSessionId) {
          throw new Error('Failed to reconnect session. Please try again.');
        }
        console.log('[EnableExecution] Session unlocked, refreshing session data...');
        
        // Re-fetch session from server to ensure cookie and server state are aligned
        const refreshRes = await fetch('/api/auth/session', { credentials: 'include' });
        if (!refreshRes.ok) {
          throw new Error('Failed to refresh session after unlock');
        }
        sessionData = await refreshRes.json();
        console.log('[EnableExecution] Refreshed session:', { hasSession: sessionData.hasSession, sessionId: sessionData.sessionId?.slice(0, 8) });
      }
      
      if (!sessionData.hasSession || !sessionData.sessionId) {
        throw new Error('No active session. Please reconnect your wallet.');
      }
      
      // Step 3: Get nonce for enable_execution
      console.log('[EnableExecution] Getting nonce for enable_execution...');
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress: wallet.publicKey.toBase58(), purpose: 'enable_execution' }),
      });
      if (!nonceRes.ok) {
        const errText = await nonceRes.text();
        throw new Error(`Failed to get signing nonce: ${errText}`);
      }
      const { nonce, message } = await nonceRes.json();
      console.log('[EnableExecution] Got nonce, requesting signature...');
      
      // Step 4: Sign message (user signs second message)
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await wallet.signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);
      console.log('[EnableExecution] Signature obtained, calling enable-execution API...');
      
      // Step 5: Call enable-execution endpoint
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
      
      console.log('[EnableExecution] API response status:', enableRes.status);
      
      if (!enableRes.ok) {
        const errorData = await enableRes.json();
        throw new Error(errorData.error || 'Failed to enable execution');
      }
      
      console.log('[EnableExecution] Success!');
      setExecutionEnabled(true);
      toast({ title: 'Automated trading enabled', description: 'Your bots can now execute trades via webhooks.' });
      return true;
    } catch (err: unknown) {
      const error = err as Error;
      console.error('[EnableExecution] Error:', error.message, error.stack);
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
        // Re-fetch session from server to ensure cookie and server state are aligned
        const refreshRes = await fetch('/api/auth/session', { credentials: 'include' });
        if (!refreshRes.ok) {
          throw new Error('Failed to refresh session after unlock');
        }
        sessionData = await refreshRes.json();
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
