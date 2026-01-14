# QuantumVault Notification System Plan

## Overview
Event-driven notification system using Dialect Protocol for Telegram push notifications. Users receive real-time alerts when their bots execute trades, encounter errors, or close positions.

## Current Implementation (Phase 1)

### Architecture
- **Event-Driven "Piggyback" Model**: Notifications are triggered by existing webhook trade execution flow - zero additional polling or monitoring costs
- **Dialect Protocol Integration**: Solana-native messaging protocol with Telegram support
- **User Preferences**: Granular toggle controls for different notification types

### Notification Types Implemented
1. **Trade Executed** (`trade_executed`): Bot successfully opens a position
   - Includes: Bot name, market, side (LONG/SHORT), size, entry price
   
2. **Trade Failed** (`trade_failed`): Trade execution error
   - Includes: Bot name, market, side, error message
   
3. **Position Closed** (`position_closed`): Position closed with PnL
   - Includes: Bot name, market, realized PnL (with emoji indicator)

### Database Schema
```sql
-- Added to wallets table
notifications_enabled BOOLEAN DEFAULT FALSE
notify_trade_executed BOOLEAN DEFAULT TRUE
notify_trade_failed BOOLEAN DEFAULT TRUE  
notify_position_closed BOOLEAN DEFAULT TRUE
telegram_connected BOOLEAN DEFAULT FALSE
dialect_address VARCHAR(64)  -- User's Dialect messaging address
```

### User Settings
Located in Settings > Notifications section:
- Master toggle for all notifications
- Individual toggles for each notification type
- Telegram connection status display

## Future Roadmap (Phase 2+)

### Continuous Monitoring Alerts
For users with large portfolios, add proactive health monitoring:

| Alert Type | Trigger | Cost Estimate |
|------------|---------|---------------|
| Health Warning | Account health < 50% | ~$5/mo per 50 users |
| Liquidation Risk | Health < 20% | Included with above |
| Large PnL Swing | >10% position change | ~$3/mo per 50 users |
| Bot Stopped | No activity for 24h+ | ~$2/mo per 50 users |

**Note**: Continuous monitoring requires periodic blockchain queries which add operational cost. Consider tiered implementation based on user plan.

### Email Notifications
- Daily/weekly trading summary emails
- Account activity reports
- Security alerts (new login, settings changed)

### Discord Integration
- Server-based notifications for community features
- Leaderboard updates
- Market alerts

### Mobile Push Notifications
- Native mobile app push (when mobile app is built)
- More reliable than Telegram for critical alerts

## Technical Notes

### Dialect SDK Setup
The notification service requires two environment variables:
- `DIALECT_SDK_CREDENTIALS`: Base64-encoded keypair for dApp messaging
- `DIALECT_DAPP_PUBLIC_KEY`: Public key of the dApp's messaging account

### Telegram Connection Flow
1. User clicks "Connect Telegram" in Settings
2. Opens Dialect Telegram bot (@DialectBot)
3. User links wallet to Telegram via bot
4. Platform detects connection and enables notifications

### Rate Limiting
- Maximum 100 notifications per user per hour
- Duplicate notification suppression (same message within 60s)
- Graceful degradation if Dialect API is unavailable

## Cost Analysis

### Current (Event-Driven Only)
- **Monthly Cost**: $0 additional
- **Per Notification**: ~$0.0001 (Dialect API call)
- **50 Active Users**: ~$1-2/month

### With Continuous Monitoring
- **50 Users**: ~$10-15/month
- **150 Users**: ~$30-40/month
- **500 Users**: ~$80-100/month

Recommendation: Implement continuous monitoring as a premium feature for subscribed users.

## Security Considerations
- Never include sensitive data (wallet addresses, private info) in notifications
- Rate limit to prevent notification spam
- User can disable notifications instantly via Settings
- All notification content is sanitized before sending
