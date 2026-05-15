import { Platform } from '@sonarwatch/portfolio-core';

export const platformId = 'quantumvault';

export const QUANTUMVAULT_API_BASE =
  process.env.QUANTUMVAULT_API_BASE || 'https://myquantumvault.com';

export const PORTFOLIO_ENDPOINT = `${QUANTUMVAULT_API_BASE}/api/public/portfolio`;

export const platform: Platform = {
  id: platformId,
  name: 'QuantumVault',
  image: 'https://myquantumvault.com/icon.png',
  defi: true,
  website: 'https://myquantumvault.com',
  description:
    'Solana-based bot trading platform. Deploy and manage perpetual ' +
    'futures trading bots across multiple protocols (Pacifica, Drift) ' +
    'with automated trade execution via TradingView webhooks.',
  networkId: 'solana',
};
