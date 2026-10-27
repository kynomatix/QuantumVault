// Shared lock identity. Importing it must not initialize storage or a pool.
export const AGENT_WALLET_RESET_LOCK_NAMESPACE = 927412;

// MAIN holds this session lock for life; never share it with transaction locks.
export const MAIN_QUOTA_GUARD_LOCK_NAMESPACE = 927416;

export const SIGNAL_BOT_CLOSE_INTENT_LOCK_NAMESPACE = 927415;
