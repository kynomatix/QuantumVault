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
- **Session Management**: Express-session with wallet address tracking
- **API Design**: RESTful endpoints under `/api/*` prefix
- **Build**: esbuild for production bundling with selective dependency bundling
- **Config**: Centralized Solana RPC config in `server/config.ts`

### Data Storage
- **Database**: PostgreSQL via Drizzle ORM
- **Schema Location**: `shared/schema.ts` contains all table definitions
- **Tables**: 
  - `wallets` - User wallet connections with agent wallet keypairs
  - `tradingBots` - TradingView signal bots with webhook configuration
  - `botTrades` - Trade execution history for bots
  - `webhookLogs` - Incoming webhook request logs for debugging
- **Migrations**: Managed via `drizzle-kit push` command

### Authentication
- **Wallet-Based**: Authentication via Solana wallet connection (Phantom)
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
- **Capital Flow Operations**:
  1. Deposit to Agent: User signs USDC transfer from Phantom to Agent Wallet
  2. Agent to Drift: Agent signs deposit from Agent Wallet to Drift Protocol
  3. Drift to Agent: Agent signs withdrawal from Drift to Agent Wallet
  4. Withdraw to Wallet: Agent signs USDC transfer from Agent Wallet to Phantom
- **Agent Wallet API Endpoints**:
  - `GET /api/agent/balance` - Get agent wallet USDC balance
  - `POST /api/agent/deposit` - Build tx for user to deposit to agent (user signs)
  - `POST /api/agent/withdraw` - Agent sends USDC to user wallet (agent signs)
  - `POST /api/agent/drift-deposit` - Agent deposits to Drift (agent signs)
  - `POST /api/agent/drift-withdraw` - Agent withdraws from Drift (agent signs)

### Drift Subaccounts
- **Subaccount 0**: Main trading account (agent wallet's Drift account)
- **Subaccounts 1+**: Individual trading bot subaccounts (future implementation)
- **Delete Safety**: Bots with funds require sweep transaction before deletion
- **Capital Pool UI**: Shows Phantom balance, Agent Wallet balance, and Drift Protocol balance

## API Endpoints

### Wallet Endpoints
- `POST /api/wallet/connect` - Connect wallet and create/return user
- `GET /api/wallet/me` - Get current wallet info
- `GET /api/wallet/capital` - Get wallet USDC balance

### Trading Bot Endpoints
- `GET /api/trading-bots` - List all bots for current wallet
- `POST /api/trading-bots` - Create a new trading bot
- `GET /api/trading-bots/:id` - Get bot details
- `PATCH /api/trading-bots/:id` - Update bot settings
- `DELETE /api/trading-bots/:id` - Delete a bot
- `GET /api/trading-bots/:id/trades` - Get bot's trade history
- `POST /api/webhook/tradingview/:botId` - Receive TradingView webhook signals

### Capital Management Endpoints
- `GET /api/total-equity` - Get total equity across all Drift subaccounts
- `GET /api/prices` - Get current market prices from Drift
- `GET /api/prices/:market` - Get specific market price

### Bot Capital Endpoints
- `POST /api/bot/:botId/deposit` - Deposit to bot's subaccount
- `POST /api/bot/:botId/withdraw` - Withdraw from bot's subaccount
- `GET /api/bot/:botId/balance` - Get bot's subaccount balance

### Drift Endpoints
- `POST /api/drift/deposit` - Build deposit transaction to Drift
- `POST /api/drift/withdraw` - Build withdraw transaction from Drift
- `GET /api/drift/balance` - Get Drift account balance

## External Dependencies

### Blockchain Services
- **Solana Web3.js**: Core blockchain interaction (`@solana/web3.js`)
- **Drift Protocol SDK**: Perpetual futures trading (`@drift-labs/sdk`)
- **SPL Token**: Token program interactions (`@solana/spl-token`)
- **RPC Endpoint**: Configurable via `SOLANA_RPC_URL` environment variable, defaults to devnet

### Database
- **PostgreSQL**: Required via `DATABASE_URL` environment variable
- **Drizzle ORM**: Type-safe database queries with `drizzle-orm/node-postgres`

### Environment Variables Required
- `DATABASE_URL`: PostgreSQL connection string
- `SESSION_SECRET`: Session encryption key (optional, has default for development)
- `SOLANA_RPC_URL`: Solana RPC endpoint (optional, defaults to devnet)

### Drift Protocol Testnet Configuration
- **Network**: Solana Devnet
- **USDC Token Mint**: `8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2`
- **Usage**: For deposits/withdrawals on Drift testnet

### Frontend Libraries
- **UI Components**: Full shadcn/ui component set with Radix UI primitives
- **Forms**: React Hook Form with Zod validation (`@hookform/resolvers`)
- **Charts**: Recharts for data visualization

## Recent Changes (January 2026)

### Code Cleanup Audit
- Removed legacy authentication system (username/password)
- Removed unused database tables (users, bots, subscriptions, portfolios, positions, trades, leaderboardStats)
- Removed unused API endpoints for legacy features
- Removed unused frontend pages (Landing, BotSetup)
- Removed unused components (AuthDialog, BotManagementDrawer, DepositWithdraw)
- Consolidated Solana RPC configuration into `server/config.ts`
- Fixed webhook foreign key crash when bots are deleted
- Deleted unused `server/drift-client.ts` file
- Cleaned up frontend hooks to remove legacy data fetching
