import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import type { PhoenixRegistrationIO } from './provisioner';
import type { PhoenixRegistrationPin } from './registration';
import { assertPhoenixIdentity } from './identity';

/** Account space must be reviewed against the deployed program before a canary.
 * Do not infer it from an API response or ship a guessed rent quote.
 */
export interface PhoenixDeploymentPin extends PhoenixRegistrationPin {
  traderBytesByMaxPositions: Readonly<Record<number, number>>;
}
export class PhoenixActivationRefusal extends Error {
  constructor(readonly code: 'denied' | 'gated') { super(`Phoenix activation ${code}`); }
}
type RegistrationRpc = Pick<Connection, 'getLatestBlockhash' | 'getMinimumBalanceForRentExemption'
  | 'getFeeForMessage' | 'getBalance' | 'getAccountInfo' | 'simulateTransaction' | 'getSignatureStatuses'>;
const origin = 'https://perp-api.phoenix.trade';
const traderDiscriminator = createHash('sha256').update('account:trader').digest().subarray(0, 8);

// Rise 0.6.1 Trader header: discriminant, 16-byte sequence, key, authority,
// 16-byte state; portfolio/subaccount at 154/155. No private material decoded.
export function validateRegisteredTrader(data: Buffer, identity: PhoenixTraderIdentity) {
  assertPhoenixIdentity(identity);
  if (data.length < 224 || !data.subarray(0, 8).equals(traderDiscriminator)
    || new PublicKey(data.subarray(24, 56)).toBase58() !== identity.traderAccountAddress
    || new PublicKey(data.subarray(56, 88)).toBase58() !== identity.authorityWalletAddress
    || (data.readUInt32LE(96) & 63) !== 63 || data[154] !== 0 || data[155] !== 0) {
    throw new Error('Phoenix trader not activated for this identity');
  }
}

/** Fixed current API endpoints only. The send endpoint supplies the onboarder
 * signature AND broadcasts. There is no RPC send, API retry, referral activation,
 * transfer, deposit or unpark in this adapter.
 */
export function createPhoenixRegistrationIO(rpc: RegistrationRpc, deployment: PhoenixDeploymentPin,
  withSigner: PhoenixRegistrationIO['withSigner'], fetcher: typeof fetch = fetch): PhoenixRegistrationIO {
  const pin = structuredClone(deployment);
  async function api(path: string, body?: object): Promise<any> {
    const response = await fetcher(`${origin}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401 || response.status === 403) throw new PhoenixActivationRefusal('denied');
    if (!response.ok) throw new Error('Phoenix registration API unavailable');
    const text = await response.text();
    if (text.length > 65536) throw new Error('Phoenix registration response too large');
    return JSON.parse(text);
  }
  function validateMetadata(value: any, identity: PhoenixTraderIdentity, maxPositions: number) {
    assertPhoenixIdentity(identity);
    if (!value || value.traderPda !== identity.traderAccountAddress || value.traderOnboarder !== pin.onboarder
      || value.txFeePayer !== identity.authorityWalletAddress || value.maxPositions !== maxPositions
      || value.includeRegisterTrader !== true) throw new Error('Phoenix registration metadata mismatch');
  }
  const fields = (identity: PhoenixTraderIdentity, maxPositions: number) => ({ traderAuthority: identity.authorityWalletAddress,
    txFeePayer: identity.authorityWalletAddress, maxPositions });
  return {
    async eligibility() {
      try {
        const status = await api('/v1/view/exchange/status');
        if (status.gated === true) return 'gated';
        return status.gated === false && status.active === true && status.runningState === 'active' ? 'eligible' : 'unknown';
      } catch (error) { return error instanceof PhoenixActivationRefusal ? error.code : 'unknown'; }
    },
    async build(identity, maxPositions) {
      const response = await api('/v1/exchange/build-register-ixs', fields(identity, maxPositions));
      validateMetadata(response, identity, maxPositions);
      return response.instructions;
    },
    lifetime: () => rpc.getLatestBlockhash('finalized'),
    async estimate(transaction, identity) {
      assertPhoenixIdentity(identity);
      const maxPositions = transaction.instructions[0]?.data.readUInt32LE(8);
      const bytes = pin.traderBytesByMaxPositions[maxPositions];
      if (!Number.isSafeInteger(bytes) || bytes < 224 || bytes > 16384) throw new Error('Unreviewed Phoenix account size');
      const payer = new PublicKey(identity.authorityWalletAddress);
      const trader = new PublicKey(identity.traderAccountAddress);
      const [rent, fee, balance, existing] = await Promise.all([
        rpc.getMinimumBalanceForRentExemption(bytes, 'finalized'), rpc.getFeeForMessage(transaction.compileMessage(), 'finalized'),
        rpc.getBalance(payer, 'finalized'), rpc.getAccountInfo(trader, 'finalized'),
      ]);
      if (existing || ![rent, fee.value, balance].every(value => Number.isSafeInteger(value) && value! >= 0)
        || rent <= 0 || fee.value! <= 0) throw new Error('Phoenix rent/fee estimate unavailable');
      const quote = { rentLamports: String(rent), feeLamports: String(fee.value), balanceLamports: String(balance) };
      if (balance < rent + fee.value!) return quote; // Refusal happens before keys are opened.
      const simulation = await rpc.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
        sigVerify: false, commitment: 'finalized', accounts: { encoding: 'base64', addresses: [payer.toBase58(), trader.toBase58()] },
      });
      const [payerAfter, traderAfter] = simulation.value.accounts ?? [];
      if (simulation.value.err || !payerAfter || !traderAfter || traderAfter.owner !== identity.programAddress
        || traderAfter.executable || traderAfter.data[1] !== 'base64' || !Number.isSafeInteger(payerAfter.lamports)
        || payerAfter.lamports < balance - rent - fee.value! || payerAfter.lamports > balance
        || traderAfter.lamports !== rent) throw new Error('Phoenix registration simulation failed cost checks');
      const data = Buffer.from(traderAfter.data[0], 'base64');
      if (data.length !== bytes || data.readUInt32LE(112) !== maxPositions) throw new Error('Phoenix account size mismatch');
      validateRegisteredTrader(data, identity);
      return quote;
    },
    withSigner,
    async submit(transaction, identity, maxPositions) {
      const response = await api('/v1/exchange/send-register-ixs', { transaction, ...fields(identity, maxPositions), traderPdaIndex: 0, traderSubaccountIndex: 0 });
      validateMetadata(response, identity, maxPositions);
      if (typeof response.signature !== 'string') throw new Error('Phoenix signature missing');
      return { signature: response.signature, traderPda: response.traderPda };
    },
    async confirm(signature, identity) {
      assertPhoenixIdentity(identity);
      const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (!status || status.confirmationStatus !== 'finalized') return 'unknown';
      if (status.err) return 'failed';
      const account = await rpc.getAccountInfo(new PublicKey(identity.traderAccountAddress), 'finalized');
      if (!account || account.owner.toBase58() !== identity.programAddress || account.executable) return 'unknown';
      try { validateRegisteredTrader(account.data, identity); } catch { return 'unknown'; }
      return 'confirmed';
    },
  };
}
