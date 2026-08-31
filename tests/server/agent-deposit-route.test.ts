import express from 'express';
import { createServer, type Server } from 'node:http';
import { Keypair } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_WALLET = Keypair.generate().publicKey.toBase58();
const TEST_AGENT = Keypair.generate().publicKey.toBase58();

const routeMocks = vi.hoisted(() => ({
  buildTransferToAgentTransaction: vi.fn(),
}));
const storageTarget = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

vi.mock('../../server/storage', () => {
  const storage = new Proxy(storageTarget, {
    get: (target, property: string | symbol) => {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return (target[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {
    static canonicalCloseFillId() { return 'test-close-fill'; }
  }
  return { storage, DatabaseStorage };
});

vi.mock('../../server/session', () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.session = { walletAddress: TEST_WALLET };
    next();
  },
}));

vi.mock('../../server/db', () => ({
  db: {},
  isConnectionClassError: vi.fn(() => false),
}));

vi.mock('../../server/analytics-indexer', () => ({
  startAnalyticsIndexer: vi.fn(),
  getMetrics: vi.fn(),
  calculateAndStoreMetrics: vi.fn(),
}));

vi.mock('../../server/session-v3', () => ({
  createSigningNonce: vi.fn(),
  verifySignatureAndConsumeNonce: vi.fn(),
  initializeWalletSecurity: vi.fn(),
  getSession: vi.fn(),
  getSessionByWalletAddress: vi.fn(),
  invalidateSession: vi.fn(),
  cleanupExpiredNonces: vi.fn(),
  revealMnemonic: vi.fn(),
  enableExecution: vi.fn(),
  revokeExecution: vi.fn(),
  emergencyStopWallet: vi.fn(),
  getUmkForWebhook: vi.fn(),
  healExecutionUmkFromStorage: vi.fn(),
  restoreWalletSecurityFromStorage: vi.fn(),
  computeBotPolicyHmac: vi.fn(),
  verifyBotPolicyHmac: vi.fn(),
  decryptAgentKeyStrict: vi.fn(),
  decryptBotSubaccountKey: vi.fn(),
  repairStaleV3AgentKeyFromLegacy: vi.fn(),
  generateAgentWalletWithMnemonic: vi.fn(),
  encryptAndStoreMnemonic: vi.fn(),
  encryptMnemonicForStorage: vi.fn(),
  encryptAgentKeyV3: vi.fn(),
  encryptBotSubaccountKeyV3: vi.fn(),
  encryptPooledSubaccountKeyV3: vi.fn(),
  rebindRetainedKeyToBotUuidV3: vi.fn(),
  rebindSubaccountKeyToPooledV3: vi.fn(),
  decryptMnemonic: vi.fn(),
  deriveBotKeypairFromAgentSeed: vi.fn(),
  BOT_DERIVATION_PATH_VERSION: 1,
}));

vi.mock('../../server/protocol/adapter-registry', () => ({
  getAdapter: vi.fn(() => ({})),
  getDefaultAdapter: vi.fn(() => ({})),
  getAdapterForBot: vi.fn(() => ({})),
}));

vi.mock('../../server/agent-wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/agent-wallet')>();
  return {
    ...actual,
    buildTransferToAgentTransaction: routeMocks.buildTransferToAgentTransaction,
  };
});

import { AgentDepositPreflightError } from '../../server/agent-wallet';
import { registerRoutes } from '../../server/routes';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = await registerRoutes(createServer(app), app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no ephemeral test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!server) return;
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  storageTarget.getWallet = vi.fn(async () => ({
    walletAddress: TEST_WALLET,
    agentPublicKey: TEST_AGENT,
  }));
});

async function deposit(amount = 10) {
  const response = await fetch(`${baseUrl}/api/agent/deposit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

describe('POST /api/agent/deposit preflight mapping', () => {
  it.each([
    {
      code: 'source_usdc_account_missing',
      status: 422,
      message: 'The connected wallet does not have a USDC account.',
    },
    {
      code: 'insufficient_source_usdc',
      status: 422,
      message: 'The connected wallet does not hold enough USDC.',
    },
    {
      code: 'insufficient_fee_sol',
      status: 422,
      message: 'The connected wallet does not hold enough SOL.',
    },
    {
      code: 'simulation_rejected',
      status: 422,
      message: 'The deposit transaction could not be simulated safely.',
    },
    {
      code: 'preflight_unavailable',
      status: 503,
      message: 'The deposit could not be verified safely right now.',
    },
  ] as const)('maps $code to its bounded refusal contract', async ({ code, status, message }) => {
    routeMocks.buildTransferToAgentTransaction.mockRejectedValueOnce(
      new AgentDepositPreflightError(
        code,
        status,
        message,
        { cause: new Error('private-rpc-detail') },
      ),
    );

    const response = await deposit();

    expect(response).toEqual({
      status,
      body: {
        error: message,
        code: `agent_deposit_${code}`,
      },
    });
    expect(response.body).not.toHaveProperty('transaction');
    expect(JSON.stringify(response.body)).not.toContain('private-rpc-detail');
  });

  it('preserves generic 500 behavior for an unexpected builder failure', async () => {
    routeMocks.buildTransferToAgentTransaction.mockRejectedValueOnce(new Error('programmer detail'));

    const response = await deposit();

    expect(response).toEqual({ status: 500, body: { error: 'Internal server error' } });
  });

  it('returns transaction bytes only after a successful builder preflight', async () => {
    routeMocks.buildTransferToAgentTransaction.mockResolvedValueOnce({
      transaction: 'safe-base64',
      blockhash: 'safe-blockhash',
      lastValidBlockHeight: 123,
      message: 'Deposit 10 USDC to bot wallet',
    });

    const response = await deposit();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ transaction: 'safe-base64', blockhash: 'safe-blockhash' });
    expect(routeMocks.buildTransferToAgentTransaction).toHaveBeenCalledWith(TEST_WALLET, TEST_AGENT, 10);
  });
});
