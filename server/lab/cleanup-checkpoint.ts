import { sql, type SQL } from "drizzle-orm";
import { labOptimizationRuns } from "@shared/schema";

// Match JavaScript JSON truthiness (including truthy empty arrays/objects),
// without transferring the checkpoint or its config snapshot to Node.
export function jsonTruthy(value: SQL): SQL<boolean> {
  return sql<boolean>`coalesce(${value} not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false)`;
}

const cp = sql`${labOptimizationRuns.checkpoint}`;
const combos = sql`${cp}->'completedCombos'`;
export const cleanupProjection = {
  id: labOptimizationRuns.id,
  checkpointObject: sql<boolean>`coalesce(jsonb_typeof(${cp}) in ('object', 'array'), false)`,
  comboLength: sql<any>`case jsonb_typeof(${combos})
    when 'array' then to_jsonb(jsonb_array_length(${combos}))
    when 'string' then to_jsonb(length(${combos} #>> '{}'))
    else ${combos}->'length' end`,
  currentCombo: jsonTruthy(sql`${cp}->'currentCombo'`),
  currentIteration: sql<any>`${cp}->'currentIteration'`,
  configSnapshot: jsonTruthy(sql`${cp}->'configSnapshot'`),
  userCancelled: jsonTruthy(sql`${cp}->'userCancelled'`),
  resourceError: jsonTruthy(sql`${cp}->'resourceError'`),
  checkpointStoredBytes: sql<number>`coalesce(pg_column_size(${cp}), 0)`,
};

// An array is typeof 'object' in JS, but assigning a property on it does not
// serialize that property. Only JSON objects receive the attempts reset.
export const resetCheckpointAttempts = sql`case when jsonb_typeof(${cp}) = 'object'
  then ${cp} || '{"autoResumeAttempts":0}'::jsonb else ${cp} end`;

export const completedCheckpointNeedsTrim = sql<boolean>`
  ${jsonTruthy(combos)} or ${jsonTruthy(sql`${cp}->'currentCombo'`)}
  or (${cp}->'currentIteration' is not null and ${cp}->'currentIteration' <> 'null'::jsonb)`;

const cpType = sql`${cp} #> '{configSnapshot,type}'`;
const runType = sql`${labOptimizationRuns.configSnapshot}->'type'`;
export const slimCompletedCheckpoint = sql`case
  when ${jsonTruthy(cpType)} then jsonb_build_object('configSnapshot', jsonb_build_object('type', ${cpType}))
  when ${jsonTruthy(runType)} then jsonb_build_object('configSnapshot', jsonb_build_object('type', ${runType}))
  else null end`;
