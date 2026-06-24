import { describe, it, expect } from 'vitest';
import type { AdapterCapabilities } from '../../server/protocol/protocol-types.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { DriftAdapter } from '../../server/protocol/drift/drift-adapter.js';
import { FlashAdapter } from '../../server/protocol/flash/flash-adapter.js';

// Borrow/carry capability-gate contract (Vault borrow engine, Phase A).
//
// The borrow/carry logic gates on these EXPLICIT flags — never inferred from
// walletDerivation or branched on protocol name. The logical invariants below
// only "bite" where the antecedent is true (e.g. Flash), so they catch a future
// wrong assignment such as flipping supportsCarryOnClose on a subaccount venue.
function assertBorrowGateInvariants(caps: AdapterCapabilities) {
  expect(['per_bot_wallet', 'exchange_subaccount']).toContain(caps.custodyModel);
  expect(['negligible', 'fixed_fee_high_min', 'on_chain_only']).toContain(
    caps.roundTripWithdrawalEconomics,
  );
  // Per-bot debt requires the bot to physically own a pledgeable wallet.
  if (caps.supportsPerBotExternalDebt) {
    expect(caps.custodyModel).toBe('per_bot_wallet');
  }
  // Carry-on-close requires per-bot debt to exist...
  if (caps.supportsCarryOnClose) {
    expect(caps.supportsPerBotExternalDebt).toBe(true);
    // ...and is only economical when round-trips are not fee/min-gated.
    expect(caps.roundTripWithdrawalEconomics).not.toBe('fixed_fee_high_min');
  }
}

describe('borrow/carry capability gates (Vault borrow engine, Phase A)', () => {
  it('Flash: per-bot wallet → full per-bot debt + carry, cheap round-trips', () => {
    const caps = new FlashAdapter().getCapabilities();
    expect(caps.custodyModel).toBe('per_bot_wallet');
    expect(caps.supportsPerBotExternalDebt).toBe(true);
    expect(caps.supportsCarryOnClose).toBe(true);
    expect(caps.roundTripWithdrawalEconomics).toBe('negligible');
    assertBorrowGateInvariants(caps);
  });

  it('Pacifica: exchange subaccount → account-level borrow only (no per-bot debt/carry)', () => {
    const caps = new PacificaAdapter({
      baseUrl: 'https://api.pacifica.fi/api/v1',
      wsUrl: 'wss://ws.pacifica.fi/ws',
    }).getCapabilities();
    expect(caps.custodyModel).toBe('exchange_subaccount');
    expect(caps.supportsPerBotExternalDebt).toBe(false);
    expect(caps.supportsCarryOnClose).toBe(false);
    expect(caps.roundTripWithdrawalEconomics).toBe('fixed_fee_high_min');
    assertBorrowGateInvariants(caps);
  });

  it('Drift: legacy subaccount → account-level borrow only (no per-bot debt/carry)', () => {
    const caps = new DriftAdapter().getCapabilities();
    expect(caps.custodyModel).toBe('exchange_subaccount');
    expect(caps.supportsPerBotExternalDebt).toBe(false);
    expect(caps.supportsCarryOnClose).toBe(false);
    expect(caps.roundTripWithdrawalEconomics).toBe('on_chain_only');
    assertBorrowGateInvariants(caps);
  });
});
