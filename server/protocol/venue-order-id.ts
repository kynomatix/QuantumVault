/** Pacifica order IDs are unsigned decimal integers. */
export function isVenueOrderId(value: unknown): value is string | number {
  return (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

export function canonicalVenueOrderId(value: unknown): string | undefined {
  return isVenueOrderId(value) ? String(value) : undefined;
}

export function sameVenueOrderId(left: unknown, right: unknown): boolean {
  const id = canonicalVenueOrderId(left);
  return id !== undefined && id === canonicalVenueOrderId(right);
}
