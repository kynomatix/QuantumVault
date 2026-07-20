// Boot id: identifies this server process generation. The in-memory UMK
// security sessions are wiped on every deploy/restart, so the client's
// session-probe records this id with each probe — a changed bootId across
// probes explains "cookie valid but UMK gone" authoritatively (server
// restarted) instead of guessing (2026-07-20 incident follow-up).
//
// Lives in its own tiny module (imported by routes.ts and request-trace.ts)
// so the trace lines and /api/auth/session report the SAME id without an
// import cycle through the 21k-line routes module.
import crypto from "crypto";

export const SERVER_BOOT_ID = crypto.randomUUID();
