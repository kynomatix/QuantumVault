import type { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { storage } from "./storage";
import {
  buildOverviewJsonForChat,
  buildPositionsJsonForChat,
  buildBotsJsonForChat,
  buildTodayJsonForChat,
} from "./telegram-summary";

// ---------------------------------------------------------------------------
// Telegram Mini App auth surface (Task #136)
//
// This is an isolated auth surface that does NOT share middleware with
// requireWallet (session cookie) or the planned Bearer-token surface. Every
// request to /api/tg/* carries an `Authorization: tma <initData>` header
// per Telegram's spec; we HMAC-verify against TELEGRAM_BOT_TOKEN and reject
// stale auth_dates. All endpoints are strictly read-only.
// ---------------------------------------------------------------------------

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60; // 24h, per Telegram recommendation.

interface TelegramInitUser {
  id: string;
  username?: string;
  first_name?: string;
}

interface VerifiedInitData {
  user: TelegramInitUser;
  authDate: number;
}

declare global {
  namespace Express {
    interface Request {
      tgUser?: TelegramInitUser;
      tgWalletAddresses?: string[];
    }
  }
}

/**
 * Verify Telegram WebApp `initData` per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns the parsed user + auth_date when the HMAC checks out, or null on
 * any failure (bad signature, missing fields, malformed payload). Constant-
 * time compare on the hex digest to avoid timing oracles.
 */
function verifyInitData(initData: string, botToken: string): VerifiedInitData | null {
  if (!initData || !botToken) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }

  const providedHash = params.get("hash");
  if (!providedHash) return null;
  params.delete("hash");

  const keys = Array.from(params.keys()).sort();
  const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(providedHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw ? parseInt(authDateRaw, 10) : NaN;
  if (!Number.isFinite(authDate)) return null;
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > MAX_AUTH_AGE_SECONDS || ageSec < -60) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;
  let userJson: any;
  try {
    userJson = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (!userJson || typeof userJson.id === "undefined") return null;

  return {
    user: {
      id: String(userJson.id),
      username: typeof userJson.username === "string" ? userJson.username : undefined,
      first_name: typeof userJson.first_name === "string" ? userJson.first_name : undefined,
    },
    authDate,
  };
}

function requireTelegramAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(503).json({ error: "Telegram bot token not configured" });
    return;
  }
  const header = req.header("authorization") || "";
  const m = header.match(/^tma\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ error: "Missing Telegram initData" });
    return;
  }
  const verified = verifyInitData(m[1], token);
  if (!verified) {
    res.status(401).json({ error: "Invalid Telegram initData" });
    return;
  }

  // In private 1:1 chats with the bot, chat.id === user.id, so the existing
  // `wallets.telegram_chat_id` column maps cleanly to initData.user.id with
  // no schema change. Users who have linked multiple wallets to the same
  // chat will see all of them aggregated in the Mini App.
  storage
    .getWalletsByTelegramChatId(verified.user.id)
    .then(wallets => {
      if (!wallets || wallets.length === 0) {
        res.status(401).json({
          error: "No QuantumVault wallet linked to this Telegram account",
          hint: "Open QuantumVault → Settings → Notifications → Connect Telegram",
        });
        return;
      }
      req.tgUser = verified.user;
      req.tgWalletAddresses = wallets.map(w => w.address);
      next();
    })
    .catch(err => {
      console.error("[TgMiniApp] wallet lookup failed:", err?.message || err);
      res.status(500).json({ error: "Wallet lookup failed" });
    });
}

export function registerTelegramMiniAppRoutes(app: Express): void {
  app.get("/api/tg/overview", requireTelegramAuth, async (req, res) => {
    try {
      const data = await buildOverviewJsonForChat(req.tgWalletAddresses!);
      res.json(data);
    } catch (err: any) {
      console.error("[TgMiniApp] /overview failed:", err?.message || err);
      res.status(500).json({ error: "Failed to load overview" });
    }
  });

  app.get("/api/tg/positions", requireTelegramAuth, async (req, res) => {
    try {
      const data = await buildPositionsJsonForChat(req.tgWalletAddresses!);
      res.json(data);
    } catch (err: any) {
      console.error("[TgMiniApp] /positions failed:", err?.message || err);
      res.status(500).json({ error: "Failed to load positions" });
    }
  });

  app.get("/api/tg/bots", requireTelegramAuth, async (req, res) => {
    try {
      const data = await buildBotsJsonForChat(req.tgWalletAddresses!);
      res.json(data);
    } catch (err: any) {
      console.error("[TgMiniApp] /bots failed:", err?.message || err);
      res.status(500).json({ error: "Failed to load bots" });
    }
  });

  app.get("/api/tg/today", requireTelegramAuth, async (req, res) => {
    try {
      const data = await buildTodayJsonForChat(req.tgWalletAddresses!);
      res.json(data);
    } catch (err: any) {
      console.error("[TgMiniApp] /today failed:", err?.message || err);
      res.status(500).json({ error: "Failed to load today stats" });
    }
  });

  console.log("[TgMiniApp] Mini App routes registered under /api/tg/*");
}
