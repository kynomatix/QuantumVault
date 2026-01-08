import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, decimal, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  displayName: text("display_name"),
  referralCode: text("referral_code").unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  displayName: true,
  referralCode: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // "Signal Bot" or "Grid Bot"
  market: text("market").notNull(),
  apr: decimal("apr", { precision: 10, scale: 2 }).notNull(),
  subscribers: integer("subscribers").default(0).notNull(),
  creatorUsername: text("creator_username").notNull(),
  rating: decimal("rating", { precision: 3, scale: 1 }).notNull(),
  minDeposit: integer("min_deposit").notNull(),
  featured: boolean("featured").default(false).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBotSchema = createInsertSchema(bots).omit({
  createdAt: true,
  subscribers: true,
});
export type InsertBot = z.infer<typeof insertBotSchema>;
export type Bot = typeof bots.$inferSelect;

export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  botId: text("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"), // active, paused
  subscribedAt: timestamp("subscribed_at").defaultNow().notNull(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptions).omit({
  id: true,
  subscribedAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptions.$inferSelect;

export const portfolios = pgTable("portfolios", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  totalValue: decimal("total_value", { precision: 20, scale: 2 }).default("0").notNull(),
  unrealizedPnl: decimal("unrealized_pnl", { precision: 20, scale: 2 }).default("0").notNull(),
  realizedPnl: decimal("realized_pnl", { precision: 20, scale: 2 }).default("0").notNull(),
  solBalance: decimal("sol_balance", { precision: 20, scale: 8 }).default("0").notNull(),
  usdcBalance: decimal("usdc_balance", { precision: 20, scale: 2 }).default("0").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPortfolioSchema = createInsertSchema(portfolios);
export type InsertPortfolio = z.infer<typeof insertPortfolioSchema>;
export type Portfolio = typeof portfolios.$inferSelect;

export const positions = pgTable("positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  market: text("market").notNull(),
  side: text("side").notNull(), // LONG or SHORT
  size: decimal("size", { precision: 20, scale: 8 }).notNull(),
  entryPrice: decimal("entry_price", { precision: 20, scale: 2 }).notNull(),
  currentPrice: decimal("current_price", { precision: 20, scale: 2 }).notNull(),
  pnl: decimal("pnl", { precision: 20, scale: 2 }).notNull(),
  pnlPercent: decimal("pnl_percent", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPositionSchema = createInsertSchema(positions).omit({
  id: true,
  createdAt: true,
});
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type Position = typeof positions.$inferSelect;

export const trades = pgTable("trades", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  market: text("market").notNull(),
  side: text("side").notNull(), // BUY or SELL
  size: decimal("size", { precision: 20, scale: 8 }).notNull(),
  price: decimal("price", { precision: 20, scale: 2 }).notNull(),
  total: decimal("total", { precision: 20, scale: 2 }).notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

export const insertTradeSchema = createInsertSchema(trades).omit({
  id: true,
  timestamp: true,
});
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof trades.$inferSelect;

export const leaderboardStats = pgTable("leaderboard_stats", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  totalVolume: decimal("total_volume", { precision: 20, scale: 2 }).default("0").notNull(),
  totalPnl: decimal("total_pnl", { precision: 20, scale: 2 }).default("0").notNull(),
  winRate: decimal("win_rate", { precision: 5, scale: 2 }).default("0").notNull(),
  totalTrades: integer("total_trades").default(0).notNull(),
  rank: integer("rank"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLeaderboardStatsSchema = createInsertSchema(leaderboardStats);
export type InsertLeaderboardStats = z.infer<typeof insertLeaderboardStatsSchema>;
export type LeaderboardStats = typeof leaderboardStats.$inferSelect;
