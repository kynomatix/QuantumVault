import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const poolSize = parseInt(process.env.DB_POOL_SIZE || "20", 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolSize,
});

export const db = drizzle(pool, { schema });
