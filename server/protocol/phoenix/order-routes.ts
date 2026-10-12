/** No environment flag, HTTP payload or generic adapter enables Phoenix orders.
 * The reviewed executor is separately injectable; live IO/pins remain uninstalled. */
export function phoenixOrderDisabled() {
  return { code: 'PHOENIX_ORDERS_DISABLED', error: 'Phoenix order execution is not enabled.',
    recovery: 'Retain the bot and its order/funding identities for authoritative recovery.' };
}
