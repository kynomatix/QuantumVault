# QuantumVault - Solana Bot Trading Platform

## Overview

QuantumVault is a Solana-based bot trading platform with Drift Protocol integration. Users can connect their Phantom wallet, deploy trading bots, and manage perpetual futures positions. The platform provides webhook-based TradingView integration for automated trade execution.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack React Query for server state, React hooks for local state
- **Styling**: Tailwind CSS v4 with shadcn/ui component library (New York style)
- **Animations**: Framer Motion for UI transitions
- **Wallet Integration**: Solana Wallet Adapter with Phantom wallet support
- **Build Tool**: Vite with custom plugins for meta images and Replit integration

### Backend Architecture
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript with ESM modules
- **Session Management**: Express-session with cookie-based authentication
- **API Design**: RESTful endpoints under `/api/*` prefix
- **Build**: esbuild for production bundling with selective dependency bundling

### Data Storage
- **Database**: PostgreSQL via Drizzle ORM
- **Schema Location**: `shared/schema.ts` contains all table definitions
- **Tables**: users, wallets, bots, tradingBots, botTrades, equityEvents, webhookLogs, subscriptions, portfolios, positions, trades, leaderboardStats
- **Migrations**: Managed via `drizzle-kit push` command

### Authentication
- **Wallet-Based**: Primary authentication via Solana wallet connection (Phantom)
- **Username/Password**: Secondary traditional auth with bcrypt password hashing
- **Session Storage**: Server-side sessions with wallet address tracking

### Key Design Patterns
- **Monorepo Structure**: Client (`client/`), server (`server/`), and shared code (`shared/`)
- **Path Aliases**: `@/` for client source, `@shared/` for shared modules
- **API Layer**: Custom hooks in `useApi.ts` wrap React Query for data fetching
- **Storage Interface**: `IStorage` interface in `storage.ts` abstracts database operations

### Agent Wallet Architecture
- **3-Tier Fund Flow**: User Phantom Wallet → Agent Wallet → Drift Protocol
- **Agent Wallet**: Server-managed Solana wallet per user for autonomous trading
  - Generated on first wallet connect
  - Private key stored encrypted in database (wallets.agentPrivateKeyEncrypted)
  - Public key visible to user (wallets.agentPublicKey)
  - Signs all Drift interactions server-side for automated trade execution
- **Simplified Capital Flow** (as of Jan 2026):
  1. Deposit: User signs USDC transfer from Phantom to Agent Wallet
  2. Withdraw: Agent signs USDC transfer from Agent Wallet to Phantom
  3. User manually deposits USDC from Agent Wallet to Drift when needed
- **Trade Execution** (Jan 2026): When a TradingView webhook signal arrives, the agent executes real perpetual orders on Drift Protocol using `placeAndTakePerpOrder`. Orders are placed on the bot's configured subaccount (or subaccount 0 if not configured).
- **TradingView Signal Format (CRITICAL - DO NOT CHANGE - Jan 2026)**:
  - **⚠️ USDT-TO-PERCENTAGE TRANSLATION - DO NOT CHANGE ⚠️**
  - User sets order size in TradingView as **USDT** (e.g., 33.33 USDT)
  - TradingView sends `contracts = USDT / price` (e.g., 33.33 / 136 = 0.245)
  - **Platform reverses this**: `usdtValue = contracts × price` (0.245 × 136 = 33.33)
  - **Platform treats usdtValue AS A PERCENTAGE** of `maxPositionSize`
  - **Formula**: `tradeAmountUsd = (usdtValue / 100) * bot.maxPositionSize`
  - **Example**: 
    - TradingView: 33.33 USDT order size, SOL at $136
    - TradingView sends: contracts = 0.245
    - Platform calculates: 0.245 × $136 = 33.33 USDT → treat as 33.33%
    - Bot maxPositionSize = $6 → tradeAmountUsd = 33.33% of $6 = $2
    - With 10x leverage: finalContracts = ($2 × 10) / $136 = 0.147 SOL ✓
  - **Pyramiding Setup**: For 3 pyramid orders, set TradingView initial capital = 100, order size = 33.33 USDT
    - Each entry = 33.33% of bot's maxPositionSize
  - **⚠️ DO NOT CHANGE THIS LOGIC ⚠️** - This is the core USDT→percentage translation
  - **⚠️ THE SIGNAL IS USDT, PLATFORM CONVERTS TO PERCENTAGE ⚠️**
- **Minimum Order Sizes (from Drift Protocol)**:
  - SOL-PERP: 0.01 SOL (~$1.36 at $136/SOL)
  - BTC-PERP: 0.0001 BTC (~$9 at $90k/BTC)
  - ETH-PERP: 0.001 ETH (~$3 at $3k/ETH)
  - With leverage, minimum capital per entry = (minOrderSize × price) / leverage
  - Example: SOL with 10x leverage needs ~$0.14 per pyramid entry
- **Agent Wallet API Endpoints**:
  - `GET /api/agent/balance` - Get agent wallet USDC balance
  - `POST /api/agent/deposit` - Build tx for user to deposit to agent (user signs)
  - `POST /api/agent/withdraw` - Agent sends USDC to user wallet (agent signs)
  - `POST /api/agent/confirm-deposit` - Log confirmed deposit transaction
  - `POST /api/agent/confirm-withdraw` - Log confirmed withdrawal transaction
  - `GET /api/equity-events` - Get transaction history for wallet

### Equity Event Tracking (Jan 2026)
- **Purpose**: Track all deposits and withdrawals for transaction history display
- **Event Types**: agent_deposit, agent_withdraw, drift_deposit, drift_withdraw
- **Idempotency**: Duplicate transactions with same signature are rejected
- **Security**: Requires valid transaction signature, wallet session authentication

### Drift Subaccounts
- **Subaccount 0**: Main trading account (agent wallet's Drift account) - ALL trades currently execute here
- **Subaccounts 1+**: Individual trading bot subaccounts (future implementation, not yet supported)
- **Current Limitation**: Multi-subaccount trading is not yet implemented; all orders execute on subaccount 0 regardless of bot configuration
- **Delete Safety**: Bots with funds require sweep transaction before deletion
- **Simplified Wallet UI**: Shows Phantom balance, Agent Wallet balance, and Bot Balance (per-subaccount)

### Drift User Account Parsing (Jan 2026)
- **Account Data Size**: ~4376 bytes for User account
- **Struct Layouts** (derived from official Drift IDL v2.150.0):
  - **User Account**: 8-byte discriminator, then authority (32), delegate (32), name (32), spotPositions (384)
  - **SpotPositions Array**: Starts at offset 104 (8 + 32 + 32 + 32)
  - **SpotPosition Struct**: 48 bytes per position (8 positions total)
- **SpotPosition Field Offsets**:
  - `scaledBalance`: u64 at offset 0 (8 bytes)
  - `openBids`: i64 at offset 8
  - `openAsks`: i64 at offset 16
  - `cumulativeDeposits`: i64 at offset 24 (lifetime deposits, not current balance)
  - `marketIndex`: u16 at offset 32
  - `balanceType`: u8 at offset 34 (0 = Deposit, 1 = Borrow)
- **SpotMarket Account**: cumulativeDepositInterest u128 at offset 464
- **Balance Formula**: `actualTokens = scaledBalance * cumulativeDepositInterest / 1e9 / 1e10`
- **USDC Market Index**: 0
- **Deposit Remaining Accounts Order**: Oracle (readable) MUST come before SpotMarket (writable)
- **Note**: Drift SDK cannot be used directly due to jito-ts dependency conflict; using deterministic byte parsing instead

### Drift Perp Position Parsing (Jan 2026)
- **PerpPositions Array**: Starts at offset 488 (104 + 384 spotPositions)
- **PerpPosition Struct**: 184 bytes per position (8 positions total)
- **PerpPosition Field Offsets** (within each 184-byte struct):
  - `lastCumulativeFundingRate`: i128 at offset 0 (16 bytes)
  - `baseAssetAmount`: i128 at offset 16 (position size, scaled by 1e9)
  - `quoteAssetAmount`: i128 at offset 32 (scaled by 1e6)
  - `quoteBreakEvenAmount`: i128 at offset 48
  - `quoteEntryAmount`: i128 at offset 64 (entry value for PnL calculation)
  - `openBids`: i128 at offset 80
  - `openAsks`: i128 at offset 96
  - `settledPnl`: i128 at offset 112
  - `lpShares`: u64 at offset 128
  - `lastBaseAssetAmountPerLp`: i64 at offset 136
  - `lastQuoteAssetAmountPerLp`: i64 at offset 144
  - `remainderBaseAssetAmount`: i32 at offset 152
  - `marketIndex`: u16 at offset 156
  - `openOrders`: u8 at offset 158
  - `perLpBase`: i8 at offset 159
  - `padding`: 24 bytes at offset 160
- **Position Detection**: baseAssetAmount != 0 indicates open position
- **Side Calculation**: baseAssetAmount > 0 = LONG, < 0 = SHORT
- **Entry Price Formula**: abs(quoteEntryAmount) / abs(baseAssetAmount)
- **Unrealized PnL Formula**: 
  - LONG: (markPrice - entryPrice) * abs(baseAssetAmount)
  - SHORT: (entryPrice - markPrice) * abs(baseAssetAmount)
- **Perp Market Index Mapping**: 0=SOL-PERP, 1=BTC-PERP, 2=ETH-PERP, 3=APT-PERP, etc.
- **API Endpoint**: `GET /api/positions` - Returns open perp positions with entry price, PnL, and size

## External Dependencies

### Blockchain Services
- **Solana Web3.js**: Core blockchain interaction (`@solana/web3.js`)
- **Drift Protocol SDK**: Perpetual futures trading (`@drift-labs/sdk`)
- **SPL Token**: Token program interactions (`@solana/spl-token`)
- **RPC Endpoint**: Configurable via `SOLANA_RPC_URL` environment variable, defaults to mainnet-beta

### Database
- **PostgreSQL**: Required via `DATABASE_URL` environment variable
- **Drizzle ORM**: Type-safe database queries with `drizzle-orm/node-postgres`

### Environment Variables Required
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Session encryption key (optional, has default for development)
- `HELIUS_API_KEY`: Helius RPC API key for reliable mainnet access (required for production)
- `SOLANA_RPC_URL`: Solana RPC endpoint (optional, overrides Helius if set)

### RPC Architecture
- **Server-side RPC Proxy**: Frontend uses `/api/solana-rpc` endpoint that proxies to Helius
- **API Key Security**: Helius API key never exposed to browser, stays server-side only
- **Fallback Chain**: SOLANA_RPC_URL → Helius (if key provided) → public mainnet RPC
- **Rate Limiting**: Helius provides reliable throughput; public RPC has strict limits

### Drift Protocol Configuration
- **Network**: Solana Mainnet-Beta (default), configurable via `DRIFT_ENV` env var
- **Mainnet USDC Token Mint**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **Devnet USDC Token Mint**: `8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2`
- **Usage**: Real USDC deposits/withdrawals on Drift mainnet for live trading
- **Note**: Set `DRIFT_ENV=devnet` to switch back to devnet (oracle issues may occur)

### Frontend Libraries
- **UI Components**: Full shadcn/ui component set with Radix UI primitives
- **Forms**: React Hook Form with Zod validation (`@hookform/resolvers`)
- **Charts**: Recharts for data visualization