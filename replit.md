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
- **Tables**: users, wallets, bots, tradingBots, botTrades, webhookLogs, subscriptions, portfolios, positions, trades, leaderboardStats
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

### Funds Management System
- **Drift Subaccounts**: Each trading bot operates on its own isolated Drift subaccount (1, 2, 3, etc.)
- **Main Account**: Subaccount 0 is the user's main Drift account for deposits/withdrawals
- **Capital Flow**:
  1. Deposit: Wallet → Main Account (subaccount 0)
  2. Allocate: Main Account → Bot Subaccount
  3. Deallocate: Bot Subaccount → Main Account
  4. Withdraw: Main Account → Wallet
- **Delete Safety**: Bots with funds require sweep transaction before deletion
- **Legacy Bots**: Old bots with agent wallets show "Migration needed" warning
- **Capital Pool UI**: Shows total equity, main account balance, and per-bot allocations

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
- `SOLANA_RPC_URL`: Solana RPC endpoint (optional, defaults to mainnet)

### Drift Protocol Testnet Configuration
- **Network**: Solana Devnet
- **USDC Token Mint**: `8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2`
- **Usage**: For deposits/withdrawals on Drift testnet

### Frontend Libraries
- **UI Components**: Full shadcn/ui component set with Radix UI primitives
- **Forms**: React Hook Form with Zod validation (`@hookform/resolvers`)
- **Charts**: Recharts for data visualization