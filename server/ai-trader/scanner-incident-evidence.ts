import { createHash, randomUUID } from "node:crypto";

export type ScannerIncidentWindow = "baseline" | "canary";
export type ScannerIncidentHoldState = ScannerIncidentWindow | "exported" | "released";

export const SCANNER_INCIDENT_EXPORT_TIMEOUT_MS = 5_000;
export const SCANNER_INCIDENT_HOLD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

const SAFE_SOURCES = new Set(["scanner-sweep", "datafeed"]);
const NUMERIC_ONLY_CONTEXT_KEYS = new Set([
  "primaryCacheDegraded",
  "skippedByTimeout",
  "uptimeSec",
  "venueClosed",
]);
const SCANNER_BOUNDARY_TIMEFRAMES = new Set(["15m", "1h", "4h", "1d"]);
const SAFE_CONTEXT_KEYS = new Set([
  "accountingValid",
  "abandoned",
  "abandonedMarkets",
  "attempted",
  "budgetMs",
  "budgetSkippedUnits",
  "candidates",
  "durationMs",
  "elapsedMs",
  "env",
  "errors",
  "feedHealthSkipped",
  "kind",
  "parentCacheDegraded",
  "pid",
  "primaryCacheDegraded",
  "scanned",
  "skippedByTimeout",
  "symbol",
  "timeframe",
  "timeoutSkipped",
  "unclassified",
  "uptimeSec",
  "venueClosed",
  "boundaryTfs",
]);

export interface ScannerIncidentCaptureInput {
  eventId: string;
  fingerprint: string;
  observedAt: Date;
  category: "scanner";
  source: string;
  summary: string;
  context: Record<string, boolean | number | string | string[]>;
}

export interface ScannerIncidentOccurrenceExportRow extends ScannerIncidentCaptureInput {
  holdId: string;
  window: ScannerIncidentWindow;
}

export interface ScannerIncidentExportPayload {
  schemaVersion: 1;
  holdId: string;
  rawRowCount: number;
  windows: Record<ScannerIncidentWindow, { rawOccurrences: number }>;
  fingerprints: Array<{
    fingerprint: string;
    baseline: number;
    canary: number;
    total: number;
  }>;
  occurrences: Array<{
    eventId: string;
    window: ScannerIncidentWindow;
    fingerprint: string;
    observedAt: string;
    category: "scanner";
    source: string;
    summary: string;
    context: Record<string, boolean | number | string | string[]>;
  }>;
}

export interface ScannerIncidentExportPacket {
  payload: ScannerIncidentExportPayload;
  digestAlgorithm: "sha256";
  digest: string;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|signature|private[_ -]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|secret|signature|key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/0x[a-fA-F0-9]{6,}/g, "0x[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, "[base58]");
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  if (!redacted) return undefined;
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

export function normalizeScannerIncidentHoldId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return SCANNER_INCIDENT_HOLD_ID_PATTERN.test(normalized) ? normalized : null;
}

export function sanitizeScannerIncidentContext(
  context: Record<string, unknown> | undefined,
): Record<string, boolean | number | string | string[]> {
  if (!context) return {};
  const sanitized: Record<string, boolean | number | string | string[]> = {};
  for (const key of Object.keys(context).sort()) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    const value = context[key];
    if (NUMERIC_ONLY_CONTEXT_KEYS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value)) sanitized[key] = value;
      continue;
    }
    if (key === "boundaryTfs") {
      if (!Array.isArray(value)) continue;
      sanitized[key] = value
        .filter((item): item is string => typeof item === "string" && SCANNER_BOUNDARY_TIMEFRAMES.has(item))
        .filter((item, index, items) => items.indexOf(item) === index)
        .slice(0, 4);
      continue;
    }
    if (typeof value === "boolean") {
      sanitized[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === "string") {
      const safe = boundedText(value, 120);
      if (safe !== undefined) sanitized[key] = safe;
    } else if (key === "abandonedMarkets" && Array.isArray(value)) {
      sanitized[key] = value
        .slice(0, 100)
        .map((item) => boundedText(item, 64))
        .filter((item): item is string => item !== undefined);
    }
  }
  return sanitized;
}

export function createScannerIncidentCaptureInput(params: {
  fingerprint: string;
  observedAt?: Date;
  eventId?: string;
  source?: string;
  message: string;
  context?: Record<string, unknown>;
}): ScannerIncidentCaptureInput {
  return {
    eventId: params.eventId ?? randomUUID(),
    fingerprint: params.fingerprint,
    observedAt: params.observedAt ?? new Date(),
    category: "scanner",
    source: params.source && SAFE_SOURCES.has(params.source) ? params.source : "scanner",
    summary: boundedText(params.message, 500) ?? "scanner incident",
    context: sanitizeScannerIncidentContext(params.context),
  };
}

function canonicalOccurrence(row: ScannerIncidentOccurrenceExportRow) {
  const observedAt = row.observedAt instanceof Date ? row.observedAt : new Date(row.observedAt);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid scanner incident observedAt");
  return {
    eventId: row.eventId,
    window: row.window,
    fingerprint: row.fingerprint,
    observedAt: observedAt.toISOString(),
    category: "scanner" as const,
    source: row.source,
    summary: row.summary,
    context: Object.fromEntries(Object.entries(row.context ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function buildScannerIncidentExport(
  holdId: string,
  rows: ScannerIncidentOccurrenceExportRow[],
): ScannerIncidentExportPacket {
  const occurrences = rows
    .map(canonicalOccurrence)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.eventId.localeCompare(b.eventId));
  const windows = {
    baseline: { rawOccurrences: 0 },
    canary: { rawOccurrences: 0 },
  };
  const byFingerprint = new Map<string, { baseline: number; canary: number }>();
  for (const row of occurrences) {
    windows[row.window].rawOccurrences += 1;
    const counts = byFingerprint.get(row.fingerprint) ?? { baseline: 0, canary: 0 };
    counts[row.window] += 1;
    byFingerprint.set(row.fingerprint, counts);
  }
  const fingerprints = [...byFingerprint.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fingerprint, counts]) => ({
      fingerprint,
      baseline: counts.baseline,
      canary: counts.canary,
      total: counts.baseline + counts.canary,
    }));
  const payload: ScannerIncidentExportPayload = {
    schemaVersion: 1,
    holdId,
    rawRowCount: occurrences.length,
    windows,
    fingerprints,
    occurrences,
  };
  return {
    payload,
    digestAlgorithm: "sha256",
    digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex").toUpperCase(),
  };
}
