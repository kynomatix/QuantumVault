import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Trade retry fee-rate admission choke point', () => {
  const source = readFileSync(resolve(process.cwd(), 'server/trade-retry-service.ts'), 'utf8');
  const wrapperStart = source.indexOf('async function driftExecutePerpOrder(');
  const wrapperEnd = source.indexOf('\nasync function driftClosePerpPosition(', wrapperStart);
  const wrapper = source.slice(wrapperStart, wrapperEnd);

  it('resolves the signing key before the fresh fee-authorized OPEN send', () => {
    const signing = wrapper.indexOf('resolveAgentKeypair');
    const feeGate = wrapper.indexOf('placeMarketOrderWithFeeAuthority');

    expect(wrapperStart).toBeGreaterThanOrEqual(0);
    expect(signing).toBeGreaterThanOrEqual(0);
    expect(feeGate).toBeGreaterThan(signing);
    expect(wrapper).toContain('? await adapter.placeMarketOrder(orderParams)');
    expect(wrapper).toContain(': await placeMarketOrderWithFeeAuthority(adapter, orderParams)');
  });

  it('keeps automatic OPEN retries on the guarded wrapper and closes on their old path', () => {
    const processStart = source.indexOf('async function processRetryJob(');
    const processEnd = source.indexOf('\nasync function processQueue(', processStart);
    const process = source.slice(processStart, processEnd);
    const openBranch = process.indexOf('// For OPEN trades (long/short)');
    const closeBranch = process.slice(
      process.indexOf("if (job.side === 'close')"),
      openBranch,
    );

    expect(process).toContain('result = await driftExecutePerpOrder(');
    expect(openBranch).toBeGreaterThanOrEqual(0);
    expect(closeBranch).toContain('result = await driftClosePerpPosition(');
    expect(closeBranch).not.toContain('placeMarketOrderWithFeeAuthority');
  });

  it('retains the retry close-accounting constant and expressions', () => {
    expect(source).toContain('const DEFAULT_EXCHANGE_FEE_RATE = 0.0004;');
    expect(source).toContain(
      'const fee = originalTrade?.fee ? parseFloat(originalTrade.fee) : job.size * exitPrice * getExchangeFeeRate();',
    );
    expect(source).toContain(
      'const closeFee = closeTrade.fee ? parseFloat(closeTrade.fee) : closeSize * closePrice * getExchangeFeeRate();',
    );
    expect(source).toContain("job.side === 'close'");
    expect(source).toContain('(result.actualFee || notional * getExchangeFeeRate())');
  });

  it('reuses the admitted quote for the OPEN estimate while retaining prior exact-fee precedence', () => {
    expect(source).toContain(
      '(result.actualFee || notional * result.admissionFeeQuote!.effectiveRate)',
    );
  });
});
