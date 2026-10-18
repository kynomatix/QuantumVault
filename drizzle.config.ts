import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  // Runtime SQL owns these undeclared tables (server/db.ts); never diff/drop them.
  // Excluding them also removes Kit's pre-drop DISABLE ROW LEVEL SECURITY statements.
  tablesFilter: [
    "!grid_auto_resume",
    "!grid_control_keys",
    "!grid_control_requests",
    "!grid_exact_fills",
    "!grid_execution_claims",
    "!grid_launch_accounts",
    "!grid_lifecycle",
    "!grid_master_quota",
    "!grid_monitor_orders",
    "!grid_monitor_state",
    "!grid_profit_allocations",
    "!grid_read_claims",
    "!grid_risk_events",
    "!grid_wallet_safety",
    "!phoenix_accounting_events",
    "!phoenix_accounting_state",
    "!phoenix_ai_executions",
    "!phoenix_equity_snapshots",
    "!phoenix_order_intents",
    "!phoenix_parking_intents",
    "!phoenix_position_epochs",
  ],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
