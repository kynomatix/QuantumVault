/**
 * Flash Trade transaction signer.
 *
 * Flash is an ON-CHAIN protocol: unlike Pacifica (REST + ed25519 request
 * envelopes), every Flash action is a Solana transaction signed by the bot's
 * agent keypair. This module wraps that keypair behind a narrow interface so the
 * three Flash V2 "MagicBlock" seams (§4.5) — gasless session-key signing in
 * particular — can drop in a different `FlashTransactionSigner` implementation
 * later WITHOUT touching the adapter's call sites.
 *
 * Security: the secret key lives only inside an instance for the duration of a
 * single write. The adapter constructs an ephemeral signer per money-path call
 * from the just-decrypted agent key and lets it go out of scope immediately —
 * the key is never persisted, logged, or cached.
 */

import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';

export type SignableTransaction = Transaction | VersionedTransaction;

/**
 * Minimal signing surface the adapter depends on. The default implementation
 * (`FlashKeypairSigner`) signs with the agent keypair directly; the Flash V2
 * session-key seam (§4.5) can supply an alternative that signs via a delegated
 * ephemeral key / MagicBlock session without changing adapter code.
 */
export interface FlashTransactionSigner {
  readonly publicKey: PublicKey;
  getPublicKey(): string;
  signTransaction<T extends SignableTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends SignableTransaction>(txs: T[]): Promise<T[]>;
  /**
   * Anchor-compatible wallet for constructing an `AnchorProvider`. The flash-sdk
   * `PerpetualsClient` derives the position/referral PDAs and the fee payer from
   * the provider wallet's public key, so a WRITE client must be built with this.
   */
  asAnchorWallet(): Wallet;
}

export class FlashKeypairSigner implements FlashTransactionSigner {
  private readonly keypair: Keypair;

  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 64) {
      throw new Error(
        `FlashKeypairSigner: expected 64-byte secret key, got ${secretKey.length} bytes`,
      );
    }
    this.keypair = Keypair.fromSecretKey(secretKey);
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  getPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  async signTransaction<T extends SignableTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.keypair]);
    } else {
      tx.partialSign(this.keypair);
    }
    return tx;
  }

  async signAllTransactions<T extends SignableTransaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) {
      await this.signTransaction(tx);
    }
    return txs;
  }

  asAnchorWallet(): Wallet {
    return new Wallet(this.keypair);
  }
}

/**
 * Build a read-only Anchor wallet backed by a throwaway keypair. The flash-sdk
 * read paths (`getUserPositions(walletPubkey, …)`) take the wallet pubkey as an
 * explicit argument, so a READ client never needs a real signer — but
 * `AnchorProvider` still requires *a* wallet object.
 */
export function createReadOnlyWallet(): Wallet {
  return new Wallet(Keypair.generate());
}
