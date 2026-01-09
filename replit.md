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
  3. Agent handles Drift deposits automatically when trading bots need capital
- **Auto-Deposit Feature**: When a TradingView webhook signal arrives, the agent automatically deposits any USDC from the agent wallet to Drift Protocol before executing the trade. This eliminates manual Drift management.
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
- **Subaccount 0**: Main trading account (agent wallet's Drift account)
- **Subaccounts 1+**: Individual trading bot subaccounts (future implementation)
- **Delete Safety**: Bots with funds require sweep transaction before deletion
- **Simplified Wallet UI**: Shows Phantom balance, Agent Wallet balance, and Bot Balance (per-subaccount)

### Drift User Account Parsing (Jan 2026)
- **Account Data Size**: ~4376 bytes for User account
- **SpotPositions Array**: Starts at offset 80
- **SpotPosition Struct Size**: 48 bytes per position
- **Key Field Offsets within SpotPosition**:
  - `scaledBalance`: i128 at offset 0 (read lower 64 bits)
  - `marketIndex`: u16 at offset 32
  - `balanceType`: u8 at offset 34 (0 = Deposit, 1 = Borrow)
- **Balance Conversion**: `scaledBalance / SPOT_BALANCE_PRECISION (1e9)` = USDC amount
- **USDC Market Index**: 0
- **Deposit Remaining Accounts Order**: Oracle (readable) MUST come before SpotMarket (writable)

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