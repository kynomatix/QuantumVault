// Group D item 17d (April 17, 2026): shared parse/validate for the canonical
// numeric subaccount ID returned by `adapter.createSubaccount()` in
// `main_plus_id` mode. Previously inlined in the main bot-creation site at
// server/routes.ts; the marketplace creation path bypassed `adapter.createSubaccount`
// entirely. Lifting this into a single helper means both call sites apply
// identical validation when persisting the value as `driftSubaccountId`
// (Postgres `integer` column).
//
// Contract (12h Option A): the subaccountId string returned by an adapter MUST
// parse as a non-negative integer that fits Postgres `integer` (≤ 2,147,483,647)
// AND survives a canonical round-trip (`String(parsed) === rawId.trim()`). The
// round-trip rejects scientific notation, decimals, leading zeros, signs, and
// any non-pure-digit input that Number.parseInt would otherwise silently accept.
//
// Throws on validation failure — caller decides how to surface the error
// (HTTP 500, log + abort, etc.). Does NOT log internally to keep the helper
// pure and testable.

const PG_INTEGER_MAX = 2_147_483_647;

export function parseAndValidateAdapterSubaccountId(
  rawId: string,
  protocolName: string,
): number {
  const trimmed = rawId.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > PG_INTEGER_MAX ||
    String(parsed) !== trimmed
  ) {
    throw new Error(
      `${protocolName} adapter returned invalid numeric subaccountId for main_plus_id mode: ` +
        `"${rawId}" (parsed=${parsed}). ` +
        `Expected canonical non-negative integer string ≤ ${PG_INTEGER_MAX} (Postgres int max).`,
    );
  }
  return parsed;
}
