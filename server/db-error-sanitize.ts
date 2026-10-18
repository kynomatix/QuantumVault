import { DrizzleQueryError } from "drizzle-orm";
import { NodePgPreparedQuery } from "drizzle-orm/node-postgres/session";

const diagnosticFields = ["code", "severity", "constraint", "table", "column", "routine"] as const;

function read(source: object, key: string): unknown {
  try { return Reflect.get(source, key); } catch { return undefined; }
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

// Never retain original errors: even a driver's detail, internalQuery, stack or
// custom inspection properties can contain bound values. Preserve prototypes for
// instanceof, but rebuild own properties and every cause from an allowlist.
function cleanError(source: object, seen: Set<object>): Error | undefined {
  if (seen.has(source)) return undefined;
  seen.add(source);
  const originalCause = read(source, "cause");
  const cause = isObject(originalCause) ? cleanError(originalCause, seen) : undefined;
  const wrapped = source instanceof DrizzleQueryError;
  const diagnosticSource = wrapped ? cause : source;
  const message = diagnosticSource && read(diagnosticSource, "message");
  const name = diagnosticSource && read(diagnosticSource, "name");
  const clean = new Error(typeof message === "string" ? message : "Database query failed");
  Object.setPrototypeOf(clean, Object.getPrototypeOf(source));
  Object.defineProperty(clean, "name", {
    value: typeof name === "string" ? name : "Error", configurable: true, writable: true,
  });
  for (const field of diagnosticFields) {
    const value = diagnosticSource && read(diagnosticSource, field);
    if (typeof value === "string") {
      Object.defineProperty(clean, field, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  if (cause) Object.defineProperty(clean, "cause", { value: cause, configurable: true, writable: true });
  // Materialize only the new stack, after assigning the driver's message/name.
  // No original stack (including Drizzle's SQL/params header) is copied.
  Error.captureStackTrace(clean, cleanError);
  return clean;
}

export function sanitizeDbError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  return cleanError(error, new Set())!;
}

// Version-bound seam: in 0.45.4 both NodePgPreparedQuery.execute() and all()
// call this inherited method, including raw execute, builders, prepared queries,
// relational queries and transaction/savepoint statements. Wrap its result so
// all cache branches keep their existing behavior. There is no error hook in
// NodePgSessionOptions. Fail at startup if an upgrade removes this internal seam.
type QueryWithCache = (this: unknown, query: string, params: unknown[], run: () => Promise<unknown>) => Promise<unknown>;
const installed = Symbol.for("quantumvault.drizzle.node-pg-error-sanitizer");
const prototype = NodePgPreparedQuery.prototype as unknown as {
  queryWithCache: QueryWithCache;
  [installed]?: boolean;
};
if (!prototype[installed]) {
  const queryWithCache = prototype.queryWithCache;
  if (typeof queryWithCache !== "function") {
    throw new Error("Unsupported Drizzle PostgreSQL query execution path");
  }
  prototype.queryWithCache = async function (...args) {
    try {
      return await queryWithCache.apply(this, args);
    } catch (error) {
      throw sanitizeDbError(error);
    }
  };
  Object.defineProperty(prototype, installed, { value: true });
}
