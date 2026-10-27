// Independent wallet/grid contract suites mock the close-intent cooperating lock.
// Its PostgreSQL semantics are exercised by signal-bot-close-intent-postgres.test.ts.
export function makeLifecycleFenceFixture() {
  return { withOwnerLifecycle: async (_o: unknown, _a: unknown, work: () => Promise<unknown>) => work(),
    withLifecycle: async (_a: unknown, work: () => Promise<unknown>) => work(),
    withBotLifecycle: async (_b: unknown, _d: unknown, work: () => Promise<unknown>) => work(),
    withLifecycleAccounts: async (_a: unknown, work: () => Promise<unknown>) => work(),
    completeLinked: async (_t: unknown, work: () => Promise<unknown>) => work(),
    hasUnresolvedPosition: async () => false, hasUnresolvedTrade: async () => false };
}
