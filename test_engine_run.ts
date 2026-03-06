import { runBacktest } from "./server/lab/engine.ts";
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import ws from "ws";
import { Pool } from "@neondatabase/serverless";
import { neonConfig } from "@neondatabase/serverless";

neonConfig.webSocketConstructor = ws;

const params = {"bbLen": 36, "kcLen": 26, "rsiOB": 93.4, "rsiOS": 19.5, "slPct": 8.1, "useBE": false, "adxLen": 16, "bbMult": 2.1, "emaLen": 358, "kcMult": 1.9, "momLen": 42, "rsiLen": 46, "slMode": "Percentage", "tp1Pct": 6.6, "tp2Pct": 11.7, "tp3Pct": 19.4, "tpMode": "Percentage", "useAdx": true, "useRsi": true, "useTP1": false, "useTP2": true, "useTP3": false, "hullLen": 21, "tp1Mult": 5.3, "tp2Mult": 8.4, "tp3Mult": 5.6, "useHull": true, "beActAtr": 4.2, "beOffset": 0.32, "slAtrLen": 23, "tradeDir": "Both", "trailPct": 0.1, "useTrail": true, "adxThresh": 7, "bbwPctile": 81.5, "slAtrMult": 4.2, "tp1QtyPct": 45, "tp2QtyPct": 20, "tp3QtyPct": 40, "trailMode": "Percentage", "useLinReg": true, "volSmaLen": 75, "requireSqz": false, "useEmaBias": false, "useRsiExit": true, "adxRisingOk": true, "sqzLookback": 40, "trailActAtr": 0.4, "adxDropLevel": 29.3, "bbwPctileLen": 235, "beActivation": "Custom ATR Distance", "bodyRatioMin": 0.95, "cooldownBars": 1, "trailAtrMult": 4.6, "useVolFilter": true, "volSurgeMult": 0.7, "blockExtremes": true, "exitOnAdxDrop": false, "exitOnMomFlip": true, "exitOnHullFlip": false, "exitOnResqueeze": true, "trailActivation": "Custom ATR Distance", "useCandleFilter": false, "exitOnRsiExtreme": false};

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const result = await pool.query("SELECT time::bigint as time, open, high, low, close, volume FROM lab_candle_cache WHERE symbol = 'AVAX/USDT:USDT' AND timeframe = '1h' ORDER BY time ASC");
  const candles = result.rows.map((r: any) => ({ time: Number(r.time), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  console.log('Candles:', candles.length, new Date(candles[0].time).toISOString().slice(0,10), '->', new Date(candles[candles.length-1].time).toISOString().slice(0,10));
  
  const config = { initialCapital: 100, positionSize: 100, commission: 0.05 / 100 };
  const bt = runBacktest(candles, params, config, false);
  
  console.log('\n=== QL ENGINE (FIXED) ===');
  console.log('Net Profit:', bt.netProfitPercent.toFixed(2) + '%');
  console.log('Win Rate:', bt.winRatePercent.toFixed(2) + '%');
  console.log('Max DD:', bt.maxDrawdownPercent.toFixed(2) + '%');
  console.log('PF:', bt.profitFactor.toFixed(3));
  console.log('Trades:', bt.totalTrades);
  
  const er: Record<string, { c: number; p: number; b: number; w: number }> = {};
  for (const t of bt.trades) {
    if (!er[t.exitReason]) er[t.exitReason] = { c: 0, p: 0, b: 0, w: 0 };
    er[t.exitReason].c++; er[t.exitReason].p += t.pnlPercent; er[t.exitReason].b += t.barsHeld;
    if (t.pnlPercent >= 0) er[t.exitReason].w++;
  }
  console.log('\nExit reasons:');
  for (const [k, v] of Object.entries(er)) console.log(k + ':', v.c, ', avg bars:', (v.b/v.c).toFixed(1), ', avg PnL:', (v.p/v.c).toFixed(2) + '%', ', WR:', (v.w/v.c*100).toFixed(1) + '%');
  
  console.log('\nFirst 15 trades:');
  for (let i = 0; i < Math.min(15, bt.trades.length); i++) {
    const t = bt.trades[i];
    console.log('#' + (i+1), t.direction, t.entryTime.slice(0,16), '->', t.exitTime.slice(0,16), '(' + t.barsHeld + 'b)', t.entryPrice.toFixed(3), '->', t.exitPrice.toFixed(3), t.exitReason, t.pnlPercent + '%');
  }

  const mp: Record<string, { c: number; p: number }> = {};
  for (const t of bt.trades) { const d = new Date(t.exitTime); const k = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); if (!mp[k]) mp[k] = { c: 0, p: 0 }; mp[k].c++; mp[k].p += t.pnlPercent; }
  console.log('\nMonthly PnL:');
  for (const [k, v] of Object.entries(mp).sort()) console.log(k, ':', v.c, 'trades,', v.p.toFixed(2) + '%');
  
  await pool.end();
}
main().catch(console.error);
