// Mirrors the response contract returned by QuantumVault's
// GET /api/public/portfolio endpoint. Source of truth lives in
// server/public-portfolio.ts in the QuantumVault repo.

export type ProtocolStatus = 'ok' | 'partial' | 'error' | 'circuit_open' | 'unavailable';

export interface PortfolioPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
}

export interface PortfolioProtocolBlock {
  id: string; // 'agent_wallet' | 'pacifica' | 'drift' | ...
  status: ProtocolStatus;
  error?: string;
  balance: Record<string, number>;
  positions: PortfolioPosition[];
}

export interface PortfolioResponse {
  asOf: number;
  wallet: string;
  protocols: PortfolioProtocolBlock[];
}
