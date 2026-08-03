import type { ProtocolAdapter } from './protocol/adapter';

export const SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE = 'signal_bot_market_leverage_cap_unavailable';
export const SIGNAL_BOT_LEVERAGE_CAP_EXCEEDED = 'signal_bot_market_leverage_cap_exceeded';
export const SIGNAL_BOT_LEVERAGE_INVALID = 'signal_bot_configured_leverage_invalid';

export type SignalBotLeverageAdmission =
  | {
      allowed: true;
      configuredLeverage: number;
      marketMaxLeverage: number | null;
    }
  | {
      allowed: false;
      code:
        | typeof SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE
        | typeof SIGNAL_BOT_LEVERAGE_CAP_EXCEEDED
        | typeof SIGNAL_BOT_LEVERAGE_INVALID;
      error: string;
    };

function normalizeInternalMarket(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return upper.endsWith('-PERP') ? upper : `${upper}-PERP`;
}

function reject(
  code: Exclude<SignalBotLeverageAdmission, { allowed: true }>['code'],
  detail: string,
): SignalBotLeverageAdmission {
  return { allowed: false, code, error: `${code}: ${detail}` };
}

/**
 * Signal-Bot-only Pacifica entry admission. This performs an unsigned market
 * metadata read and never clamps the configured leverage. Callers must invoke
 * it before resolving signing material for a non-reduce-only entry.
 */
export async function checkSignalBotLeverageAdmission(args: {
  adapter: ProtocolAdapter;
  market: string;
  configuredLeverage: number | undefined;
}): Promise<SignalBotLeverageAdmission> {
  const configuredLeverage = Number(args.configuredLeverage);

  // Other protocols retain their existing behavior. The two product-owned
  // choke points call this helper so protocol isolation is explicit and tested.
  if (args.adapter.protocolName !== 'pacifica') {
    return { allowed: true, configuredLeverage, marketMaxLeverage: null };
  }

  const normalizedMarket = normalizeInternalMarket(args.market);
  if (!Number.isFinite(configuredLeverage) || configuredLeverage <= 0) {
    return reject(
      SIGNAL_BOT_LEVERAGE_INVALID,
      `configured leverage is unavailable or invalid for ${normalizedMarket}`,
    );
  }

  let markets: Awaited<ReturnType<ProtocolAdapter['getMarkets']>>;
  try {
    markets = await args.adapter.getMarkets();
  } catch {
    return reject(
      SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE,
      `Pacifica published leverage cap is unavailable or invalid for ${normalizedMarket}`,
    );
  }

  const matches = markets.filter(
    (market) => normalizeInternalMarket(market.internalSymbol) === normalizedMarket,
  );
  if (matches.length !== 1) {
    return reject(
      SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE,
      `Pacifica published leverage cap is unavailable or invalid for ${normalizedMarket}`,
    );
  }

  const match = matches[0];
  const marketMaxLeverage = match.maxLeverage;
  if (
    match.maxLeverageSource !== 'venue'
    || !Number.isFinite(marketMaxLeverage)
    || marketMaxLeverage <= 0
  ) {
    return reject(
      SIGNAL_BOT_LEVERAGE_CAP_UNAVAILABLE,
      `Pacifica published leverage cap is unavailable or invalid for ${normalizedMarket}`,
    );
  }

  if (configuredLeverage > marketMaxLeverage) {
    return reject(
      SIGNAL_BOT_LEVERAGE_CAP_EXCEEDED,
      `configured ${configuredLeverage}x exceeds Pacifica ${normalizedMarket} maximum ${marketMaxLeverage}x`,
    );
  }

  return { allowed: true, configuredLeverage, marketMaxLeverage };
}
