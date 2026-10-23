import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';
import { classifyCloseFeeEvidence } from '../../server/trading/signal-bot-close-integrity';

describe('trade retry reduce-only close with UNKNOWN mark', () => {
  it.each(['bid', 'ask'])('suspends an ambiguous %s close retry even when both price sources fail', async (side) => {
    const adapter = new PacificaAdapter({ baseUrl: 'https://test-pacifica.invalid' });
    (adapter as any).initialized = true;
    (adapter as any).registry = new SymbolRegistry([{ internal: 'BTC-PERP', protocol: 'BTC', aliases: [] }]);
    vi.spyOn(adapter as any, 'get').mockResolvedValue([
      { symbol: 'BTC', amount: '2', entry_price: '100', side },
    ]);
    vi.spyOn(adapter, 'getAllPrices').mockRejectedValue(new Error('bulk unavailable'));
    const placeMarketOrder = vi.spyOn(adapter, 'placeMarketOrder').mockResolvedValue({
      success: true, status: 'filled', orderId: 'EXAMPLE-close', fillPrice: 99,
    });

    // A3/A5 suspend automatic ambiguous-close resends until durable intent exists.
    // Exercise the production retry helper; a usable position cannot authorize
    // replaying a close whose original submission may already have landed.
    const source = readFileSync('server/trade-retry-service.ts', 'utf8');
    const start = source.indexOf('async function driftClosePerpPosition(');
    const end = source.indexOf('async function driftGetPerpPositions(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const js = transpileModule(source.slice(start, end), {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText;
    const close = new Function('resolveAgentKeypair', '_lookupMainWallet', '_subIdStr',
      'getDefaultAdapter', 'resolveFeeRateQuote', 'classifyCloseFeeEvidence',
      `${js}\nreturn driftClosePerpPosition;`)(
      () => ({ publicKey: { toBase58: () => 'EXAMPLE-agent' }, secretKey: new Uint8Array(64) }),
      async () => 'EXAMPLE-wallet', (id: number) => id > 0 ? String(id) : undefined,
      () => adapter, async () => null, classifyCloseFeeEvidence,
    );
    await expect(close(new Uint8Array(), 'BTC-PERP', 3))
      .rejects.toThrow('close_resend_suspended_until_durable_intent');
    expect(placeMarketOrder).not.toHaveBeenCalled();
    expect(adapter.getAllPrices).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
