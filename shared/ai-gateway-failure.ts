export const GATEWAY_FAILURE_CLASSES = ["timeout", "abort", "http", "network", "envelope_parse", "other"] as const;
export interface GatewayFailure {
  failureClass: (typeof GATEWAY_FAILURE_CLASSES)[number];
  httpStatus: number | null;
  providerCode: string | null;
  providerType: string | null;
  elapsedMs: number;
  attemptCount: number;
}

// Error fields are untrusted too: providers can echo credentials or request text
// in ANY field. Retain only known diagnostic identifiers, never arbitrary strings.
const SAFE_IDENTIFIERS = new Set([
  "invalid_request", "invalid_request_error", "invalid_json_schema", "invalid_schema",
  "invalid_tool_schema", "invalid_function_parameters", "unsupported_parameter",
  "unsupported_value", "bad_request", "authentication_error", "permission_error",
  "insufficient_quota", "insufficient_credits", "rate_limit_exceeded", "rate_limit_error",
  "model_not_found", "not_found_error", "provider_error", "provider_unavailable",
  "no_available_provider", "server_error", "internal_error", "api_error",
  "overloaded_error", "timeout", "request_timeout", "context_length_exceeded",
  "content_filter", "moderation_error", "unknown", "other",
]);
function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 99999) return String(value);
  if (typeof value !== "string") return null;
  if (/^\d{1,5}$/.test(value)) return value;
  return value.length <= 48 && SAFE_IDENTIFIERS.has(value) ? value : "other";
}
const boundedInteger = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;

/** Total, bounded projection used again at persistence and API boundaries. */
export function sanitizeGatewayFailure(value: unknown): GatewayFailure | null {
  try {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    return {
      failureClass: GATEWAY_FAILURE_CLASSES.includes(v.failureClass as GatewayFailure["failureClass"])
        ? v.failureClass as GatewayFailure["failureClass"] : "other",
      httpStatus: typeof v.httpStatus === "number" && Number.isInteger(v.httpStatus) && v.httpStatus >= 100 && v.httpStatus <= 599 ? v.httpStatus : null,
      providerCode: identifier(v.providerCode), providerType: identifier(v.providerType),
      elapsedMs: boundedInteger(v.elapsedMs, 86_400_000),
      attemptCount: boundedInteger(v.attemptCount, 1000),
    };
  } catch { return null; }
}
