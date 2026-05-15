import {
  NetworkId,
  PortfolioElement,
  PortfolioElementType,
  PortfolioElementMultiple,
  PortfolioElementLeverage,
  PortfolioAssetToken,
  PortfolioAssetType,
  PortfolioLeveragePosition,
  TokenPrice,
  solanaNativeAddress,
} from '@sonarwatch/portfolio-core';
import { Fetcher, FetcherExecutor } from '../../Fetcher';
import { Cache } from '../../Cache';
import { platformId, PORTFOLIO_ENDPOINT } from './constants';
import { PortfolioResponse, PortfolioProtocolBlock } from './types';

const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FETCH_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function buildAgentWalletElement(
  block: PortfolioProtocolBlock,
  owner: string,
  usdcPrice: TokenPrice | null,
  solPrice: TokenPrice | null,
): PortfolioElementMultiple | null {
  const usdc = block.balance.usdc ?? 0;
  const sol = block.balance.sol ?? 0;
  if (usdc <= 0 && sol <= 0) return null;

  const assets: PortfolioAssetToken[] = [];
  if (usdc > 0) {
    assets.push({
      networkId: NetworkId.solana,
      type: PortfolioAssetType.token,
      value: usdcPrice ? usdc * usdcPrice.price : null,
      attributes: {},
      data: {
        address: SOLANA_USDC_MINT,
        amount: usdc,
        price: usdcPrice?.price ?? null,
      },
    });
  }
  if (sol > 0) {
    assets.push({
      networkId: NetworkId.solana,
      type: PortfolioAssetType.token,
      value: solPrice ? sol * solPrice.price : null,
      attributes: {},
      data: {
        address: solanaNativeAddress,
        amount: sol,
        price: solPrice?.price ?? null,
      },
    });
  }

  return {
    type: PortfolioElementType.multiple,
    networkId: NetworkId.solana,
    platformId,
    label: 'Wallet',
    name: 'Agent Wallet (idle)',
    value: assets.reduce((s, a) => s + (a.value ?? 0), 0) || null,
    data: { assets },
  };
}

function buildLeverageElement(
  block: PortfolioProtocolBlock,
  usdcPrice: TokenPrice | null,
): PortfolioElementLeverage | null {
  if (block.status !== 'ok' || block.positions.length === 0) {
    // Still surface the deposited collateral as a "deposit" element so the
    // user sees their funds even when there are no open positions.
    const equity = block.balance.equity ?? 0;
    if (equity <= 0) return null;
  }

  const collateralUsd = block.balance.equity ?? 0;

  const positions: PortfolioLeveragePosition[] = block.positions.map((p) => ({
    address: p.symbol,
    side: p.side,
    size: p.size,
    sizeValue: p.size * p.entryPrice,
    leverage: p.leverage,
    liquidationPrice: null,
    markPrice: p.entryPrice,
    entryPrice: p.entryPrice,
    pnlValue: 0,
  }));

  return {
    type: PortfolioElementType.leverage,
    networkId: NetworkId.solana,
    platformId,
    label: 'Leverage',
    name: `${block.id} perps`,
    value: collateralUsd || null,
    data: {
      address: undefined,
      positionsCount: positions.length,
      value: collateralUsd,
      pnl: 0,
      collateralValue: collateralUsd,
      positions,
    },
  };
}

const executor: FetcherExecutor = async (
  owner: string,
  cache: Cache,
): Promise<PortfolioElement[]> => {
  const url = `${PORTFOLIO_ENDPOINT}?wallet=${encodeURIComponent(owner)}`;
  let payload: PortfolioResponse;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      // 200 is the only success path. Anything else (404/429/5xx) means the
      // user simply has no QuantumVault portfolio to show.
      return [];
    }
    payload = (await res.json()) as PortfolioResponse;
  } catch {
    return [];
  }

  if (!payload || !Array.isArray(payload.protocols)) return [];

  const usdcPrice = await cache.getTokenPrice(SOLANA_USDC_MINT, NetworkId.solana);
  const solPrice = await cache.getTokenPrice(solanaNativeAddress, NetworkId.solana);

  const elements: PortfolioElement[] = [];
  for (const block of payload.protocols) {
    if (block.id === 'agent_wallet') {
      const el = buildAgentWalletElement(block, owner, usdcPrice ?? null, solPrice ?? null);
      if (el) elements.push(el);
      continue;
    }
    // Per-protocol error blocks are silently skipped — partial success.
    if (block.status !== 'ok' && (block.balance?.equity ?? 0) <= 0) continue;
    const el = buildLeverageElement(block, usdcPrice ?? null);
    if (el) elements.push(el);
  }

  return elements;
};

export const positionsFetcher: Fetcher = {
  id: `${platformId}-positions`,
  networkId: NetworkId.solana,
  executor,
};

export default positionsFetcher;
