import { z } from 'zod';
import {PER_BOT_ORDINARY_MAX, GRID_PROTECTION_RESERVE, GRID_FULL_WINDOW_SLOTS, GRID_TRANSPORT_BATCH_ACTIONS} from './grid-capacity';
const price = z.string().max(31).regex(/^(?:0|[1-9]\d{0,21})(?:\.\d{1,8})?$/).refine(v => /[1-9]/.test(v));
const money = z.string().max(31).regex(/^(?:0|[1-9]\d{0,27})(?:\.\d{1,2})?$/).refine(v => /[1-9]/.test(v));
export const gridIntentSchema = z.object({
  schemaVersion: z.literal(1), protocol: z.literal('pacifica'), market: z.string().max(40).regex(/^[A-Z0-9]+-PERP$/),
  timeframe: z.enum(['15m','1h','4h']), lookback: z.union([z.literal(100),z.literal(200)]), rangeSource: z.enum(['manual','auto']),
  lowerPrice: price, upperPrice: price, stopPrice: price, gridCount: z.number().int().min(1).max(100),
  direction: z.enum(['long','short']), entryScaleType: z.enum(['flat','ascending','descending']),
  profitScaleType: z.enum(['flat','ascending','descending']), totalInvestment: money,
  leverage: z.string().max(6).regex(/^[1-9]\d*$/), seedAtCreation: z.boolean(),
}).strict();
export type GridIntent = z.infer<typeof gridIntentSchema>;
export const gridRevisionSchema = z.string().min(1).max(2048).refine(s => s.trim() === s);
export const gridPreviewRequestSchema = z.object({ schemaVersion: z.literal(1), requestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), draftRevision: gridRevisionSchema, intent: gridIntentSchema }).strict();
export const gridCreateRequestSchema = z.object({ schemaVersion: z.literal(1), clientRequestId: z.string().uuid().refine(v=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)), draftRevision: gridRevisionSchema, serverIntentDigest: z.string().regex(/^[0-9A-F]{64}$/), intent: gridIntentSchema }).strict();
export type GridCreateRequest = z.infer<typeof gridCreateRequestSchema>;
export const GRID_CREATE_POLICY = Object.freeze({ schemaVersion: 1, policyVersion:'1.0.0', feePolicyVersion:'1.0.0', runtimePolicyVersion:'1.0.0',
  ordinaryWindow:PER_BOT_ORDINARY_MAX, sharedReserve:GRID_PROTECTION_RESERVE, requiredSlots:GRID_FULL_WINDOW_SLOTS, transportBatch:GRID_TRANSPORT_BATCH_ACTIONS, maximumIntervals:100, maximumAgents:10,
  timeframes:['15m','1h','4h'], lookbacks:[100,200], draftOnly:true, pnlLabel:'Excludes funding' });
export const GRID_CAPACITY_UNKNOWN = Object.freeze({ state:'unavailable', venueMaximum:null, liveInventory:null, reservations:null,
  subaccountUsed:null, poolAvailable:null, reason:'Current venue capacity and subaccount inventory have not been established' });
