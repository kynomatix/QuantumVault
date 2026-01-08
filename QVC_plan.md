# QuantumVault - Future Development Plan

## Current State (Implemented)
- Drift subaccount system for bot isolation
- Main Account (subaccount 0) as central capital hub
- Manual allocation/deallocation between main and bots
- Delete bot with fund sweep safety

## Future Features

### Automatic DeFi Deployment
- Integrate with yield aggregators (like Lulo) to find best rates
- Auto-deploy idle Main Account capital to DeFi strategies
- Support various DeFi strategies (lending, LPs, etc.)

### Profit Threshold Settings
- Set per-bot profit thresholds (e.g., "sweep profits above $500 back to main")
- Automatic profit sweeping when thresholds are met
- Prevents bots from holding excess capital they don't need

### Capital Flow Architecture
```
Main Account (Subaccount 0) = Reserve/Buffer
├── Available for new bot allocations
├── Auto-deploy to DeFi yields when idle
└── Receives swept profits from bots

Bot Allocations = Active Trading Capital
├── Each bot has isolated subaccount
├── Tracks individual P&L
└── Auto-sweeps excess profits based on thresholds
```

### The Vision
1. Profits accumulate in bot subaccounts
2. When profit hits threshold → Auto-sweep excess back to Main Account
3. Main Account capital → Auto-deploy to best DeFi yields
4. Keep minimum liquidity for new bot allocations

This separation enables:
- Track which strategies are actually profitable
- Don't over-allocate to underperforming bots
- Idle capital earns yield instead of sitting dormant
- Thresholds prevent bots from holding excess capital
