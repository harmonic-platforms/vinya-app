# Vinya SaaS Application

A production-ready TypeScript monorepo for a SaaS application built with Next.js, Fastify, and Prisma.

## Tech Stack

- **Frontend**: Next.js 16 (React 18)
- **API**: Fastify
- **Worker**: Node.js with BullMQ (later)
- **Database**: PostgreSQL with Prisma ORM
- **Language**: TypeScript with ESM
- **Build**: Turbopack (Next.js), TypeScript Compiler

## Project Structure

```
vinya-app/
├── apps/
│   ├── web/          # Next.js frontend
│   ├── api/          # Fastify API server
│   └── worker/       # Background worker
├── packages/
│   ├── db/           # Prisma schema & client
│   └── shared/       # Shared types & utilities
└── package.json      # Root workspace config
```

## Setup

### Prerequisites

- Node.js >= 20.9.0 (using nvm recommended)
- PostgreSQL database
- npm >= 9.8.0

### Installation

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your database URL
   ```

3. **Set up database:**
   ```bash
   # Generate Prisma client
   npm run prisma:generate

   # Run database migrations (when ready)
   npx prisma migrate dev
   ```

### Development

Start development servers:

```bash
# Frontend (Next.js)
npm run dev:web

# API (Fastify)
npm run dev:api

# Worker
npm run dev:worker
```

### Building

Build all packages and apps:

```bash
npm run build
```

## Environment Variables

Create a `.env` file with:

```env
DATABASE_URL="postgresql://username:password@localhost:5432/vinya_db"
```

## Scripts

- `npm run bootstrap` - Install dependencies
- `npm run build` - Build all workspaces
- `npm run prisma:generate` - Generate Prisma client
- `npm run dev:web` - Start Next.js dev server
- `npm run dev:api` - Start Fastify API server
- `npm run dev:worker` - Start worker process

## Database Schema

The application includes the following models:

- **Tenant** - Multi-tenant organization
- **User** - User accounts
- **EmailAccount** - Email integrations
- **CrmIntegration** - CRM platform connections

## Notes

- Uses modern ESM throughout
- TypeScript project references for proper compilation order
- Monorepo managed with npm workspaces
- Next.js 16 with Turbopack for fast development