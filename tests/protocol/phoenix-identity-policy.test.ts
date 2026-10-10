import { describe, expect, it, vi } from 'vitest';
import { entropyToMnemonic } from 'bip39';
import { getTableColumns } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
vi.mock('../../server/storage', () => ({ storage: {} }));
vi.mock('../../server/error-log', () => ({ recordCriticalError: vi.fn() }));
import { computeBotPolicyHmac, verifyBotPolicyHmac, deriveBotKeypairFromAgentSeed } from '../../server/session-v3';
import { computePolicyHmac, deriveSubkey, SUBKEY_PURPOSES } from '../../server/crypto-v3';
import { assertPhoenixIdentity, derivePhoenixIdentity, phoenixIdentityColumns } from '../../server/protocol/phoenix/identity';
import { tradingBots, wallets } from '../../shared/schema';

// Synthetic recovery material generated in memory; no keys or wallet files read.
const mnemonic = Buffer.from(entropyToMnemonic(Buffer.alloc(32, 7)));
const authority = (index: number) => deriveBotKeypairFromAgentSeed(mnemonic, index, 1).publicKey.toBase58();
const umk = Buffer.alloc(32, 9);
const bot = () => ({ id: 'EXAMPLE-bot', walletAddress: 'EXAMPLE-owner', activeProtocol: 'phoenix',
  derivationIndex: 1, ...phoenixIdentityColumns(derivePhoenixIdentity(authority(1))),
  market: 'SOL', leverage: 2, maxPositionSize: '100' });

describe('Phoenix persisted identity and policy', () => {
  it('recovers the same distinct signing authority and trader PDA from synthetic recovery material', () => {
    const identity = derivePhoenixIdentity(authority(1));
    expect(derivePhoenixIdentity(authority(1))).toEqual(identity);
    expect(derivePhoenixIdentity(authority(2))).not.toEqual(identity);
    expect(identity.traderAccountAddress).not.toBe(identity.authorityWalletAddress);
    expect(PublicKey.isOnCurve(new PublicKey(identity.traderAccountAddress).toBytes())).toBe(false);
    // Independently express Rise 0.6.1's PDA seeds from the pinned public source.
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from('trader'),
      new PublicKey(authority(1)).toBuffer(), Uint8Array.of(0), Uint8Array.of(0)], new PublicKey(identity.programAddress));
    expect(identity.traderAccountAddress).toBe(expected.toBase58());
    expect(() => derivePhoenixIdentity(identity.traderAccountAddress)).toThrow();
  });

  it.each(['venue', 'network', 'programAddress', 'authorityWalletAddress', 'traderAccountAddress',
    'portfolioIndex', 'subaccountIndex', 'derivationVersion'] as const)('rejects identity mismatch: %s', field => {
    const identity = derivePhoenixIdentity(authority(1));
    expect(() => assertPhoenixIdentity({ ...identity, [field]: typeof identity[field] === 'number' ? 1 + Number(identity[field]) : 'EXAMPLE' })).toThrow();
  });

  it('preserves exact legacy policy bytes and rejects cross-version replay', () => {
    const legacy = { market: 'SOL', leverage: 2, maxPositionSize: '100' };
    const policyKey = deriveSubkey(umk, SUBKEY_PURPOSES.POLICY_HMAC);
    const legacyHash = computePolicyHmac(legacy, policyKey);
    expect(computeBotPolicyHmac(umk, { ...legacy, activeProtocol: 'pacifica' })).toBe(legacyHash);
    expect(verifyBotPolicyHmac(umk, bot(), legacyHash)).toBe(false);
    const phoenixHash = computeBotPolicyHmac(umk, bot());
    expect(verifyBotPolicyHmac(umk, bot(), phoenixHash)).toBe(true);
    expect(verifyBotPolicyHmac(umk, legacy, phoenixHash)).toBe(false);
    policyKey.fill(0);
  });

  it.each(['id', 'walletAddress', 'activeProtocol', 'derivationIndex', 'derivationPathVersion',
    'protocolSubaccountId', 'phoenixAuthorityWallet', 'phoenixTraderAccount', 'phoenixNetwork',
    'phoenixProgramAddress', 'phoenixPortfolioIndex', 'phoenixSubaccountIndex', 'market', 'leverage', 'maxPositionSize'] as const)(
    'rejects signed policy tampering: %s', field => {
      const original = bot();
      const policyHash = computeBotPolicyHmac(umk, original);
      expect(verifyBotPolicyHmac(umk, { ...original, [field]: typeof original[field] === 'number' ? Number(original[field]) + 1 : 'EXAMPLE-other' }, policyHash)).toBe(false);
    });

  it('rejects absent and malformed Phoenix authorization', () => {
    for (const policyHash of ['', 'EXAMPLE', '0'.repeat(64) + '\n']) expect(verifyBotPolicyHmac(umk, bot(), policyHash)).toBe(false);
    expect(() => computeBotPolicyHmac(umk, { ...bot(), activeProtocol: 'pacifica' })).toThrow();
  });

  it('declares identity on bots only, and still rejects Phoenix user creation', () => {
    expect(getTableColumns(tradingBots).phoenixAuthorityWallet.name).toBe('phoenix_authority_wallet');
    expect(getTableColumns(wallets)).not.toHaveProperty('phoenixAuthorityWallet');
    const routes = readFileSync(new URL('../../server/routes.ts', import.meta.url), 'utf8');
    expect(routes).toContain("requestedProtocol !== 'pacifica' && requestedProtocol !== 'flash'");
    expect(routes.match(/bot.policyHmac \|\| bot.activeProtocol === 'phoenix'/g)).toHaveLength(2);
  });
});
