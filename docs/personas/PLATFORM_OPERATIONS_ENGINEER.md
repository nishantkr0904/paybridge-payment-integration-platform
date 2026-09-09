# Platform Operations Engineer

## 1. Persona Definition
- **Role:** Platform Operations Engineer (exemplified by Meera, Site Reliability Engineer / Infrastructure Lead).
- **Primary Responsibility:** Ensuring end-to-end platform health, message broker throughput, worker process availability, database connection pool stability, dead-letter queue (DLQ) triage, agent observability, emergency load shedding, and incident mitigation across all tenants.
- **Primary Objectives:**
  - Maintain 99.9% uptime for core checkout and payment API ingestion.
  - Monitor RabbitMQ queue depths (`payment_processing_queue`, `recovery_ingestion_queue`, `webhook_queue`, `retry_delay_holding_queue`, `payment_dlq`) and prevent consumer starvation.
  - Triage dead-lettered messages in `payment_dlq` and execute controlled re-queueing or discard.
  - Inspect unredacted, unmasked agent reasoning traces across tenants during system degradation or model misbehavior incidents.
  - Trigger deterministic trace replays to verify whether an agent failure was transient or systematic.
  - Operate platform-wide containment mechanisms: emergency recovery kill switches, worker lifecycle terminations, and backlog load shedding.
- **Primary PayBridge Value:** Guarantees platform-level SLOs, fault tolerance, non-blocking queue processing, and automated failover for multi-tenant payment and recovery pipelines.

## 2. Authentication and Authorization Requirements
- **Authentication Required:** Dedicated platform operator credentials with elevated session claims (separate from standard merchant accounts).
- **Intended Role:** `platform_operator` (or `platform_admin`).
- **Intended Permissions:**
  - `ops:read`, `ops:metrics_read`, `ops:health_read`
  - `ops:traces_unmasked_read`, `ops:trace_replay`
  - `ops:dlq_manage`, `ops:dlq_replay`
  - `ops:kill_switch`, `ops:load_shed`
- **Tenant / Merchant Isolation Requirements:**
  - The Platform Operations Engineer role is **cross-tenant by design** for infrastructure surveillance, message broker operations, and trace debugging.
  - Cross-tenant visibility must be strictly confined to authenticated operators and never leak into merchant-facing scopes.
- **Sensitive Actions Requiring Authorization:**
  - Inspecting unmasked agent reasoning traces (containing internal prompts, model parameters, and raw provider payloads).
  - Triggering deterministic trace replays (`POST /api/v1/ops/agent-traces/:traceRef/replay`).
  - Executing recovery backlog load shedding (`POST /api/merchants/recovery/shed`).
  - Replaying or purging dead-letter queues.
  - Engaging platform-wide or per-merchant emergency kill switches.
- **Target vs. Current Implementation:**
  - *Target:* Hard RBAC barrier gating `/api/v1/ops/*` behind `requireRole('platform_operator')`. Zero merchant access to operator APIs.
  - *CRITICAL CURRENT SECURITY VULNERABILITY (DOCUMENTED FACT):*  
    In the current codebase, [`traceRouter`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/tracing/trace.routes.ts#L12) is mounted at `/api/v1/ops/agent-traces` (and `/api/ai/traces`) and protected ONLY by `authenticate` middleware ([`authenticate.ts`](file:///Users/nishant/Documents/PayBridge/server/src/middleware/authenticate.ts#L5-L20)).  
    No `platform_operator` role exists in the database schema ([`001_auth_schema.up.sql`](file:///Users/nishant/Documents/PayBridge/database/migrations/001_auth_schema.up.sql#L49-L51) only seeds `'merchant'`).  
    Operator trace routes currently lack role authorization and tenant scoping: neither `getOperatorTrace(traceRef)` nor `findTracesByCaseId(caseId)` verifies merchant tenancy.  
    **As a result, sequential `by-case/:caseId` access allows cross-tenant trace enumeration, and any merchant user holding a standard merchant JWT can inspect unredacted system prompts, user prompts, raw responses, and tool data across all merchants. This is a current authorization/security gap, not an implemented platform-operator-only surface. Provider API keys are NOT stored in trace tables.**

## 3. Entry Point and Navigation
- **Intended Entry Point:** Authentication via an administrative portal or `/ops` landing page with role-gated access, leading to the Platform Fleet Overview.
- **Current Navigation:**
  - **0% Frontend UI.** No operations route exists in `client/src/App.tsx`.
  - All operations are currently performed out-of-band via:
    - Prometheus Web UI (`http://localhost:9090`)
    - Grafana Web UI (`http://localhost:3000`)
    - RabbitMQ Management Console (`http://localhost:15672`)
    - Docker CLI (`docker compose logs`, `docker compose ps`)
    - Raw REST endpoints (`http://localhost:4000/api/health`, `/metrics`, `/api/v1/ops/*`)
- **Target Navigation:**
  - Dedicated Operations Console (`/ops`) navigation:
    - `Fleet Overview` (overall service health, latency percentiles, error rates)
    - `Queue & DLQ Console` (broker queue depths, consumer counts, DLQ triage)
    - `Agent Telemetry` (model provider latency, token usage, fallback counts)
    - `Trace Inspector & Replay` (unmasked trace viewer with step diffs)
    - `Runtime Controls` (kill switches, circuit breakers, load shedding)

## 4. End-to-End Workflow
1. **Health Surveillance and Metric Scraping:**
   - Operator monitors `/api/health` and Prometheus metrics scraped at `/metrics`.
   - Prometheus collects process metrics and application metrics (`paybridge_recovery_rate`, `paybridge_recovery_duration_seconds`, `paybridge_recovery_revenue_recovered_minor_units_total`).
   - Status: **VERIFIED CURRENT** ([`app.ts:45-63`](file:///Users/nishant/Documents/PayBridge/server/src/app.ts#L45-L63), [`recovery.metrics.ts`](file:///Users/nishant/Documents/PayBridge/server/src/infrastructure/metrics/recovery.metrics.ts)).
2. **Queue and Broker Health Inspection:**
   - Operator checks RabbitMQ broker queue depths via RabbitMQ Management UI on port 15672.
   - Operator inspects `payment_processing_queue`, `recovery_ingestion_queue`, `webhook_queue`, and `payment_dlq`.
   - Status: **VERIFIED CURRENT out-of-band** (Docker Compose service `paybridge-rabbitmq` on port 15672; no frontend UI in PayBridge client).
3. **Dead-Letter Queue (DLQ) Triage and Replay:**
   - When messages accumulate in `payment_dlq`, operator inspects message headers (e.g. `x-death`, rejection reason) and replays or discards messages.
   - Status: **TARGET / MISSING in web UI** (Managed manually via RabbitMQ Management shovel or CLI).
4. **Investigating Agent Reasoning Failures (Trace Inspection):**
   - Operator receives an alert regarding anomalous recovery decisions or unhandled agent terminations.
   - Operator fetches full raw trace via `GET /api/v1/ops/agent-traces/:traceRef` to inspect `system_prompt`, `user_prompt`, `raw_response`, `parsed_output`, tool invocations/arguments/results, token metrics, and execution latencies (provider API keys are NOT stored in trace tables).
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** (Endpoint [`trace.routes.ts:15-22`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/tracing/trace.routes.ts#L15-L22) exists, but has no UI and suffers from the authorization/tenant scoping gap documented in Section 2).
5. **Deterministic Trace Replay Execution:**
   - Operator issues `POST /api/v1/ops/agent-traces/:traceRef/replay` to re-execute the exact prompt context against the decision agent and verify output divergence.
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** ([`trace.routes.ts:25-32`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/tracing/trace.routes.ts#L25-L32)).
6. **Executing Recovery Backlog Load Shedding:**
   - When recovery queue exceeds capacity, operator invokes `POST /api/merchants/recovery/shed` with `{ capacityLimit: 1000 }` to shed stale backlog cases.
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** ([`merchant.routes.ts:291-302`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L291-L302)).
7. **Emergency Kill Switch Engagement:**
   - Operator engages a global kill switch to pause all autonomous recovery actions across the platform during severe upstream provider outages.
   - Status: **TARGET / MISSING** (Conceptual requirement in requirements doc; no endpoint or UI exists).

## 5. Screens and Surfaces
1. **PayBridge Client Web Application (`client/`):**
   - *Status:* **MISSING (0% implemented).**
   - *Current Reality:* There are no operations routes, components, or screens in `client/src/`.
2. **Prometheus Web UI (`http://localhost:9090`):**
   - *Status:* Infrastructure-verified out-of-band.
   - *Key Information / Actions:* Time-series metrics query interface, scrape target health.
3. **Grafana Dashboards (`http://localhost:3000`):**
   - *Status:* Infrastructure-verified out-of-band.
   - *Key Information / Actions:* Provisioned datasource, visual dashboards for service metrics.
4. **RabbitMQ Management Console (`http://localhost:15672`):**
   - *Status:* Infrastructure-verified out-of-band.
   - *Key Information / Actions:* Queue depths, unacknowledged messages, consumer channels, DLQ bindings.
5. **Operations Console Web UI (`/ops`):**
   - *Status:* **Target Surface (Missing).**
   - *Target Routes:* `/ops/overview`, `/ops/queues`, `/ops/traces`, `/ops/controls`.
   - *Key Information / Actions:* Live queue metrics, DLQ message inspection/replay, operator trace viewer, deterministic replay trigger, emergency kill switch.

## 6. Backend APIs and Services
1. `GET /api/health`
   - *Module / Service:* `server/src/app.ts:45-51`, `shutdown.ts`
   - *Purpose:* Liveness and readiness probe reporting service status (`ok` or `shutting_down`).
   - *Frontend Consumption:* **NOT Consumed** (Used by Docker/k8s/healthcheck probes).
2. `GET /metrics` & `GET /api/metrics`
   - *Module / Service:* `server/src/app.ts:53-63`, `server/src/infrastructure/metrics.ts`
   - *Purpose:* Serves Prometheus-formatted metrics text.
   - *Frontend Consumption:* **NOT Consumed** (Scraped by Prometheus).
3. `GET /api/v1/ops/agent-traces/:traceRef`
   - *Module / Service:* `server/src/modules/ai/tracing/trace.routes.ts:15-22`, `trace.service.ts`
   - *Purpose:* Fetches full unredacted agent trace including `system_prompt`, `user_prompt`, `raw_response`, `parsed_output`, tool invocations/arguments/results, token metrics, and latencies (provider API keys are NOT stored in trace tables).
   - *Frontend Consumption:* **NOT Consumed** (No UI exists).
4. `POST /api/v1/ops/agent-traces/:traceRef/replay`
   - *Module / Service:* `server/src/modules/ai/tracing/trace.routes.ts:25-32`, `trace.service.ts`
   - *Purpose:* Deterministically replays trace execution against the LLM decision engine.
   - *Frontend Consumption:* **NOT Consumed** (No UI exists).
5. `GET /api/v1/ops/agent-traces/by-case/:caseId` & `GET /api/v1/ops/agent-traces/by-correlation/:correlationId`
   - *Module / Service:* `server/src/modules/ai/tracing/trace.routes.ts:35-53`, `trace.service.ts`
   - *Purpose:* Retrieves traces grouped by case ID or correlation ID (currently lacks role authorization and tenant scoping, permitting cross-tenant enumeration).
   - *Frontend Consumption:* **NOT Consumed** (No UI exists).
6. `GET /api/merchants/recovery/metrics`
   - *Module / Service:* `server/src/modules/merchant/merchant.routes.ts:279-288`, `case.service.ts`
   - *Purpose:* Returns recovery queue depth, oldest message age, and shed volume.
   - *Frontend Consumption:* **NOT Consumed** (No UI exists).
7. `POST /api/merchants/recovery/shed`
   - *Module / Service:* `server/src/modules/merchant/merchant.routes.ts:291-302`, `case.service.ts`
   - *Purpose:* Sheds excess backlog when queue exceeds declared capacity limit.
   - *Frontend Consumption:* **NOT Consumed** (No UI exists).

## 7. Data Visible to the Persona
- **Currently Exposed Data (Out-of-Band & APIs):**
  - Prometheus metrics: event loop lag, process memory/CPU, HTTP request durations, recovery rates, revenue recovered totals.
  - RabbitMQ stats: message counts, queue depths, message ingress/egress rates, consumer counts.
  - Health status: service lifecycle state (`ok`, `shutting_down`).
  - Operator traces: trace reference, case ID, correlation ID, agent type (`diagnosis`, `decision`, `multi_agent`), status, total and step duration ms, token metrics (input/output tokens), `system_prompt`, `user_prompt`, `raw_response`, `parsed_output`, tool invocations, arguments, and results (provider API keys are NOT stored in trace tables).
- **Target Data (Not Yet Exposed in UI):**
  - Unified cross-tenant fleet overview dashboard.
  - Real-time DLQ message payload inspection.
  - Active kill switch and circuit-breaker status across model providers.
- **Sensitive Data Requiring Strict Authorization:**
  - Raw prompts, raw responses, and tool data (which may contain sensitive customer context or internal system prompts; provider API keys are NOT stored in trace tables).
  - Internal model configuration and system architecture prompts.
  - Cross-tenant payment references and correlation IDs.

## 8. Allowed Actions
- `ops:health_read` — View service health status (*currently possible out-of-band*).
- `ops:metrics_read` — Scrape and query Prometheus metrics (*currently possible out-of-band*).
- `ops:broker_read` — View RabbitMQ queue depths and exchange bindings (*currently possible out-of-band*).
- `ops:traces_read` — View unmasked operator traces (*backend-only; accessible via API*).
- `ops:trace_replay` — Trigger deterministic trace replay (*backend-only; accessible via API*).
- `ops:load_shed` — Execute recovery backlog load shedding (*backend-only; accessible via API*).
- `ops:dlq_replay` — Replay dead-lettered messages (*target-only*).
- `ops:kill_switch` — Engage emergency platform kill switch (*target-only*).

## 9. Forbidden / Restricted Actions
- **Merchant Checkout Transactions:** Must NOT create live checkout orders or initiate real customer payment captures.
- **Merchant Business Recovery Decisions:** Must NOT approve or reject individual business recovery proposals in place of the merchant operator.
- **Webhook Modification:** Must NOT alter merchant webhook destination URLs or delete merchant configurations.
- **Standard Merchant Access Exclusion:** Standard merchant users must be strictly forbidden from accessing any `/api/v1/ops/*` endpoint. *(Currently violated in backend)*.

## 10. Current Implementation Status
- **Overall Persona Status:** `MISSING` (for frontend UI) / `BACKEND-ONLY` (for trace and shedding APIs) / `IMPLEMENTED` (for out-of-band infrastructure).
  - Health & Metrics Endpoints: `IMPLEMENTED`.
  - Infrastructure Services (Prometheus, Grafana, RabbitMQ): `IMPLEMENTED`.
  - Operator Trace Inspection & Replay API: `BACKEND-ONLY` (with critical authorization flaw).
  - Load Shedding API: `BACKEND-ONLY`.
  - Operations Console Web UI: `MISSING` (0% client UI).
  - Role-Based Authorization Enforcement: `MISSING`.

## 11. Missing Implementation
- **Frontend Gaps:**
  - Entire Operations Console (`/ops`): Fleet Overview, Queue Depth Monitor, Trace Inspector, Replay Controls, and Kill Switch panel.
- **Backend / Authentication / Authorization Gaps:**
  - **Urgent Fix:** Introduce `platform_operator` role and restrict `/api/v1/ops/*` with `requireRole('platform_operator')`.
  - Implement DLQ management endpoints (`GET /api/v1/ops/dlq`, `POST /api/v1/ops/dlq/replay`, `DELETE /api/v1/ops/dlq`).
  - Implement platform kill switch endpoints (`POST /api/v1/ops/kill-switch`, `GET /api/v1/ops/kill-switch`).
- **Data / API Gaps:**
  - RabbitMQ Management API proxy to allow the web frontend to query queue depths safely without direct broker credentials.
- **Operational / Security Gaps:**
  - Hardening operator trace endpoints to prevent cross-tenant exposure to non-operator users.

## 12. Smallest Implementation Slice
- **Security Step (Prerequisite):** Protect `/api/v1/ops/*` with a temporary API secret or `requireRole('platform_operator')` check so merchant tokens cannot access it.
- **Frontend Scope:** Build a minimal, read-only `/ops/traces` screen in the client accessible only to operators:
  1. Displays recent agent execution traces across cases.
  2. Clicking a trace renders steps, token counts, and execution latency.
  3. Includes a "Replay Trace" button calling `POST /api/v1/ops/agent-traces/:traceRef/replay`.

## 13. Acceptance Criteria
- [ ] Only users authenticated with the `platform_operator` role can access `/api/v1/ops/*` or `/ops` UI.
- [ ] Standard merchant accounts receive `403 AUTH_FORBIDDEN` when attempting to access any operator endpoint.
- [ ] Operator can view raw execution steps, latencies, and token counts for any agent trace reference.
- [ ] Operator can trigger deterministic trace replay and observe replay result comparisons.
- [ ] Operator can monitor real-time queue depths across all RabbitMQ queues.
- [ ] Engaging the emergency kill switch halts all background recovery workers within 5 seconds.
- [ ] All operator interventions are recorded in the audit trail with `actor_type = 'platform_operator'`.

## 14. Dependencies
- **RBAC / Permissions (Proposed):** `platform_operator` role and `requireRole` middleware (`AUTH-003`).
- **Backend APIs (Verified):** `server/src/modules/ai/tracing/trace.routes.ts`, `server/src/app.ts`.
- **Operational Infrastructure (Verified):** RabbitMQ broker, Prometheus scraper, Docker containers.

## 15. Evidence / Source Notes
- Operator trace routes: [`server/src/modules/ai/tracing/trace.routes.ts:1-54`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/tracing/trace.routes.ts#L1-L54).
- Operator trace service & replay: [`server/src/modules/ai/tracing/trace.service.ts:1-160`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/tracing/trace.service.ts#L1-L160).
- Health and metrics endpoints: [`server/src/app.ts:45-63`](file:///Users/nishant/Documents/PayBridge/server/src/app.ts#L45-L63).
- Queue metrics & shedding: [`server/src/modules/merchant/merchant.routes.ts:279-302`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L279-L302).
- Client routing inspection: [`client/src/App.tsx:30-39`](file:///Users/nishant/Documents/PayBridge/client/src/App.tsx#L30-L39) (confirms 0% operations routes exist in client).
