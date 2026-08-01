import { recordCriticalError } from "./error-log";
import { appendTelemetry } from "./telemetry";

type BackgroundComponent = "ai-trader-monitor" | "scanner";

type StartupFailureClass =
  | "module_not_found"
  | "timeout"
  | "type_error"
  | "range_error"
  | "db_connection"
  | "other";

const DB_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
]);

function readStructuralString(error: unknown, field: "name" | "code"): string | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return undefined;
  }

  try {
    const value = Reflect.get(error, field);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
function isErrorInstance(error: unknown, kind: typeof TypeError | typeof RangeError): boolean {
  try {
    return error instanceof kind;
  } catch {
    return false;
  }
}

function classifyStartFailure(error: unknown): StartupFailureClass {
  const code = readStructuralString(error, "code");
  const name = readStructuralString(error, "name");

  if (code === "ERR_MODULE_NOT_FOUND") return "module_not_found";
  if (name === "TimeoutError" || code === "ETIMEDOUT") return "timeout";
  if (isErrorInstance(error, TypeError)) return "type_error";
  if (isErrorInstance(error, RangeError)) return "range_error";
  if (code && (DB_CONNECTION_CODES.has(code) || /^08[A-Z0-9]{3}$/.test(code))) {
    return "db_connection";
  }
  return "other";
}

function reportStartFailure(component: BackgroundComponent, error: unknown): void {
  const failureClass = classifyStartFailure(error);

  try {
    console.error(`[Startup] ${component} failed to start`);
  } catch {}

  try {
    appendTelemetry(`[Startup] ${component} failed to start failure=${failureClass}`);
  } catch {}

  try {
    recordCriticalError({
      category: component === "ai-trader-monitor" ? "crash" : "scanner",
      severity: "error",
      source: `${component}-startup`,
      message: `${component} failed to start`,
      context: { failureClass },
    });
  } catch {}
}

export async function startObservedBackgroundComponent({
  component,
  beforeStart,
  announce,
  loadAndStart,
}: {
  component: BackgroundComponent;
  beforeStart?: () => Promise<void>;
  announce: () => void;
  loadAndStart: () => Promise<void>;
}): Promise<void> {
  try {
    if (beforeStart) await beforeStart();
    announce();
    await loadAndStart();
  } catch (error) {
    reportStartFailure(component, error);
  }
}
