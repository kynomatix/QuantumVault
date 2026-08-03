import type { OrderResult } from "../protocol/protocol-types";

/** A close is complete only when the venue reports a successful full fill. */
export function isTerminalCloseResult(result: OrderResult): boolean {
  return result.success === true && result.status === "filled";
}
