/** Only newly created v2 policies opt in. Absence preserves the original signed policy. */
export const GRID_LEAN_SIZING_VERSION = 'lean-1' as const;
export const GRID_LEAN_SIZING_CREATION = true;
export interface GridSizing {
  sizingVersion?: 'lean-1';
  safetyEnvelopePrice?: string;
}
/** Stored inside the existing immutable authority JSON, never inferred for old bots. */
export function retainedGridSizing(snapshot: any): GridSizing {
  if (snapshot?.gridSizing === undefined) return {};
  const sizing = snapshot.gridSizing;
  if (!sizing || sizing.sizingVersion !== GRID_LEAN_SIZING_VERSION || typeof sizing.safetyEnvelopePrice !== 'string')
    throw Error('Grid sizing authority unavailable');
  return { sizingVersion: sizing.sizingVersion, safetyEnvelopePrice: sizing.safetyEnvelopePrice };
}
