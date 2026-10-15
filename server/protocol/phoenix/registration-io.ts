import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import type { PhoenixRegistrationIO } from './provisioner';
import type { PhoenixRegistrationPin } from './registration';
import { assertPhoenixIdentity } from './identity';
import { phoenixReferralPin, referralIdentityHash, validateReferralDeployment, referralActivationRequest, validateReferralResponse,
  type ReferralTraderEvidence } from './referral-activation';
import { createPhoenixReferralAuth, phoenixReferralApi, assertPhoenixReferralCredential } from './referral-auth';
import { signPhoenixReferralLogin } from './custody';

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
  | 'getFeeForMessage' | 'getBalance' | 'getAccountInfo' | 'simulateTransaction' | 'getSignatureStatuses' | 'getBlockHeight'>;
const origin = 'https://perp-api.phoenix.trade';
const traderDiscriminator = createHash('sha256').update('account:trader').digest().subarray(0, 8);

// Rise 0.6.1 Trader header: discriminant, 16-byte sequence, key, authority,
// 16-byte state; portfolio/subaccount at 154/155. No private material decoded.
export function validateRegisteredTrader(data: Buffer, identity: PhoenixTraderIdentity) {
  validateTraderIdentity(data, identity);
  if ((data.readUInt32LE(96) & 63) !== 63) throw new Error('Phoenix trader not activated for this identity');
}

export function validateTraderIdentity(data: Buffer, identity: PhoenixTraderIdentity) {
  assertPhoenixIdentity(identity);
  if (data.length < 224 || !data.subarray(0, 8).equals(traderDiscriminator)
    || new PublicKey(data.subarray(24, 56)).toBase58() !== identity.traderAccountAddress
    || new PublicKey(data.subarray(56, 88)).toBase58() !== identity.authorityWalletAddress
    || data[154] !== 0 || data[155] !== 0 || data.readUInt32LE(112) < 32 || data.readUInt32LE(112) > 128) {
    throw new Error('Phoenix trader not activated for this identity');
  }
}

/** Fixed current API endpoints only. Both send endpoints co-sign AND broadcast.
 * The referral endpoint additionally requires an authority session and durable binding.
 * There is no RPC send, API retry, transfer, deposit or unpark in this adapter.
 */
export function createPhoenixRegistrationIO(rpc: RegistrationRpc, deployment: PhoenixDeploymentPin,
  withSigner: PhoenixRegistrationIO['withSigner'], fetcher: typeof fetch = fetch): PhoenixRegistrationIO {
  const pin = structuredClone(deployment);
  const referralPin = phoenixReferralPin(pin);
  const auth = createPhoenixReferralAuth(fetcher);
  async function traderState(identity: PhoenixTraderIdentity): Promise<ReferralTraderEvidence> {
    const identityHash = referralIdentityHash(identity);
    try {
      const account = await rpc.getAccountInfo(new PublicKey(identity.traderAccountAddress), 'finalized');
      if (!account) return { state: 'missing', identityHash, observedAt: Date.now() };
      if (account.owner.toBase58() !== identity.programAddress || account.executable
        || !Number.isSafeInteger(account.lamports) || account.lamports < 0) throw new Error('Untrusted trader');
      validateTraderIdentity(account.data, identity);
      if (pin.traderBytesByMaxPositions[account.data.readUInt32LE(112)] !== account.data.length) throw new Error('Unreviewed trader size');
      return { state: (account.data.readUInt32LE(96) & 63) === 63 ? 'ready' : 'inactive', identityHash, observedAt: Date.now(),
        accountSha256: createHash('sha256').update(account.data).update(String(account.lamports)).digest('hex') };
    } catch { return { state: 'unknown', identityHash, observedAt: Date.now() }; }
  }
  async function api(path: string, body?: object): Promise<any> {
    const response = await fetcher(`${origin}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (body && (response.status === 401 || response.status === 403)) throw new PhoenixActivationRefusal('denied');
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
        const status = await phoenixReferralApi(fetcher, '/v1/view/exchange/status');
        if (status.gated === true && status.active === true && status.runningState === 'active') return 'gated';
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
    referral: {
      pin: referralPin,
      state: traderState,
      async validateDeployment(identity) {
        assertPhoenixIdentity(identity);
        if ([identity.authorityWalletAddress, identity.traderAccountAddress].includes(referralPin.riskAuthority)) throw new Error('Phoenix referral account alias');
        const [permission, exchange] = await Promise.all([
          phoenixReferralApi(fetcher, '/v1/referral/activation-permission'), phoenixReferralApi(fetcher, '/v1/view/exchange'),
        ]);
        validateReferralDeployment(permission, exchange, referralPin);
      },
      async credential(botId, identity, allowed) {
        return auth.credential(identity, challenge => withSigner(botId, secret => {
          if (!allowed()) throw new Error('Phoenix login revoked');
          return signPhoenixReferralLogin(challenge, identity, secret);
        }));
      },
      async unexpired(lifetime) {
        const height = await rpc.getBlockHeight('finalized');
        return Number.isSafeInteger(height) && height >= 0 && height <= lifetime.lastValidBlockHeight;
      },
      async estimate(transaction, identity, state, maxPositions) {
        assertPhoenixIdentity(identity);
        const bytes = pin.traderBytesByMaxPositions[maxPositions];
        if (!Number.isSafeInteger(bytes) || bytes < 224 || bytes > 16384) throw new Error('Unreviewed Phoenix account size');
        const payer = new PublicKey(identity.authorityWalletAddress), trader = new PublicKey(identity.traderAccountAddress);
        const [fee, balance, existing] = await Promise.all([rpc.getFeeForMessage(transaction.message, 'finalized'),
          rpc.getBalance(payer, 'finalized'), rpc.getAccountInfo(trader, 'finalized')]);
        let rent = 0;
        if (state === 'missing') {
          if (existing) throw new Error('Phoenix trader changed');
          rent = await rpc.getMinimumBalanceForRentExemption(bytes, 'finalized');
          if (!Number.isSafeInteger(rent) || rent <= 0) throw new Error('Phoenix rent unavailable');
        } else {
          if (!existing || existing.executable || existing.owner.toBase58() !== identity.programAddress) throw new Error('Phoenix trader changed');
          validateTraderIdentity(existing.data, identity);
          if ((existing.data.readUInt32LE(96) & 63) === 63 || existing.data.length !== bytes
            || existing.data.readUInt32LE(112) !== maxPositions) throw new Error('Phoenix trader changed');
        }
        if (![fee.value, balance].every(value => Number.isSafeInteger(value) && value! >= 0) || fee.value! <= 0) throw new Error('Phoenix fee unavailable');
        const quote = { rentLamports: String(rent), feeLamports: String(fee.value), balanceLamports: String(balance) };
        if (balance < rent + fee.value!) return quote;
        const simulation = await rpc.simulateTransaction(transaction, { sigVerify: false, commitment: 'finalized',
          accounts: { encoding: 'base64', addresses: [payer.toBase58(), trader.toBase58()] } });
        const [payerAfter, traderAfter] = simulation.value.accounts ?? [];
        if (simulation.value.err || !payerAfter || !traderAfter || traderAfter.owner !== identity.programAddress || traderAfter.executable
          || traderAfter.data[1] !== 'base64' || !Number.isSafeInteger(payerAfter.lamports)
          || payerAfter.lamports < balance - rent - fee.value! || payerAfter.lamports > balance
          || traderAfter.lamports !== (existing ? existing.lamports : rent)) throw new Error('Phoenix referral simulation failed cost checks');
        const data = Buffer.from(traderAfter.data[0], 'base64');
        if (data.length !== bytes || data.readUInt32LE(112) !== maxPositions) throw new Error('Phoenix referral account size mismatch');
        validateRegisteredTrader(data, identity);
        return quote;
      },
      async submit(signed, binding, identity, config, credential) {
        assertPhoenixReferralCredential(credential, identity);
        const body = referralActivationRequest(signed, binding, identity, referralPin, config);
        // Exactly one authenticated POST; every error remains ambiguous to the durable caller.
        const response = await phoenixReferralApi(fetcher, '/v1/referral/activate-tx', { body, bearer: credential.bearer });
        return validateReferralResponse(response, binding, identity, body.referral_code);
      },
    },
    async submit(transaction, identity, maxPositions) {
      const response = await api('/v1/exchange/send-register-ixs', { transaction, ...fields(identity, maxPositions), traderPdaIndex: 0, traderSubaccountIndex: 0 });
      validateMetadata(response, identity, maxPositions);
      if (typeof response.signature !== 'string') throw new Error('Phoenix signature missing');
      return { signature: response.signature, traderPda: response.traderPda };
    },
    async confirm(signature, identity, lastValidBlockHeight) {
      assertPhoenixIdentity(identity);
      const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (!status) {
        const height = await rpc.getBlockHeight('finalized');
        if (lastValidBlockHeight && /^[1-9][0-9]*$/.test(lastValidBlockHeight)
          && Number.isSafeInteger(height) && BigInt(height) > BigInt(lastValidBlockHeight)
          && !(await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]) return 'expired';
        return 'unknown';
      }
      if (status.confirmationStatus !== 'finalized') return 'unknown';
      if (status.err) return 'failed';
      const account = await rpc.getAccountInfo(new PublicKey(identity.traderAccountAddress), 'finalized');
      if (!account || account.owner.toBase58() !== identity.programAddress || account.executable) return 'unknown';
      try {
        validateRegisteredTrader(account.data, identity);
        if (pin.traderBytesByMaxPositions[account.data.readUInt32LE(112)] !== account.data.length) return 'unknown';
      } catch { return 'unknown'; }
      return 'confirmed';
    },
  };
}
