import { Connection, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import {
  DriftClient,
  Wallet,
  OrderType,
  PositionDirection,
  MarketType,
  PostOnlyParams,
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
  oraclePrice?: number;
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

const PRICE_PRECISION = new BN(1_000_000);

function computeAuctionParams(params: {
  side: 'long' | 'short';
  oraclePrice?: number;
  slippageBps?: number;
}) {
  if (!params.oraclePrice || params.oraclePrice <= 0) {
    return { auctionDuration: 20, auctionStartPrice: new BN(0), auctionEndPrice: new BN(0), limitPrice: new BN(0) };
  }

  const slipBps = params.slippageBps || 50;
  const pricePrecision = Number(PRICE_PRECISION);
  const oracleBn = Math.round(params.oraclePrice * pricePrecision);

  const auctionDuration = 20;

  const startBufferBps = 5;

  if (params.side === 'long') {
    const startPrice = new BN(Math.round(oracleBn * (1 - startBufferBps / 10000)));
    const endPrice = new BN(Math.round(oracleBn * (1 + slipBps / 10000)));
    const limitPrice = new BN(Math.round(oracleBn * (1 + slipBps * 2 / 10000)));
    return { auctionDuration, auctionStartPrice: startPrice, auctionEndPrice: endPrice, limitPrice };
  } else {
    const startPrice = new BN(Math.round(oracleBn * (1 + startBufferBps / 10000)));
    const endPrice = new BN(Math.round(oracleBn * (1 - slipBps / 10000)));
    const limitPrice = new BN(Math.round(oracleBn * (1 - slipBps * 2 / 10000)));
    return { auctionDuration, auctionStartPrice: startPrice, auctionEndPrice: endPrice, limitPrice };
  }
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
  oraclePrice?: number;
}) {
  const direction = params.side === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;

  const baseAmount = new BN(
    Math.round(params.sizeInBase * Number(BASE_PRECISION))
  );

  const auction = computeAuctionParams({
    side: params.side,
    oraclePrice: params.oraclePrice,
    slippageBps: params.slippageBps,
  });

  const orderParams = {
    orderType: OrderType.MARKET,
    marketIndex: params.marketIndex,
    marketType: MarketType.PERP,
    direction,
    baseAssetAmount: baseAmount,
    reduceOnly: params.reduceOnly,
    userOrderId: 0,
    price: auction.limitPrice,
    bitFlags: 0,
    auctionDuration: auction.auctionDuration,
    auctionStartPrice: auction.auctionStartPrice,
    auctionEndPrice: auction.auctionEndPrice,
    maxTs: new BN(Math.floor(Date.now() / 1000) + 60),
    triggerPrice: null,
    triggerCondition: { above: {} },
    oraclePriceOffset: null,
    postOnly: PostOnlyParams.NONE,
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
    message: params.orderParams.toString(),
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

function swiftLog(msg: string) {
  console.log(`[Swift Executor] ${msg}`);
  try {
    const fs = require('fs');
    const logPath = '/tmp/swift-debug.log';
    const stats = fs.existsSync(logPath) ? fs.statSync(logPath) : null;
    if (stats && stats.size > 1024 * 1024) {
      fs.writeFileSync(logPath, `[${new Date().toISOString()}] [executor] Log rotated\n`);
    }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [executor] ${msg}\n`);
  } catch {}
}

export async function executeSwiftOrder(params: SwiftOrderParams): Promise<SwiftOrderResult> {
  const startTime = Date.now();
  swiftLog(`START: market=${params.market} side=${params.side} size=${params.sizeInBase} reduceOnly=${params.reduceOnly} subAccount=${params.subAccountId} oraclePrice=${params.oraclePrice || 'none'}`);

  try {
    const keyBytes = bs58.decode(params.privateKeyBase58);
    const keypair = Keypair.fromSecretKey(keyBytes);

    const rpcUrl = getPrimaryRpcUrl();
    swiftLog(`RPC URL: ${rpcUrl?.substring(0, 50)}...`);
    const connection = new Connection(rpcUrl, 'confirmed');

    const slot = await connection.getSlot('confirmed');
    swiftLog(`Got slot: ${slot}`);

    const driftClient = createLightweightDriftClient(keypair, connection);
    swiftLog(`DriftClient created`);

    const uuid = generateSignedMsgUuid();
    const swiftOrderId = Buffer.from(uuid).toString('hex');
    swiftLog(`Generated UUID: ${swiftOrderId}`);

    const swiftMessage = buildSwiftMessage({
      marketIndex: params.marketIndex,
      side: params.side,
      sizeInBase: params.sizeInBase,
      subAccountId: params.subAccountId,
      reduceOnly: params.reduceOnly,
      slot,
      uuid,
      slippageBps: params.slippageBps,
      oraclePrice: params.oraclePrice,
    });

    const ap = swiftMessage.signedMsgOrderParams;
    swiftLog(`Auction params: side=${params.side} start=${ap.auctionStartPrice?.toString()} end=${ap.auctionEndPrice?.toString()} limit=${ap.price?.toString()} duration=${ap.auctionDuration} oracle=${params.oraclePrice}`);
    swiftLog(`Built Swift message, signing...`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK OrderParams type has many optional fields filled at runtime
    const signed = driftClient.signSignedMsgOrderParamsMessage(swiftMessage as any);
    swiftLog(`Message signed, submitting to Swift API at ${SWIFT_CONFIG.apiUrl}${SWIFT_CONFIG.orderEndpoint}`);

    const response = await submitToSwiftApi({
      orderParams: signed.orderParams,
      signature: signed.signature,
      takerAuthority: keypair.publicKey.toBase58(),
      marketIndex: params.marketIndex,
    });

    const latencyMs = Date.now() - startTime;

    swiftLog(`Swift API response: status=${response.status} ok=${response.ok}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      swiftLog(`Swift API ERROR: ${response.status} - ${errorText}`);
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
    swiftLog(`Swift API SUCCESS: ${JSON.stringify(data)}`);
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
    swiftLog(`EXCEPTION after ${latencyMs}ms: ${errorMessage}`);

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
