import {z} from 'zod';
import {gridRevisionSchema} from './grid-draft';

/** Bind confirmation to the immutable draft, rather than mutable lifecycle timestamps. */
export const gridStartRequestSchema = z.object({
  draftRevision: gridRevisionSchema,
  serverIntentDigest: z.string().length(64).regex(/^[0-9A-F]+$/),
}).strict();
export type GridStartRequest = z.infer<typeof gridStartRequestSchema>;
export interface GridStartResult {
  launchId: string;
  state: 'pending' | 'canary' | 'denied';
  reason?: string;
}
