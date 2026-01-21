# Platform Analytics Indexer

**Created:** January 21, 2026  
**Status:** Active  
**Purpose:** Background service for calculating and caching platform-wide metrics

---

## Overview

The Platform Analytics Indexer is a background service that calculates and stores platform-wide metrics for display on the landing page and for monitoring purposes. It runs automatically every 5 minutes and provides real-time data about platform health and activity.

## Features

- **Automatic Calculation:** Runs every 5 minutes to update metrics
- **Caching Layer:** In-memory cache prevents database queries on every request
- **Database Persistence:** Metrics are stored in PostgreSQL for historical analysis
- **Public API:** `/api/metrics` endpoint for landing page (no authentication required)

## Metrics Tracked

| Metric | Description | Calculation Method |
|--------|-------------|-------------------|
| `tvl` | Total Value Locked | Sum of `total_investment` for all active bots |
| `total_volume` | All-time trading volume | Sum of `totalVolume` from bot stats |
| `volume_24h` | 24-hour trading volume | Sum of `size * price` for trades in last 24h |
| `volume_7d` | 7-day trading volume | Sum of `size * price` for trades in last 7 days |
| `active_bots` | Number of active trading bots | Count of bots where `isActive = true` |
| `active_users` | Number of unique users | Count of distinct wallet addresses with active bots |
| `total_trades` | Total executed trades | Count of trades with `status = 'filled'` |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Platform Analytics Indexer                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  Background  │────▶│   Storage    │────▶│  PostgreSQL  │    │
│  │   Interval   │     │   Methods    │     │   Database   │    │
│  │  (5 minutes) │     │              │     │              │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│         │                    │                                  │
│         ▼                    ▼                                  │
│  ┌──────────────┐     ┌──────────────┐                         │
│  │   In-Memory  │     │ /api/metrics │◀───── Landing Page      │
│  │     Cache    │────▶│   Endpoint   │                         │
│  │              │     │ (no auth)    │                         │
│  └──────────────┘     └──────────────┘                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `server/analytics-indexer.ts` | Main indexer service with calculation logic |
| `server/storage.ts` | Database methods for metrics CRUD |
| `shared/schema.ts` | `platform_metrics` table definition |
| `server/routes.ts` | `/api/metrics` public API endpoint |
| `client/src/pages/Landing.tsx` | Frontend display of metrics |

## API Endpoint

### GET /api/metrics

Returns current platform metrics. No authentication required.

**Response:**

```json
{
  "tvl": 24750.50,
  "totalVolume": 1250000.00,
  "volume24h": 15000.00,
  "volume7d": 85000.00,
  "activeBots": 12,
  "activeUsers": 8,
  "totalTrades": 561,
  "lastUpdated": "2026-01-21T15:30:00.000Z"
}
```

**Caching:**
- Response is cached for 5 minutes
- If cache is stale, triggers recalculation before responding
- Database serves as fallback if in-memory cache is empty

## Database Schema

```sql
CREATE TABLE platform_metrics (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_type TEXT NOT NULL,           -- 'tvl', 'total_volume', etc.
  value DECIMAL(30, 6) NOT NULL,       -- Metric value
  metadata JSONB,                       -- Optional additional data
  calculated_at TIMESTAMP NOT NULL,    -- When metric was calculated
  created_at TIMESTAMP NOT NULL
);
```

## Usage

### Starting the Indexer

The indexer starts automatically when the server boots via `registerRoutes()`:

```typescript
// In server/routes.ts
import { startAnalyticsIndexer } from "./analytics-indexer";

// Called during route registration
startAnalyticsIndexer();
```

### Manual Metric Calculation

```typescript
import { calculateAndStoreMetrics, getMetrics, getCachedMetrics } from "./analytics-indexer";

// Force recalculation
const metrics = await calculateAndStoreMetrics();

// Get metrics (uses cache if fresh)
const metrics = await getMetrics();

// Get cached metrics only (may be null)
const cached = getCachedMetrics();
```

### Stopping the Indexer

```typescript
import { stopAnalyticsIndexer } from "./analytics-indexer";

stopAnalyticsIndexer(); // Stops the interval timer
```

## Storage Methods

```typescript
// Upsert a metric (creates or updates)
await storage.upsertPlatformMetric('tvl', 24750.50, { source: 'indexer' });

// Get latest value for a metric type
const tvl = await storage.getLatestPlatformMetric('tvl');

// Get all latest metrics
const allMetrics = await storage.getLatestPlatformMetrics();

// Get metric history
const history = await storage.getPlatformMetricHistory('tvl', since, limit);

// Calculate metrics from source data
const tvl = await storage.calculatePlatformTVL();
const volume = await storage.calculatePlatformVolume();
const stats = await storage.calculatePlatformStats();
```

## Landing Page Integration

The landing page fetches metrics via React Query with automatic refetching:

```tsx
const { data: metrics } = useQuery<PlatformMetrics>({
  queryKey: ['platform-metrics'],
  queryFn: async () => {
    const response = await fetch('/api/metrics');
    if (!response.ok) throw new Error('Failed to fetch metrics');
    return response.json();
  },
  staleTime: 5 * 60 * 1000,      // Cache for 5 minutes
  refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
});
```

Metrics are displayed in the hero section:
- **50+ Perp Markets** - Static (based on Drift markets)
- **$XX.XK TVL** - Live total value locked
- **$XX.XK Volume** - Live total trading volume

## Logging

The indexer logs its activity to the console:

```
[Analytics] Starting analytics indexer (interval: 5 minutes)
[Analytics] Calculating platform metrics...
[Analytics] Metrics calculated in 45ms: {
  tvl: '$24,750',
  totalVolume: '$1,250,000',
  volume24h: '$15,000',
  activeBots: 12,
  activeUsers: 8,
  totalTrades: 561
}
```

## Error Handling

- Calculation errors are caught and logged but don't crash the service
- Failed API requests return HTTP 500 with error message
- Cache remains valid if recalculation fails
- Database serves as persistent backup

## Performance Considerations

1. **Query Efficiency:** Uses SQL aggregations (SUM, COUNT) to minimize data transfer
2. **Caching:** 5-minute cache prevents database hits on every request
3. **Parallel Execution:** Metrics are calculated in parallel using `Promise.all`
4. **Indexed Queries:** Queries use indexed columns (`isActive`, `status`, `executedAt`)

## Future Enhancements

- [ ] Historical metrics charting (TVL over time)
- [ ] Additional metrics (average trade size, win rate, etc.)
- [ ] Webhook notifications for metric thresholds
- [ ] Rate limiting on public endpoint
- [ ] Prometheus/Grafana integration for monitoring

## Troubleshooting

### Metrics Not Updating

1. Check server logs for `[Analytics]` messages
2. Verify indexer is started: `startAnalyticsIndexer()` in routes.ts
3. Check database connectivity
4. Manually trigger: `await calculateAndStoreMetrics()`

### Zero Values

1. Verify active bots exist: `SELECT COUNT(*) FROM trading_bots WHERE is_active = true`
2. Check bot_trades table has data: `SELECT COUNT(*) FROM bot_trades WHERE status = 'filled'`
3. Verify allocated_capital is set on bots

### API Returns Stale Data

1. Check `lastUpdated` timestamp in response
2. Force recalculation by restarting server
3. Check in-memory cache: `getCachedMetrics()`

---

**Maintained by:** Engineering Team  
**Last Updated:** January 21, 2026
