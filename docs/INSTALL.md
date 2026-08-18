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

## Run Locally

```bash
npm run dev:server
npm run dev:client
```

Server: `http://localhost:4000`

Client: `http://localhost:5173`
