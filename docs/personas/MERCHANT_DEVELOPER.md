# Merchant Developer

## 1. Persona Definition
- **Role:** Merchant Developer (exemplified by Arjun, software engineer integrating PayBridge into merchant systems).
- **Primary Responsibility:** Implementing checkout integrations, configuring and verifying webhook event subscriptions, managing cryptographic webhook signing secrets, testing failure and recovery event flows, managing API credentials, and ensuring request idempotency.
- **Primary Objectives:**
  - Reliably receive real-time webhook events for order status changes (`payment.succeeded`, `payment.failed`, `recovery.started`, `recovery.completed`).
  - Verify webhook HMAC SHA-256 signatures (`x-paybridge-signature`) using the assigned signing secret.
  - Diagnose webhook delivery failures using detailed HTTP response codes and payload traces.
  - Re-trigger failed webhook deliveries on demand during local or staging development.
  - Consult authoritative OpenAPI 3.1 specifications and test requests against the simulator.
- **Primary PayBridge Value:** Provides robust developer tooling, clear cryptographic signature contracts, ingress SSRF protection, deterministic failure simulations, and interactive API documentation.

## 2. Authentication and Authorization Requirements
- **Authentication Required:**
  - Developer portal UI: Username/password authentication returning JWT bearer token pair.
  - Server-to-server API integrations: Machine API keys (`pb_live_...` / `pb_test_...`) passed in the `Authorization: Bearer <apiKey>` header.
- **Intended Role:** `merchant_developer` (or `merchant_admin`).
- **Intended Permissions:**
  - `webhooks:read`, `webhooks:create`, `webhooks:update`, `webhooks:delete`
  - `webhooks:deliveries_read`, `webhooks:replay`
  - `api_keys:read`, `api_keys:create`, `api_keys:revoke`
  - `docs:read`
- **Tenant / Merchant Isolation Requirements:**
  - Strict tenant isolation: developers can only see and configure webhook endpoints and delivery logs associated with their own `merchant_id`.
  - Ingress URL validation must prevent developers from registering internal or reserved network targets (SSRF protection).
- **Sensitive Actions Requiring Authorization:**
  - Revealing webhook signing secrets (`whsec_...`).
  - Registering or disabling webhook URLs.
  - Triggering manual webhook delivery replays (`POST /api/webhooks/deliveries/:id/retry`).
  - Provisioning or revoking server-to-server API keys.
- **Target vs. Current Implementation:**
  - *Target:* Dedicated `merchant_developer` role permitted to manage webhooks and API keys, but barred from approving financial recovery actions or modifying risk policies.
  - *Current Reality:* Only coarse tenant authentication exists via `authenticate` middleware. No `merchant_developer` role exists in the database. Any user with a merchant login can access `/developers`, view and reveal signing secrets, and add webhook endpoints. Server-to-server API keys are completely unbuilt in both schema and UI.

## 3. Entry Point and Navigation
- **Intended Entry Point:** Authentication at `/login`, landing on `/dashboard`, then selecting the `Developers` tab to access the Developer Portal (`/developers`).
- **Current Navigation:**
  - Navigation button `Developers` exists in [`DashboardPage.tsx:50-55`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DashboardPage.tsx#L50-L55) and [`DeveloperPage.tsx:71-73`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L71-L73).
  - Navigation header is omitted on `/payments` pages.
  - Interactive Swagger UI is hosted at `http://localhost:4000/api-docs`, but no navigation link connects the React client to `/api-docs`.
- **Target Navigation:**
  - Developer Portal sub-navigation inside `<AppShell />` with tabs:
    - `Webhooks` (endpoints, signing secrets, delivery history)
    - `API Keys` (key provisioning, scoping, rotation)
    - `API Explorer` (embedded Swagger / OpenAPI documentation)
    - `Event Simulator & Sandbox` (testing failure and recovery events)

## 4. End-to-End Workflow
1. **Accessing Developer Portal:**
   - Developer logs in and navigates to `/developers`.
   - Status: **VERIFIED CURRENT** ([`DeveloperPage.tsx:9-85`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L9-L85)).
2. **Registering Webhook Endpoint:**
   - Developer submits endpoint URL (e.g. `https://merchant.example.com/webhooks`).
   - Ingress SSRF validator blocks localhost, loopback, private IPs, and plain-HTTP targets.
   - Endpoint record is created with auto-generated signing secret (`whsec_...`).
   - Status: **VERIFIED CURRENT** ([`DeveloperPage.tsx:99-115`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L99-L115), server route [`webhook.routes.ts:46-56`](file:///Users/nishant/Documents/PayBridge/server/src/modules/webhook/webhook.routes.ts#L46-L56)).
3. **Retrieving HMAC Signing Secret:**
   - Developer clicks `Reveal` next to the masked secret (`whsec_••••••••`). Secret unmasks in monospace text.
   - Developer copies secret into their local application to verify `x-paybridge-signature`.
   - Status: **VERIFIED CURRENT** ([`DeveloperPage.tsx:138-148`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L138-L148)).
4. **Monitoring Webhook Deliveries:**
   - Developer initiates a payment in `/payments/new` or via API to trigger events.
   - Developer observes recent deliveries table in `/developers` polling every 5 seconds (`GET /api/webhooks/deliveries`).
   - Table displays event type, delivery status (`success` / `failed`), HTTP response status (e.g. `200`, `500`), and timestamp.
   - Status: **VERIFIED CURRENT** ([`DeveloperPage.tsx:173-228`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L173-L228)).
5. **Inspecting Delivery Payload and Response Details:**
   - Developer clicks on a failed delivery row to inspect the outbound JSON payload, HTTP headers sent, and the remote server's response body.
   - Status: **TARGET / MISSING** (Deliveries table displays only event type and status code; no inspection modal or payload drawer exists in the frontend).
6. **Triggering Manual Webhook Replay:**
   - Developer clicks "Retry Delivery" on a failed webhook delivery row.
   - Frontend calls `POST /api/webhooks/deliveries/:id/retry`. Worker re-dispatches delivery task.
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** (The endpoint [`POST /api/webhooks/deliveries/:id/retry`](file:///Users/nishant/Documents/PayBridge/server/src/modules/webhook/webhook.routes.ts#L67-L85) is fully implemented and tested in the backend, but the frontend has no retry button).
7. **Provisioning Server-to-Server API Keys:**
   - Developer generates a scoped API key with a label and optional expiry.
   - Status: **TARGET / MISSING** (API keys do not exist in database schema or UI).
8. **Consulting API Documentation:**
   - Developer accesses OpenAPI documentation at `/api-docs` to view schemas and endpoints.
   - Status: **PARTIALLY IMPLEMENTED** (Served out-of-band by Express via [`app.ts:74-86`](file:///Users/nishant/Documents/PayBridge/server/src/app.ts#L74-L86); not linked or embedded in client SPA).

## 5. Screens and Surfaces
1. **Developer Portal (`/developers`):**
   - *Status:* Implemented-but-not-verified by automated frontend test.
   - *Route / Component:* `/developers` / [`DeveloperPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx).
   - *Key Information / Actions:* URL registration form, endpoints table with secret reveal/hide toggle, recent deliveries table with 5s polling.
2. **Interactive OpenAPI / Swagger UI (`/api-docs`):**
   - *Status:* Live-verified out-of-band on port 4000.
   - *Route / Component:* `http://localhost:4000/api-docs` (Express `swagger-ui-express`).
   - *Key Information / Actions:* Full interactive OpenAPI 3.1 documentation for all public endpoints.
3. **Webhook Delivery Detail Modal:**
   - *Status:* **Target Screen (Missing in Frontend).**
   - *Target Component:* Modal or drawer inside `DeveloperPage.tsx`.
   - *Key Information / Actions:* Formatted JSON payload, headers, response status, response body, retry button.
4. **API Key Management Tab:**
   - *Status:* **Target Screen (Missing in Frontend & Backend).**
   - *Target Route / Component:* `/developers/api-keys`.
   - *Key Information / Actions:* List active keys, generate new key (one-time reveal), revoke key.

## 6. Backend APIs and Services
1. `POST /api/webhooks/endpoints`
   - *Module / Service:* `server/src/modules/webhook/webhook.routes.ts`, `webhook.service.ts`
   - *Purpose:* Registers new webhook endpoint with ingress SSRF validation.
   - *Frontend Consumption:* **Consumed** by [`DeveloperPage.tsx:27-39`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L27-L39).
2. `GET /api/webhooks/endpoints`
   - *Module / Service:* `server/src/modules/webhook/webhook.routes.ts`, `webhook.service.ts`
   - *Purpose:* Lists configured webhook endpoints for merchant.
   - *Frontend Consumption:* **Consumed** by [`DeveloperPage.tsx:16-19`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L16-L19).
3. `GET /api/webhooks/deliveries`
   - *Module / Service:* `server/src/modules/webhook/webhook.routes.ts`, `webhook.service.ts`
   - *Purpose:* Returns recent webhook delivery attempts for merchant.
   - *Frontend Consumption:* **Consumed** by [`DeveloperPage.tsx:21-25`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L21-L25).
4. `POST /api/webhooks/deliveries/:id/retry`
   - *Module / Service:* `server/src/modules/webhook/webhook.routes.ts:67-85`, `webhook.service.ts`
   - *Purpose:* Re-enqueues failed delivery to RabbitMQ after verifying tenant ownership.
   - *Frontend Consumption:* **NOT Consumed** (Fully implemented in backend; uncalled by client).
5. `/api-docs`
   - *Module / Service:* `server/src/app.ts:74-86`, `swagger-ui-express`, `docs/openapi.yaml`
   - *Purpose:* Serves Swagger UI documentation.
   - *Frontend Consumption:* **NOT Consumed** (Unlinked from React SPA).
6. Missing Backend Capabilities:
   - Server-to-server API key management endpoints (`POST /api/api-keys`, `GET /api/api-keys`, `DELETE /api/api-keys/:id`).
   - Detailed single-delivery retrieval endpoint returning raw outbound payload and response body (`GET /api/webhooks/deliveries/:id`).

## 7. Data Visible to the Persona
- **Currently Exposed Data:**
  - Webhook endpoint URL, endpoint ID, active status badge, creation timestamp.
  - Webhook signing secret (masked by default, revealed on click).
  - Recent delivery summary: delivery ID, event type, delivery status, HTTP status code, timestamp.
  - Interactive API schemas, parameters, and responses on `/api-docs`.
- **Target Data (Not Yet Exposed in UI):**
  - Full delivery request payload JSON and request headers.
  - Server response headers and response body text.
  - API key metadata: key prefix, creation date, last used timestamp, status.
- **Sensitive Data Requiring Authorization:**
  - Webhook signing secrets: must only be visible to authenticated developers of that specific merchant.
  - API key secret tokens: visible only once upon generation.

## 8. Allowed Actions
- `webhooks:read` — View webhook endpoints and delivery history (*currently possible*).
- `webhooks:create` — Register new webhook endpoint (*currently possible*).
- `webhooks:reveal_secret` — View unmasked signing secret (*currently possible*).
- `webhooks:replay` — Manually retry a failed delivery (*backend-only, target UI*).
- `webhooks:inspect_payload` — View payload and response details (*target-only*).
- `webhooks:test_ping` — Dispatch a synthetic test webhook (*target-only*).
- `api_keys:manage` — Generate and revoke API keys (*target-only*).

## 9. Forbidden / Restricted Actions
- **Cross-Tenant Webhooks:** Must not access, modify, or replay webhook endpoints or deliveries belonging to another merchant. *(Enforced in backend queries via `merchant_id = req.user.id`)*.
- **SSRF Target Registration:** Must not register webhook URLs resolving to internal, loopback, link-local, private IP addresses, or non-allowlisted plain HTTP ports. *(Enforced at ingress by `validateWebhookUrlIngress` in `webhook.routes.ts:50`)*.
- **Financial / Risk Policy Modification:** Developer must not approve recovery actions, modify merchant quiet hours, or change spend budgets. *(Currently unenforced; requires RBAC)*.
- **Platform Operations:** Must not access Prometheus metrics, RabbitMQ admin, or operator traces. *(Currently enforced by network isolation, except for the operator trace authorization and tenant scoping gap)*.

## 10. Current Implementation Status
- **Overall Persona Status:** `PARTIALLY IMPLEMENTED`
  - Webhook URL Registration: `IMPLEMENTED` (with SSRF validation).
  - Signing Secret Management: `IMPLEMENTED` (toggleable reveal/hide).
  - Webhook Delivery Polling: `IMPLEMENTED` (5s interval table).
  - Manual Delivery Replay: `BACKEND-ONLY` (endpoint exists, zero frontend UI).
  - Delivery Payload Inspection: `MISSING`.
  - API Key Management: `MISSING` (schema and UI unbuilt).
  - API Documentation: `PARTIALLY IMPLEMENTED` (Swagger UI runs on port 4000; unlinked from UI).

## 11. Missing Implementation
- **Frontend Gaps:**
  - Manual retry button on failed delivery rows in `DeveloperPage.tsx`.
  - Delivery payload and response body inspection modal/drawer.
  - In-app navigation link from `/developers` to `/api-docs`.
  - API Key management tab/screen.
- **Backend / Authentication / Authorization Gaps:**
  - Database schema: create `api_keys` table with hashed token storage (`pb_live_...`).
  - Implement API key authentication strategy in backend.
  - Enforce `requirePermission('webhooks:manage')` so non-developer roles cannot alter webhooks or view secrets.
- **Data / API Gaps:**
  - Endpoint to fetch full payload and response body for a single delivery (`GET /api/webhooks/deliveries/:id`).
  - Endpoint to trigger synthetic test webhook ping (`POST /api/webhooks/endpoints/:id/test`).
- **Operational / Security Gaps:**
  - Rate limiting on webhook delivery retry endpoint to prevent worker flooding.

## 12. Smallest Implementation Slice
- **Scope:** Enhance `DeveloperPage.tsx` with:
  1. A "Retry" button on failed delivery rows calling existing `POST /api/webhooks/deliveries/:id/retry`.
  2. A "View Payload" modal displaying the JSON payload already returned in delivery records.
  3. An external link button in the header pointing to `http://localhost:4000/api-docs`.
- **Capabilities Delivered:**
  - Developer can test, inspect, and replay webhook events directly without leaving the portal.
- **Backend Authorization Required:** None for initial slice beyond existing `authenticate` session, though `merchant_developer` role should be planned.

## 13. Acceptance Criteria
- [ ] Developer must authenticate with valid merchant credentials to access `/developers`.
- [ ] Submitting an invalid or private URL (e.g. `http://127.0.0.1:8080/hook`) is rejected with a descriptive SSRF error.
- [ ] Registering a valid public HTTPS URL succeeds and displays a masked signing secret.
- [ ] Clicking "Reveal" displays the full plaintext signing secret (`whsec_...`).
- [ ] Recent deliveries table updates automatically or on refresh when new payment events occur.
- [ ] Clicking "Retry" on a failed delivery dispatches the redelivery task and updates delivery status.
- [ ] Developer cannot access or replay webhooks belonging to a different merchant tenant.
- [ ] In-app link correctly opens the interactive OpenAPI documentation (`/api-docs`).

## 14. Dependencies
- **RBAC / Permissions (Proposed):** `merchant_developer` role and `webhooks:manage` permission.
- **Backend APIs (Verified):** `server/src/modules/webhook/webhook.routes.ts`.
- **Frontend Shared Infrastructure (Proposed):** Unified `<AppShell />` navigation (`MDB-001`).
- **Operational Infrastructure (Verified):** RabbitMQ `webhook_queue`, `webhook.worker.ts`.

## 15. Evidence / Source Notes
- Developer portal UI: [`client/src/pages/DeveloperPage.tsx:1-233`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DeveloperPage.tsx#L1-L233).
- Webhook client API: [`client/src/api/webhook.ts:1-37`](file:///Users/nishant/Documents/PayBridge/client/src/api/webhook.ts#L1-L37).
- Backend webhook routes & manual retry: [`server/src/modules/webhook/webhook.routes.ts:1-86`](file:///Users/nishant/Documents/PayBridge/server/src/modules/webhook/webhook.routes.ts#L1-L86).
- Webhook SSRF validation: [`server/src/modules/webhook/webhook.ssrf.ts:1-125`](file:///Users/nishant/Documents/PayBridge/server/src/modules/webhook/webhook.ssrf.ts#L1-L125).
- OpenAPI Swagger mount: [`server/src/app.ts:74-86`](file:///Users/nishant/Documents/PayBridge/server/src/app.ts#L74-L86), [`docs/openapi.yaml`](file:///Users/nishant/Documents/PayBridge/docs/openapi.yaml).
