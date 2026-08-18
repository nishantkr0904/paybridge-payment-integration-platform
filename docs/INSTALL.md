# Installation

## Prerequisites

- Node.js 20 or later
- npm
- Docker Desktop for local MySQL

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d mysql
```

MySQL loads SQL files from `database/` when the volume is created for the first time.

Schema files are applied in alphabetical order:

1. `001_auth_schema.sql` — users, roles, refresh tokens
2. `002_payment_schema.sql` — orders, transactions

If you add a new schema file after the volume already exists, either:

- Reset the volume: `docker compose down -v && docker compose up -d mysql`
- Apply manually: `docker exec -i paybridge-mysql mysql -upaybridge -pchange_me paybridge < database/<filename>.sql`

## Run Locally

```bash
npm run dev:server
npm run dev:client
```

Server: `http://localhost:4000`

Client: `http://localhost:5173`
