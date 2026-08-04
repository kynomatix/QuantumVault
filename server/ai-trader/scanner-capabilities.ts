export interface ScannerCapabilities {
  readonly producerEnabled: boolean;
  readonly consumersEnabled: boolean;
  readonly liveExecutionEnabled: boolean;
}

type ScannerCapabilityEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Parse the process scanner capabilities once, without allowing a route or
 * caller to override them. The producer switch intentionally retains its
 * legacy opt-out behavior; the two money-adjacent capabilities are opt-in.
 */
export function parseScannerCapabilities(env: ScannerCapabilityEnvironment): ScannerCapabilities {
  return Object.freeze({
    producerEnabled: env.SCANNER_ENABLED !== "false",
    consumersEnabled: env.SCANNER_CONSUMERS_ENABLED === "true",
    liveExecutionEnabled: env.SCANNER_LIVE_EXECUTION_ENABLED === "true",
  });
}

/** Immutable authority for the lifetime of this process. */
export const SCANNER_CAPABILITIES = parseScannerCapabilities(process.env);
