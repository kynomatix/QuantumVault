export const SWIFT_CONFIG = {
  enabled: process.env.SWIFT_ENABLED === 'true',
  apiUrl: process.env.SWIFT_API_URL || 'https://swift.drift.trade',
  orderEndpoint: '/orders',
  orderTimeoutMs: 3000,
  healthCheckIntervalMs: 30000,
  maxSwiftRetries: 2,
  fallbackEnabled: true,
} as const;

console.log(`[Swift Config] SWIFT_ENABLED env='${process.env.SWIFT_ENABLED}', config.enabled=${SWIFT_CONFIG.enabled}, apiUrl=${SWIFT_CONFIG.apiUrl}`);

interface SwiftHealthState {
  isHealthy: boolean;
  lastCheckAt: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  latencyMs: number;
  lastErrorMessage: string | null;
}

const swiftHealth: SwiftHealthState = {
  isHealthy: true,
  lastCheckAt: 0,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  latencyMs: 0,
  lastErrorMessage: null,
};

const FAILURE_THRESHOLD = 5;
const RECOVERY_THRESHOLD = 3;

export function getSwiftHealth(): Readonly<SwiftHealthState> {
  return { ...swiftHealth };
}

export function recordSwiftSuccess(latencyMs: number): void {
  swiftHealth.lastCheckAt = Date.now();
  swiftHealth.latencyMs = latencyMs;
  swiftHealth.consecutiveFailures = 0;
  swiftHealth.consecutiveSuccesses++;
  swiftHealth.lastErrorMessage = null;

  if (!swiftHealth.isHealthy && swiftHealth.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
    swiftHealth.isHealthy = true;
    console.log(`[Swift] Health recovered after ${RECOVERY_THRESHOLD} consecutive successes`);
  }
}

export function recordSwiftFailure(errorMessage: string): void {
  swiftHealth.lastCheckAt = Date.now();
  swiftHealth.consecutiveFailures++;
  swiftHealth.consecutiveSuccesses = 0;
  swiftHealth.lastErrorMessage = errorMessage;

  if (swiftHealth.isHealthy && swiftHealth.consecutiveFailures >= FAILURE_THRESHOLD) {
    swiftHealth.isHealthy = false;
    console.warn(`[Swift] Marked unhealthy after ${FAILURE_THRESHOLD} consecutive failures. Last error: ${errorMessage}`);
  }
}

export function resetSwiftHealth(): void {
  swiftHealth.isHealthy = true;
  swiftHealth.lastCheckAt = 0;
  swiftHealth.consecutiveFailures = 0;
  swiftHealth.consecutiveSuccesses = 0;
  swiftHealth.latencyMs = 0;
  swiftHealth.lastErrorMessage = null;
}

export function isSwiftAvailable(): boolean {
  return SWIFT_CONFIG.enabled && swiftHealth.isHealthy;
}

export function shouldUseSwift(): boolean {
  return isSwiftAvailable();
}

export function getSwiftDiagnostics() {
  return {
    config: { ...SWIFT_CONFIG },
    health: { ...swiftHealth },
    shouldUseSwift: isSwiftAvailable(),
    envVar: process.env.SWIFT_ENABLED,
  };
}

export type SwiftErrorClassification = 'retry_swift' | 'fallback_legacy' | 'permanent';

const RETRYABLE_SWIFT_PATTERNS = [
  'timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  '429',
  'too many requests',
  '503',
  'service unavailable',
  '504',
  'gateway timeout',
  'stale slot',
  'slot expired',
];

const FALLBACK_TO_LEGACY_PATTERNS = [
  'no liquidity',
  'auction timeout',
  'no maker found',
  'auction expired',
  'order expired',
  'insufficient liquidity',
];

const PERMANENT_ERROR_PATTERNS = [
  'invalid signature',
  'invalid parameters',
  '401',
  'unauthorized',
  '403',
  'forbidden',
  'account not found',
  'user account not found',
  'insufficient collateral',
];

export function classifySwiftError(error: unknown): SwiftErrorClassification {
  const errorStr = error instanceof Error ? error.message : String(error);
  const lowerError = errorStr.toLowerCase();

  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (lowerError.includes(pattern.toLowerCase())) {
      return 'permanent';
    }
  }

  for (const pattern of FALLBACK_TO_LEGACY_PATTERNS) {
    if (lowerError.includes(pattern.toLowerCase())) {
      return 'fallback_legacy';
    }
  }

  for (const pattern of RETRYABLE_SWIFT_PATTERNS) {
    if (lowerError.includes(pattern.toLowerCase())) {
      return 'retry_swift';
    }
  }

  return 'fallback_legacy';
}
