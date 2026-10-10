/**
 * Read-only wire boundary pinned to @ellipsis-labs/rise 0.6.1.
 * No runtime SDK, Solana Kit, web3 signer or transaction type crosses this module.
 * Amount formula source: ts/src/orderPackets.ts at the pinned source revision.
 * This pin documents compatibility, not an installed dependency or on-chain attestation.
 */
export const PHOENIX_SDK_PIN = Object.freeze({
  package: '@ellipsis-labs/rise',
  version: '0.6.1',
  sourceCommitHash: '573b773a6a7b38f941aed3a6f0602bc648346114',
});

export const PHOENIX_PUBLIC_API = 'https://perp-api.phoenix.trade';
export const PHOENIX_PUBLIC_ADDRESSES = Object.freeze({
  program: 'EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih',
  emberProgram: 'EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  collateralMint: 'PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A',
});

export interface PhoenixLotParams { tickSize: string; baseLotsDecimals: number }

function decimal(value: string): [bigint, bigint] {
  if (value.length > 80 || !/^\d+(\.\d+)?$/.test(value)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}

function scale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || Math.abs(decimals) > 18) throw new Error('Invalid lot decimals');
  return 10n ** BigInt(Math.abs(decimals));
}

/** Floors, including negative baseLotsDecimals. Accept strings to avoid float loss. */
export function phoenixBaseUnitsToLots(amount: string, decimals: number): bigint {
  const [n, d] = decimal(amount);
  const s = scale(decimals);
  return decimals >= 0 ? n * s / d : n / (d * s);
}

/** Rise first floors USD to micro-USD, then converts to ticks. */
export function phoenixPriceUsdToTicks(price: string, params: PhoenixLotParams): bigint {
  const [n, d] = decimal(price);
  if (!/^\d{1,30}$/.test(params.tickSize) || BigInt(params.tickSize) <= 0n) throw new Error('Invalid tick size');
  const micros = n * 1_000_000n / d;
  const tick = BigInt(params.tickSize);
  const s = scale(params.baseLotsDecimals);
  return params.baseLotsDecimals >= 0 ? micros / (tick * s) : micros * s / tick;
}

export function phoenixLotSize(params: PhoenixLotParams): string {
  scale(params.baseLotsDecimals);
  return params.baseLotsDecimals > 0
    ? `0.${'0'.repeat(params.baseLotsDecimals - 1)}1`
    : (10n ** BigInt(-params.baseLotsDecimals)).toString();
}

export function phoenixTickSizeUsd(params: PhoenixLotParams): string {
  scale(params.baseLotsDecimals);
  if (!/^\d{1,30}$/.test(params.tickSize) || BigInt(params.tickSize) <= 0n) throw new Error('Invalid tick size');
  const exponent = params.baseLotsDecimals - 6;
  if (exponent >= 0) return (BigInt(params.tickSize) * 10n ** BigInt(exponent)).toString();
  const digits = BigInt(params.tickSize).toString().padStart(-exponent + 1, '0');
  return `${digits.slice(0, exponent)}.${digits.slice(exponent)}`.replace(/0+$/, '').replace(/\.$/, '');
}
