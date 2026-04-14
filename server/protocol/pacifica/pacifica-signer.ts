import { sign } from 'tweetnacl';
import * as bs58 from 'bs58';

export interface SignResult {
  signature: string;
  timestamp: number;
  expiryWindow: number;
}

export interface PacificaRequestBody {
  account: string;
  agent_wallet: string | null;
  signature: string;
  timestamp: number;
  expiry_window: number;
  [key: string]: unknown;
}

const DEFAULT_EXPIRY_WINDOW = 5000;

export class PacificaSigner {
  private readonly secretKey: Uint8Array;
  private readonly publicKeyBase58: string;

  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 64) {
      throw new Error(
        `PacificaSigner: expected 64-byte secret key, got ${secretKey.length} bytes`,
      );
    }
    this.secretKey = secretKey;
    this.publicKeyBase58 = bs58.encode(secretKey.slice(32, 64));
  }

  getPublicKey(): string {
    return this.publicKeyBase58;
  }

  sign(
    operationType: string,
    operationData: Record<string, unknown>,
    expiryWindow: number = DEFAULT_EXPIRY_WINDOW,
  ): SignResult {
    const timestamp = Date.now();

    const signingMessage = {
      timestamp,
      expiry_window: expiryWindow,
      type: operationType,
      data: operationData,
    };

    const sorted = sortKeysRecursive(signingMessage);
    const compact = JSON.stringify(sorted);
    const messageBytes = new TextEncoder().encode(compact);
    const signatureBytes = sign.detached(messageBytes, this.secretKey);
    const signatureBase58 = bs58.encode(signatureBytes);

    return {
      signature: signatureBase58,
      timestamp,
      expiryWindow,
    };
  }

  buildRequestBody(
    operationType: string,
    operationData: Record<string, unknown>,
    mainWalletAddress: string,
    agentPublicKey: string | null,
    expiryWindow: number = DEFAULT_EXPIRY_WINDOW,
  ): PacificaRequestBody {
    const { signature, timestamp, expiryWindow: expiry } = this.sign(
      operationType,
      operationData,
      expiryWindow,
    );

    return {
      account: mainWalletAddress,
      agent_wallet: agentPublicKey,
      signature,
      timestamp,
      expiry_window: expiry,
      ...operationData,
    };
  }
}

function sortKeysRecursive(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortKeysRecursive);
  }

  if (typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeysRecursive((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return obj;
}

export const OPERATION_TYPES = {
  CREATE_ORDER: 'create_order',
  CREATE_MARKET_ORDER: 'create_market_order',
  CREATE_STOP_ORDER: 'create_stop_order',
  CANCEL_ORDER: 'cancel_order',
  CANCEL_ALL_ORDERS: 'cancel_all_orders',
  CANCEL_STOP_ORDER: 'cancel_stop_order',
  UPDATE_LEVERAGE: 'update_leverage',
  UPDATE_MARGIN_MODE: 'update_margin_mode',
  SET_POSITION_TPSL: 'set_position_tpsl',
  WITHDRAW: 'withdraw',
  SUBACCOUNT_INITIATE: 'subaccount_initiate',
  SUBACCOUNT_CONFIRM: 'subaccount_confirm',
  SUBACCOUNT_TRANSFER: 'subaccount_transfer',
  BIND_AGENT_WALLET: 'bind_agent_wallet',
  CREATE_API_KEY: 'create_api_key',
  REVOKE_API_KEY: 'revoke_api_key',
  LIST_API_KEYS: 'list_api_keys',
} as const;

export type OperationType = (typeof OPERATION_TYPES)[keyof typeof OPERATION_TYPES];
