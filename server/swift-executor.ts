import { Connection, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import {
  DriftClient,
  Wallet,
  OrderType,
  PositionDirection,
  MarketType,
  generateSignedMsgUuid,
  BASE_PRECISION,
} from '@drift-labs/sdk';
import { SWIFT_CONFIG, classifySwiftError, recordSwiftSuccess, recordSwiftFailure, type SwiftErrorClassification } from './swift-config';
import { getPrimaryRpcUrl } from './rpc-config';

export interface SwiftOrderParams {
  privateKeyBase58: string;
  agentPublicKey: string;
  market: string;
  marketIndex: number;
  side: 'long' | 'short';
  sizeInBase: number;
  subAccountId: number;
  reduceOnly: boolean;
  slippageBps?: number;
}

export interface SwiftOrderResult {
  success: boolean;
  executionMethod: 'swift';
  txSignature?: string;
  swiftOrderId?: string;
  fillPrice?: number;
  fillAmount?: number;
  auctionDurationMs?: number;
  priceImprovement?: number;
  error?: string;
  errorClassification?: SwiftErrorClassification;
}

function createLightweightDriftClient(keypair: Keypair, connection: Connection): DriftClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK bundles its own @solana/web3.js with private property differences
  const wallet = new Wallet(keypair as any);
  return new DriftClient({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK bundles its own @solana/web3.js
    connection: connection as any,
    wallet,
    env: (process.env.DRIFT_ENV || 'mainnet-beta') as 'devnet' | 'mainnet-beta',
  });
}

function buildSwiftMessage(params: {
  marketIndex: number;
  side: 'long' | 'short';
  sizeInBase: number;
  subAccountId: number;
  reduceOnly: boolean;
  slot: number;
  uuid: Uint8Array;
  slippageBps?: number;
}) {
  const direction = params.side === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;

  const baseAmount = new BN(
    Math.round(params.sizeInBase * Number(BASE_PRECISION))
  );

  const orderParams = {
    orderType: OrderType.MARKET,
    marketIndex: params.marketIndex,
    marketType: MarketType.PERP,
    direction,
    baseAssetAmount: baseAmount,
    reduceOnly: params.reduceOnly,
    userOrderId: 0,
    price: new BN(0),
    auctionDuration: 0,
    auctionStartPrice: new BN(0),
    auctionEndPrice: new BN(0),
    maxTs: params.slippageBps !== undefined
      ? new BN(Math.floor(Date.now() / 1000) + 60)
      : new BN(0),
    triggerPrice: new BN(0),
    triggerCondition: { above: {} },
    oraclePriceOffset: 0,
    postOnly: false,
    immediateOrCancel: false,
  };

  return {
    signedMsgOrderParams: orderParams,
    subAccountId: params.subAccountId,
    slot: new BN(params.slot),
    uuid: params.uuid,
    stopLossOrderParams: null,
    takeProfitOrderParams: null,
  };
}

async function submitToSwiftApi(params: {
  orderParams: Buffer;
  signature: Uint8Array;
  takerAuthority: string;
  marketIndex: number;
}): Promise<Response> {
  const url = `${SWIFT_CONFIG.apiUrl}${SWIFT_CONFIG.orderEndpoint}`;

  const body = {
    market_index: params.marketIndex,
    market_type: 'perp',
    message: Buffer.from(params.orderParams).toString('base64'),
    signature: Buffer.from(params.signature).toString('base64'),
    taker_authority: params.takerAuthority,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SWIFT_CONFIG.orderTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeSwiftOrder(params: SwiftOrderParams): Promise<SwiftOrderResult> {
  const startTime = Date.now();

  try {
    const keyBytes = bs58.decode(params.privateKeyBase58);
    const keypair = Keypair.fromSecretKey(keyBytes);

    const rpcUrl = getPrimaryRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    const slot = await connection.getSlot('confirmed');

    const driftClient = createLightweightDriftClient(keypair, connection);

    const uuid = generateSignedMsgUuid();
    const swiftOrderId = Buffer.from(uuid).toString('hex');

    const swiftMessage = buildSwiftMessage({
      marketIndex: params.marketIndex,
      side: params.side,
      sizeInBase: params.sizeInBase,
      subAccountId: params.subAccountId,
      reduceOnly: params.reduceOnly,
      slot,
      uuid,
      slippageBps: params.slippageBps,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK OrderParams type has many optional fields filled at runtime
    const signed = driftClient.signSignedMsgOrderParamsMessage(swiftMessage as any);

    const response = await submitToSwiftApi({
      orderParams: signed.orderParams,
      signature: signed.signature,
      takerAuthority: keypair.publicKey.toBase58(),
      marketIndex: params.marketIndex,
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      const classification = classifySwiftError(errorText);
      recordSwiftFailure(errorText);

      return {
        success: false,
        executionMethod: 'swift',
        swiftOrderId,
        error: `Swift API error ${response.status}: ${errorText}`,
        errorClassification: classification,
      };
    }

    const data = await response.json() as Record<string, unknown>;
    recordSwiftSuccess(latencyMs);

    return {
      success: true,
      executionMethod: 'swift',
      swiftOrderId,
      txSignature: data.tx_signature as string | undefined,
      fillPrice: data.fill_price as number | undefined,
      fillAmount: data.fill_amount as number | undefined,
      auctionDurationMs: latencyMs,
      priceImprovement: data.price_improvement as number | undefined,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    let classification: SwiftErrorClassification;

    if (errorMessage.includes('aborted') || errorMessage.includes('AbortError')) {
      classification = 'retry_swift';
      recordSwiftFailure(`timeout after ${latencyMs}ms`);
    } else {
      classification = classifySwiftError(error);
      recordSwiftFailure(errorMessage);
    }

    return {
      success: false,
      executionMethod: 'swift',
      error: errorMessage,
      errorClassification: classification,
    };
  }
}
