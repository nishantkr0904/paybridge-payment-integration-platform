# Troubleshooting

## Docker daemon is not running

If `docker compose up -d mysql` fails with a Docker socket error, start Docker Desktop and retry.

## MySQL connection fails

Confirm the container is healthy:

```bash
docker compose ps
```

Then test the connection:

```bash
mysql --host=127.0.0.1 --port=3306 --user=paybridge --password=change_me --database=paybridge --execute="SELECT 1;"
```

## JWT configuration fails

The server requires JWT secrets with at least 16 characters:

```bash
JWT_ACCESS_SECRET=change_me_access_secret_at_least_32_chars
JWT_REFRESH_SECRET=change_me_refresh_secret_at_least_32_chars
```

## New schema not applied & Database Migrations

PayBridge uses a versioned TypeScript migration framework (`server/src/infrastructure/migrator.ts`) with SHA-256 checksums and MySQL advisory locking.

Do **not** drop Docker volumes or manually pipe unversioned SQL files. Instead, use the migration CLI:

```bash
# Check current migration status
npm run db:status

# Apply all pending migrations (001 through 006)
npm run db:migrate

# Rollback the last applied migration if necessary
npm run db:rollback
```

If migrating inside Docker, ensure the database container is healthy:
```bash
docker compose exec paybridge-api npm run db:migrate
```

## Docker Stale Container Binary Risk

`docker-compose.yml` builds service containers from `server.Dockerfile` using compiled TypeScript output. **Source directories (`server/src`) are NOT mounted as live development volumes in the worker/API containers.**

If you make TypeScript changes in `server/src/`, running `docker compose restart` will **NOT** pick up new code. You must explicitly trigger a rebuild:

```bash
docker compose up -d --build paybridge-api paybridge-payment-worker paybridge-recovery-worker paybridge-webhook-worker paybridge-action-worker
```

## Action Worker Startup & Lifecycle

The standalone container `paybridge-action-worker` executes `startActionWorker()` to consume recovery action jobs from `payment_processing_queue`.

- Direct CLI execution (`node dist/workers/action.worker.js`) attaches process signal listeners via `createWorkerShutdownHandler` and drains in-flight action executions on `SIGTERM`.
- Verified live running in Docker Compose with consumer tag registration.

## Webhook Delivery & Local Container Networking

`paybridge-webhook-worker` executes asynchronous, non-blocking retries with exponential backoff (1s, 2s, 4s, 8s, 16s up to 5 retries) for transient failures (such as temporary DNS lookup errors or 5xx server responses).

- When a transient webhook delivery failure occurs, the worker immediately acknowledges the message in RabbitMQ (`channel.ack(msg)`) to prevent blocking the channel's prefetch limit, and schedules republishing via a non-blocking background timer. Concurrent and subsequent webhook deliveries process without delay.
- **SSRF Validation & Terminal Failures:** Outbound webhook destinations are validated against SSRF policy at both ingress registration and delivery time. Deterministic policy violations—such as destinations resolving to private IP ranges (RFC 1918), loopback, link-local/cloud metadata (`169.254.169.254`), IPv6 transition ranges (`::/96`, `2002::/16`), plain-HTTP public URLs, unauthorized internal ports, or unexpected HTTP redirects—are treated as terminal failures. The worker updates the delivery status to `failed`, acknowledges the message, and does **not** schedule retries.
- **Local Testing Note:** When registering webhook endpoints for local testing in Docker Compose, do **not** configure `http://localhost:4000/...` as `localhost` is rejected by SSRF validation at both ingress and delivery. Instead, use the internal Docker service address `http://paybridge-api:4000/api/webhooks/test-listener`. This exact host and port is explicitly allowlisted via `WEBHOOK_ALLOWED_INTERNAL_TARGETS=paybridge-api:4000` in `docker-compose.yml`. Other internal hosts, services (such as `paybridge-mysql` or `paybridge-redis`), and unauthorized ports are not automatically allowed and will be blocked by SSRF policy.


## LLM Provider Diagnostics

PayBridge supports multiple LLM providers behind the `LLMProvider` abstraction (`server/src/infrastructure/llm/`):

1. **Mock Provider (`LLM_PROVIDER=mock`)**:
   - Deterministic, zero-cost, zero-network fallback used by default in CI and automated test suites.
2. **OmniRoute (`LLM_PROVIDER=omniroute`)**:
   - Live-certified on 2026-09-07 via `npm run demo:llm -- --omniroute`.
   - Requires valid OmniRoute credentials in the environment.
   - Diagnoses via `antigravity/gemini-3.6-flash-low` and plans via `antigravity/gemini-3.1-pro-low`.
3. **OpenAI (`LLM_PROVIDER=openai`)**:
   - Verified via automated unit tests (`openai-provider.test.ts`, 32 tests).
   - Requires `OPENAI_API_KEY`. If missing, the demo harness refuses live execution with a clear diagnostic message.
4. **OpenRouter (`HTTP 402 Payment Required`)**:
   - Indicates insufficient balance/credits on the configured OpenRouter account. The circuit breaker trips or the system falls back to deterministic rules.
5. **Gemini (`HTTP 429 Too Many Requests`)**:
   - Indicates rate limiting or API quota exhaustion. The system executes exponential backoff or fails open to `rules.fallback.ts`.

## Payment returns ORDER_NOT_FOUND

Ensure the order reference in the URL matches a valid `order_ref` from the `orders` table.

Order references are 26-character ULID strings returned in the `orderRef` field when creating an order.

## Payment returns ORDER_ALREADY_PAID

A successfully paid order cannot be paid again. Create a new order to process another payment.

Failed orders can be retried with any payment method.

## Dashboard shows zero counts

If the dashboard summary tiles show all zeros despite having processed payments, verify:

1. The merchant is logged in with the same account that created the orders.
2. The server is running and connected to MySQL.
3. The `/api/merchants/me` endpoint returns real counts (not hardcoded zeros from Version 1).
