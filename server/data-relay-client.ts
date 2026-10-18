import { createDataRelayClient } from './market-stats/liquidations-relay';

// The only configuration boundary. Never serialize this client or its options.
export const dataRelayClient = createDataRelayClient({ url: process.env.DATA_RELAY_URL, token: process.env.DATA_RELAY_TOKEN });
