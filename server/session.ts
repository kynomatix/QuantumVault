import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";

function requireSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("SESSION_SECRET environment variable is required");
  }
  return secret;
}

const sessionSecret = requireSessionSecret();
const PgStore = connectPgSimple(session);

// Mirror the main pool's hardening (server/db.ts): idle timeout below Neon's
// ~30s idle eviction, TCP keepAlive against silent proxy drops, and a generous
// establishment timeout (prod 2026-07-16 showed slow new-connection handshakes).
const sessionConnTimeoutMs = parseInt(process.env.DB_CONN_TIMEOUT_MS || "30000", 10);
const sessionPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: sessionConnTimeoutMs,
  idleTimeoutMillis: 15_000,
  keepAlive: true,
});

// Without an 'error' listener, an idle-client error on this pool is an
// unhandled 'error' event — which crashes the whole process. The main pool
// (server/db.ts) has always had one; this pool was unguarded.
sessionPool.on("error", (err) => {
  console.error(`[Session Pool] idle client error: ${err.message}`);
  console.log(`[Session Pool] total=${sessionPool.totalCount} idle=${sessionPool.idleCount} waiting=${sessionPool.waitingCount} max=5`);
});

export const sessionMiddleware = session({
  store: new PgStore({
    pool: sessionPool,
    tableName: "user_sessions",
    createTableIfMissing: true,
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "lax" : undefined,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});
