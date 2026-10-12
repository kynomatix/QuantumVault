import { AsyncLocalStorage } from 'node:async_hooks';

/** Scoped only by the Phoenix server composition; legacy callers have no context. */
export interface PhoenixLendContext {
  freshDebt(): Promise<bigint>;
  leg<T>(kind: string, params: Record<string, any>, execute: (params: any) => Promise<T>): Promise<T>;
}
const context = new AsyncLocalStorage<PhoenixLendContext>();
export const phoenixLendContext = () => context.getStore();
export const withPhoenixLendContext = <T>(scope: PhoenixLendContext, work: () => Promise<T>) => context.run(scope, work);
export function phoenixLendLeg<F extends (params: any) => Promise<any>>(kind: string, execute: F): F {
  return ((params: Parameters<F>[0]) => {
    const scope = context.getStore();
    return scope ? scope.leg(kind, params, execute) : execute(params);
  }) as F;
}

/** Never persist keys, callbacks or arbitrary API objects in the durable journal. */
export function lendLegTerms(kind: string, p: Record<string, any>) {
  const terms: Record<string, string | number | boolean | null> = { kind };
  for (const key of ['walletAddress','tradingBotId','borrowPositionId','accountBorrowPositionId','venuePositionId',
    'agentPublicKey','botPublicKey','accountPublicKey','toWalletAddress','mint','collateralMint','sourceMint',
    'amount','amountRaw','collateralRaw','deliverToUserWallet','collateralAmountRaw','borrowAmountRaw','requestedDebtRaw','targetFinalDebtRaw','targetLtv',
    'deliverToUser','inputMint','outputMint','slippageBps']) {
    if (p[key] !== undefined) {
      const value = p[key];
      if (!['string','number','boolean','bigint'].includes(typeof value) && value !== null) throw new Error('Invalid lender leg terms');
      terms[key] = typeof value === 'bigint' ? value.toString() : value;
    }
  }
  return terms;
}
