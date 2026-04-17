import * as fs from 'fs';

const FAILOVER_STATE_FILE = '/tmp/drift_rpc_failover_state.json';
const FAILOVER_COOLDOWN_MS = 3 * 60 * 1000;
const RATE_LIMIT_THRESHOLD = 1;

const TRACKING_WINDOW_MS = 30000;

interface FailoverState {
  activeRpc: 'primary' | 'backup';
  switchedToBackupAt: number | null;
  consecutive429Errors: number;
  lastErrorAt: number | null;
}

function defaultState(): FailoverState {
  return { activeRpc: 'primary', switchedToBackupAt: null, consecutive429Errors: 0, lastErrorAt: null };
}

function loadFailoverState(): FailoverState {
  try {
    if (fs.existsSync(FAILOVER_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(FAILOVER_STATE_FILE, 'utf8'));

      if (data.activeRpc === 'backup' && data.switchedToBackupAt) {
        const elapsed = Date.now() - data.switchedToBackupAt;
        if (elapsed >= FAILOVER_COOLDOWN_MS) {
          console.log('[Drift] Failover cooldown expired - resetting to primary RPC');
          return defaultState();
        }
      }

      if (data.consecutive429Errors > 0 && data.lastErrorAt) {
        const trackingAge = Date.now() - data.lastErrorAt;
        if (trackingAge >= TRACKING_WINDOW_MS) {
          data.consecutive429Errors = 0;
        }
      }

      return data as FailoverState;
    }
  } catch (err) {
    console.error('[Drift] Failed to load failover state:', err);
  }
  return defaultState();
}

function saveFailoverState(state: FailoverState): void {
  try {
    const tempFile = `${FAILOVER_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(state));
    fs.renameSync(tempFile, FAILOVER_STATE_FILE);
  } catch (err) {
    console.error('[Drift] Failed to save failover state:', err);
  }
}

export function reportRPCError(errorType: 'rate_limit' | 'connection' = 'rate_limit'): void {
  const state = loadFailoverState();

  if (state.activeRpc !== 'primary') {
    return;
  }

  state.consecutive429Errors++;
  state.lastErrorAt = Date.now();

  const errorLabel = errorType === 'rate_limit' ? '429 rate limit' : 'RPC connection error';
  console.log(`[Drift] ${errorLabel} detected (count: ${state.consecutive429Errors}/${RATE_LIMIT_THRESHOLD})`);

  if (state.consecutive429Errors >= RATE_LIMIT_THRESHOLD) {
    const backupUrl = process.env.TRITON_ONE_RPC;
    if (backupUrl) {
      state.activeRpc = 'backup';
      state.switchedToBackupAt = Date.now();
      state.consecutive429Errors = 0;
      console.log(`[Drift] FAILOVER: Switching to backup RPC (Triton) due to ${RATE_LIMIT_THRESHOLD}x ${errorLabel}s. Will retry primary in ${FAILOVER_COOLDOWN_MS / 1000}s`);
    } else {
      console.warn(`[Drift] WARNING: ${errorLabel} but no TRITON_ONE_RPC backup configured!`);
    }
  }

  saveFailoverState(state);
}

export function report429Error(): void {
  reportRPCError('rate_limit');
}

export function reset429Counter(): void {
  const state = loadFailoverState();
  if (state.consecutive429Errors > 0) {
    console.log(`[Drift] Resetting 429 counter (was: ${state.consecutive429Errors})`);
    state.consecutive429Errors = 0;
    saveFailoverState(state);
  }
}

export function getActiveRpcUrl(): string {
  const state = loadFailoverState();
  const primaryUrl = process.env.SOLANA_RPC_URL || process.env.HELIUS_RPC_URL;
  const backupUrl = process.env.TRITON_ONE_RPC;

  if (state.activeRpc === 'backup' && backupUrl) {
    console.log('[Drift] Using backup RPC (Triton)');
    return backupUrl;
  }

  return primaryUrl || 'https://api.mainnet-beta.solana.com';
}
