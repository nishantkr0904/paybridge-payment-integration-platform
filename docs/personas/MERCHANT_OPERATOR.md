# Merchant Operator

## 1. Persona Definition
- **Role:** Merchant Operator (exemplified by Priya, merchant business owner/operations manager).
- **Primary Responsibility:** Overseeing day-to-day payment operations, monitoring failed checkouts, supervising autonomous recovery operations, configuring recovery aggression and spending limits, and acting as the human escalation authority for high-risk recovery actions.
- **Primary Objectives:**
  - Maximize recovered payment revenue while protecting customer trust and preventing customer communication fatigue.
  - Review and triage stalled or high-value failed payment recovery cases requiring human intervention.
  - Formulate, activate, and tune autonomous recovery policies (autonomy tiers, retry caps, quiet hours, spend budgets).
  - Execute explicit operator decisions (`APPROVE`, `REJECT`, `CLOSE`) with mandatory business justifications on cases held at approval boundaries.
- **Primary PayBridge Value:** Replaces manual spreadsheet tracking and blind re-billing with an intelligent, autonomous recovery engine governed by deterministic policy bounds and transparent human-in-the-loop oversight.

## 2. Authentication and Authorization Requirements
- **Authentication Required:** Username/password authentication via JSON Web Token (JWT) bearer access token pair (`accessToken`, `refreshToken`).
- **Intended Role:** `merchant_operator` (or `merchant_admin`).
- **Intended Permissions:**
  - `orders:read`, `orders:create`, `payments:simulate`
  - `recovery:read`, `recovery:triage`, `recovery:approve`, `recovery:reject`, `recovery:close`
  - `policy:read`, `policy:update`, `policy:activate`
  - `audit:read`, `audit:export`
- **Tenant / Merchant Isolation Requirements:**
  - Hard database-level scoping: all queries must enforce `WHERE merchant_id = :merchantId` (Invariant I9).
  - An operator must never view, triage, or approve recovery cases belonging to another merchant tenant.
- **Sensitive Actions Requiring Authorization:**
  - Approving high-risk or over-budget recovery actions (`POST /api/recovery/cases/:caseId/actions` with action `APPROVE`).
  - Rejecting or suppressing recovery cases (`POST /api/recovery/cases/:caseId/actions` with action `REJECT`).
  - Administratively closing cases (`POST /api/recovery/cases/:caseId/actions` with action `CLOSE`).
  - Updating active recovery policy parameters, autonomy tiers, or spend caps (`PUT /api/merchants/policies/active`).
- **Target vs. Current Implementation:**
  - *Target:* Granular RBAC where `merchant_operator` can approve cases and update policies, while read-only staff cannot. Route-level `requirePermission` middleware returning `403 AUTH_FORBIDDEN`.
  - *Current Reality:* Only coarse tenant authentication exists via `authenticate` middleware (`server/src/middleware/authenticate.ts`). The database schema (`database/migrations/001_auth_schema.up.sql`) assigns only the role `'merchant'`. No backend middleware checks `req.user.roles`. Any authenticated user for a merchant tenant has unrestricted execution rights over that merchant's orders, triage actions, and policies.

## 3. Entry Point and Navigation
- **Intended Entry Point:** Authentication at `/login`, landing on the Merchant Dashboard (`/dashboard`) with immediate visual indicators of active recovery health, triage backlog counts, and net recovered revenue.
- **Current Navigation:**
  - Top header navigation available on `/dashboard` with buttons: `Payments` (`/payments`), `Recovery Cockpit` (`/recovery`), `Developers` (`/developers`), and `Logout`.
  - On `/payments`, `/payments/new`, and `/payments/:orderRef`, no top navigation bar exists; users must use browser back navigation or click "Back to payments".
  - Direct deep linking between orders and recovery cases is not wired into the UI navigation.
- **Target Navigation:**
  - Unified `<AppShell />` providing persistent top and sidebar navigation across all authenticated routes.
  - Clear section tabs: `Dashboard`, `Payments & Orders`, `Recovery Cockpit` (with badge count of items awaiting approval), `Policies & Settings`, and `Analytics`.
  - 1-click cross-linking from an order row in `/payments` to its corresponding recovery case in `/recovery` (and vice versa).

## 4. End-to-End Workflow
1. **Login and Session Establishment:**
   - Operator navigates to `/login`, enters email/password, receives JWT tokens stored in `localStorage`.
   - Status: **VERIFIED CURRENT** ([`LoginPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/LoginPage.tsx), [`AuthProvider.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/providers/AuthProvider.tsx)).
2. **Dashboard Review:**
   - Operator lands on `/dashboard`, views high-level volume metrics (Total, Successful, Failed, Pending payments) fetched via `GET /api/merchants/me`.
   - Status: **PARTIALLY IMPLEMENTED** ([`DashboardPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DashboardPage.tsx)). High-level counts display, but no recovered revenue currency totals, triage queue counts, or recovery rate percentages are shown.
3. **Recovery Triage Inspection:**
   - Operator clicks `Recovery Cockpit` (`/recovery`), viewing the Prioritized Triage Queue (`GET /api/recovery/queue`) and All Cases (`GET /api/recovery/cases`).
   - Operator inspects cases prioritized by recoverable value, propensity score, and urgency.
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:84-126`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L84-L126), verified in [`recovery.api.test.ts:81-126`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L81-L126)).
4. **Case Investigation and AI Reasoning Trace Review:**
   - Operator clicks a case in the queue. A slide-over drawer opens showing summary cards (amount, failure category, status), AI Reasoning Traces with masked PII placeholders (`GET /api/recovery/cases/:caseId/traces`), and chronological Event Timeline (`GET /api/recovery/cases/:caseId/timeline`).
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:442-700`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L442-L700), verified in [`recovery.api.test.ts:164-247`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L164-L247)).
5. **Human Approval / Rejection Decision:**
   - For cases in `awaiting_approval` status, an alert banner displays. The operator clicks `Approve & Execute`, `Reject Action`, or `Close Case`.
   - A modal requires entry of a non-empty text justification reason.
   - Submission calls `POST /api/recovery/cases/:caseId/actions` with `{ action: 'APPROVE'|'REJECT'|'CLOSE', reason: '...' }`, triggering state transition and background worker dispatch.
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:477-532, 702-748`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L477-L532), verified in [`recovery.api.test.ts:249-345`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L249-L345)).
6. **Recovery Policy Configuration:**
   - Operator navigates to policy configuration, reviews active autonomy tier (T0–T4), retry caps, customer outreach limits, spend budgets, and quiet hours.
   - Operator tunes parameters and activates updated policy.
   - Status: **TARGET / MISSING in UI** (Backend endpoints exist and are verified in [`merchant.routes.ts:88-204`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L88-L204), but frontend client has zero policy configuration screens or API calls).
7. **Compliance Audit Export:**
   - Operator clicks `Export CSV` or `Export JSON` in the case drawer to download a cryptographically signed audit trail (`GET /api/audit/cases/:idOrRef/export`).
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:449-466`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L449-L466), verified in [`recovery.api.test.ts:347-393`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L347-L393)).

## 5. Screens and Surfaces
1. **Merchant Dashboard:**
   - *Status:* Implemented-but-not-verified by automated frontend test.
   - *Route / Component:* `/dashboard` / [`DashboardPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DashboardPage.tsx).
   - *Key Information / Actions:* 4 count cards (total, successful, failed, pending), navigation buttons.
2. **Payments List:**
   - *Status:* Implemented-but-not-verified by automated frontend test.
   - *Route / Component:* `/payments` / [`PaymentsPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/PaymentsPage.tsx).
   - *Key Information / Actions:* Paginated table of orders, status filter tabs, button to create order.
3. **Create Order Form:**
   - *Status:* Implemented-but-not-verified by automated frontend test.
   - *Route / Component:* `/payments/new` / [`CreateOrderPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/CreateOrderPage.tsx).
   - *Key Information / Actions:* Amount, currency, description, customer email input fields.
4. **Order Detail & Payment Simulator:**
   - *Status:* Implemented-but-not-verified by automated frontend test.
   - *Route / Component:* `/payments/:orderRef` / [`OrderDetailPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/OrderDetailPage.tsx).
   - *Key Information / Actions:* Order status badge, amount, simulated payment buttons (`card`, `upi`, `netbanking`, `wallet`).
5. **Recovery Cockpit:**
   - *Status:* Implemented; automated-test-verified at API client layer.
   - *Route / Component:* `/recovery` / [`RecoveryPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx).
   - *Key Information / Actions:* Prioritized triage queue, case list, search bar, slide-out drawer with timeline, trace viewer, action modal, CSV/JSON audit export.
6. **Recovery Policy Configuration:**
   - *Status:* **Target Screen (Missing in Frontend).**
   - *Target Route / Component:* `/recovery/policies` or embedded modal in `/recovery`.
   - *Key Information / Actions:* Autonomy tier selector (T0–T4), max retries input (0–10), weekly contact frequency cap (0–20), daily spend budget, max incentive percent, quiet hours start/end pickers, timezone selector.

## 6. Backend APIs and Services
1. `GET /api/merchants/me`
   - *Module / Service:* `server/src/modules/merchant/merchant.routes.ts`, `merchant.service.ts`
   - *Purpose:* Returns merchant profile and payment transaction counts.
   - *Frontend Consumption:* **Consumed** by [`DashboardPage.tsx:10-13`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DashboardPage.tsx#L10-L13).
2. `GET /api/payments/orders` & `POST /api/payments/orders`
   - *Module / Service:* `server/src/modules/payment/payment.routes.ts`, `payment.service.ts`
   - *Purpose:* Lists and creates payment orders.
   - *Frontend Consumption:* **Consumed** by [`PaymentsPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/PaymentsPage.tsx) and [`CreateOrderPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/CreateOrderPage.tsx).
3. `POST /api/payments/orders/:orderRef/pay`
   - *Module / Service:* `server/src/modules/payment/payment.routes.ts`, `payment.service.ts`
   - *Purpose:* Simulates payment execution across payment methods.
   - *Frontend Consumption:* **Consumed** by [`OrderDetailPage.tsx:44-50`](file:///Users/nishant/Documents/PayBridge/client/src/pages/OrderDetailPage.tsx#L44-L50).
4. `GET /api/recovery/queue`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts`, `case.service.ts`
   - *Purpose:* Retrieves prioritized triage queue ranked by recoverable amount and propensity.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:85-89`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L85-L89).
5. `GET /api/recovery/cases` & `GET /api/recovery/cases/:idOrRef`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts`, `case.service.ts`
   - *Purpose:* Lists and fetches recovery cases.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:92-100`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L92-L100).
6. `GET /api/recovery/cases/:caseId/timeline`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts`, `case.service.ts`
   - *Purpose:* Returns chronological case event history from `case_events`.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:103-108`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L103-L108).
7. `GET /api/recovery/cases/:caseId/traces`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts`, `trace.service.ts`
   - *Purpose:* Returns sanitized agent reasoning traces with masked PII placeholders.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:111-116`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L111-L116).
8. `POST /api/recovery/cases/:caseId/actions`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts`, `case.service.ts`
   - *Purpose:* Executes operator intervention (`APPROVE`, `REJECT`, `CLOSE`) with mandatory reason.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:143-162`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L143-L162).
9. `GET /api/merchants/policies/active` & `PUT /api/merchants/policies/active`
   - *Module / Service:* `server/src/modules/merchant/merchant.routes.ts`, `policy.service.ts`
   - *Purpose:* Reads and mutates merchant active policy configuration.
   - *Frontend Consumption:* **NOT Consumed** (Backend exists, frontend has no calls).
10. `GET /api/audit/cases/:idOrRef/export`
    - *Module / Service:* `server/src/modules/audit/audit.routes.ts`, `audit.service.ts`
    - *Purpose:* Produces RFC 4180 CSV / structured JSON compliance export with SHA-256 signature.
    - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:165-191`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L165-L191).

## 7. Data Visible to the Persona
- **Currently Exposed Data:**
  - Merchant summary: total transactions count, successful, failed, pending counts.
  - Orders: order reference, customer email, amount, currency, order status, description, created timestamp.
  - Transactions: transaction reference, payment method, status, gateway response code, failure reason string.
  - Recovery cases: case reference, status, recoverable amount (minor units), currency, originating signal, failure category, created/updated timestamps.
  - Prioritization data: priority score, score breakdown (base value, urgency, propensity bonus, tier weight), rank reason.
  - Timelines: event transitions (`fromStatus` -> `toStatus`), actor type, actor ID, transition reason, event payload, correlation ID.
  - Sanitized traces: agent type, total duration ms, total token counts, step type, model ID, prompt with masked PII placeholders (`[EMAIL_REDACTED]`, `[PHONE_REDACTED]`, `[CARD_REDACTED]`), parsed output JSON.
- **Target Data (Not Yet Exposed in UI):**
  - Active policy configuration parameters (autonomy tier, quiet hours, budget minor units, caps).
  - Recovery financial analytics (total value at risk, total value recovered, net recovery rate).
  - Customer contact outreach event logs.
- **Sensitive Data Requiring Authorization:**
  - Raw unredacted customer PII (must remain masked).
  - Webhook signing secrets (belongs to Merchant Developer persona, not Operator).

## 8. Allowed Actions
- `orders:read` — View orders and order details (*currently possible*).
- `orders:create` — Create checkout orders (*currently possible*).
- `payments:simulate` — Trigger simulated payments (*currently possible*).
- `recovery:read` — View prioritized triage queue and case details (*currently possible*).
- `recovery:triage` — Search, filter, and inspect recovery cases (*currently possible*).
- `recovery:approve` — Approve proposed recovery actions (*currently possible*).
- `recovery:reject` — Reject and suppress recovery actions (*currently possible*).
- `recovery:close` — Administratively terminate recovery cases (*currently possible*).
- `audit:export` — Export certified compliance audit files (*currently possible*).
- `policy:read` — View active recovery policy (*target-only in UI, backend exists*).
- `policy:update` — Mutate recovery policy parameters (*target-only in UI, backend exists*).
- `recovery:bulk_action` — Bulk-approve or bulk-reject cases (*target-only*).

## 9. Forbidden / Restricted Actions
- **Cross-Tenant Data Access:** Must never read, list, or modify orders, cases, or policies of another merchant. *(Currently enforced in backend via tenant predicate `merchant_id = req.user.id`)*.
- **Platform Infrastructure Controls:** Must not access Prometheus metrics, RabbitMQ internals, or trigger platform kill switches. *(Currently enforced by absence of web UI; infrastructure runs on isolated ports)*.
- **Operator Trace Inspection:** Must not inspect unmasked system prompts, provider temperatures, or raw LLM provider payloads. *(Currently violated in backend `GET /api/v1/ops/agent-traces/:traceRef` due to missing role check)*.
- **Webhook Secret Modification:** Should not rotate or delete developer webhook configurations. *(Currently unprotected in UI/backend; any merchant token can access `/developers`)*.
- **Direct Database Mutation:** Must never bypass state machine rules to force arbitrary case status changes. *(Enforced by state machine in `case.state-machine.ts`)*.

## 10. Current Implementation Status
- **Overall Persona Status:** `PARTIALLY IMPLEMENTED`
  - Dashboard: `PARTIALLY IMPLEMENTED` (counts only, no financial metrics).
  - Payments & Simulation: `IMPLEMENTED`.
  - Recovery Cockpit Triage & Drawer: `IMPLEMENTED` (verified at API layer in `recovery.api.test.ts`).
  - Human Decision Workflow: `IMPLEMENTED` (modal with mandatory reason enforced).
  - Recovery Policy Management: `BACKEND-ONLY` (REST endpoints exist, zero frontend UI).
  - Authorization / RBAC: `MISSING` (no role enforcement or `requirePermission` middleware).

## 11. Missing Implementation
- **Frontend Gaps:**
  - Recovery Policy Configuration screen/tab to edit autonomy tier, quiet hours, caps, and budget.
  - Recovery financial metrics cards on Dashboard (Total Value at Risk, Net Recovered Revenue).
  - Shared application navigation shell (`<AppShell />`) with consistent header and badge counters.
  - Bulk action check-boxes on the triage queue table.
- **Backend / Authentication / Authorization Gaps:**
  - Role modeling: Add `merchant_operator` role to database schema and role registry.
  - Authorization middleware: Implement `requirePermission('recovery:approve')` and `requirePermission('policy:update')`.
- **Data / API Gaps:**
  - Frontend API client module for policy endpoints (`getActivePolicy`, `updatePolicy`).
- **Operational / Security Gaps:**
  - Restrict `/api/v1/ops/agent-traces/*` so merchant operators cannot view internal cross-tenant traces.

## 12. Smallest Implementation Slice
- **Scope:** Build a "Recovery Policy Settings" card inside `/recovery` (or as a modal tab) wired to `GET /api/merchants/policies/active` and `PUT /api/merchants/policies/active`.
- **Capabilities Delivered:**
  1. Operator views current autonomy tier (T0–T4), retry cap, quiet hours window, and daily budget.
  2. Operator can adjust these parameters and save changes through the validated API schema.
- **Backend Authorization Required:** Add `policy:update` permission gate on `PUT /api/merchants/policies/active`.

## 13. Acceptance Criteria
- [ ] Operator must authenticate with valid merchant credentials to access `/dashboard` and `/recovery`.
- [ ] Unauthenticated requests to any operator route redirect to `/login`.
- [ ] Operator can view the prioritized triage queue, and cases are ordered by `priorityScore` descending.
- [ ] Case drawer displays chronological event timeline and sanitized reasoning trace with masked PII.
- [ ] Operator cannot submit an `APPROVE`, `REJECT`, or `CLOSE` action without providing a non-empty text justification.
- [ ] Submitting an action transitions the case state and triggers appropriate worker execution.
- [ ] Operator can view and update the active recovery policy parameters through a dedicated UI.
- [ ] All queries and mutations strictly enforce tenant isolation (`merchant_id`).
- [ ] Operator without `policy:update` permission receives `403 AUTH_FORBIDDEN` when attempting to modify policies.

## 14. Dependencies
- **RBAC / Permissions (Proposed):** `requirePermission` middleware and `merchant_operator` role assignment (`AUTH-003`).
- **Backend APIs (Verified):** `merchant.routes.ts`, `case.routes.ts`, `audit.routes.ts`.
- **Frontend Shared Infrastructure (Proposed):** Unified `<AppShell />` component (`MDB-001`).
- **Operational Infrastructure (Verified):** MySQL database, RabbitMQ `payment_processing_queue`.

## 15. Evidence / Source Notes
- Client routes & navigation: [`client/src/App.tsx:30-37`](file:///Users/nishant/Documents/PayBridge/client/src/App.tsx#L30-L37), [`client/src/pages/DashboardPage.tsx:20-58`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DashboardPage.tsx#L20-L58).
- Recovery Cockpit UI implementation: [`client/src/pages/RecoveryPage.tsx:64-749`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L64-L749).
- Recovery API tests: [`client/src/__tests__/recovery.api.test.ts:1-395`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L1-L395).
- Backend policy endpoints: [`server/src/modules/merchant/merchant.routes.ts:88-204`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L88-L204).
- Backend case routes & actions: [`server/src/modules/recovery/case.routes.ts:120-275`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/case.routes.ts#L120-L275).
- Auth middleware & schema: [`server/src/middleware/authenticate.ts:5-20`](file:///Users/nishant/Documents/PayBridge/server/src/middleware/authenticate.ts#L5-L20), [`database/migrations/001_auth_schema.up.sql:49-51`](file:///Users/nishant/Documents/PayBridge/database/migrations/001_auth_schema.up.sql#L49-L51).
