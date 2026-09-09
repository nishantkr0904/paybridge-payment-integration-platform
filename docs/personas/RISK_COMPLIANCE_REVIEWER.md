# Risk and Compliance Reviewer

## 1. Persona Definition
- **Role:** Risk and Compliance Reviewer (exemplified by Rahul, Risk Manager / Compliance Auditor).
- **Primary Responsibility:** Governing autonomous recovery decision-making, ensuring adherence to regulatory standards (PCI scope minimization, data protection laws), auditing append-only event records, verifying PII minimization in AI prompt contexts, and generating certified compliance and dispute defense packages.
- **Primary Objectives:**
  - Verify that every autonomous recovery action complies with merchant policy bounds and regulatory mandates.
  - Inspect the application-level append-only event history (`case_events`) for chronological lineage.
  - Verify that customer PII (credit cards, email addresses, phone numbers) is rigorously redacted before context injection into foundation models.
  - Generate and export certified audit packages with SHA-256 integrity signatures (`X-Audit-Signature` header) for payment processor dispute defense and regulatory inquiries.
  - Review human operator approvals and rejections for valid business justifications.
- **Primary PayBridge Value:** Converts opaque AI agent decisions into certified audit exports with SHA-256 signatures and an application-level append-only event history that satisfy external auditors, card brand compliance mandates, and chargeback dispute requirements.

## 2. Authentication and Authorization Requirements
- **Authentication Required:** Username/password authentication returning a JWT bearer token pair; multi-factor authentication (target).
- **Intended Role:** `compliance_reviewer` (or `risk_reviewer`).
- **Intended Permissions:**
  - `audit:read`, `audit:export`
  - `cases:read`, `timeline:read`, `traces:read`
  - `explainability:read`
  - `policies:history_read`
- **Tenant / Merchant Isolation Requirements:**
  - Strict tenant isolation: the reviewer may only inspect audit trails and cases belonging to their merchant tenant (`merchant_id`).
  - Cross-tenant platform auditors (if authorized) must use separate administrative credentials with comprehensive access logging.
- **Sensitive Actions Requiring Authorization:**
  - Exporting certified compliance audit packages containing case event history and reasoning transcripts.
  - Reviewing operator action justifications and decision explanations.
- **Target vs. Current Implementation:**
  - *Target:* Dedicated `compliance_reviewer` role with read-only access to all case records, explainability payloads, and audit export endpoints, but strictly barred from approving cases or altering policies.
  - *Current Reality:* Only coarse tenant authentication exists via `authenticate` middleware. No `compliance_reviewer` role exists in the database. Any user with a merchant login can export certified audit trails from [`RecoveryPage.tsx:449-466`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L449-L466) without role gating.

## 3. Entry Point and Navigation
- **Intended Entry Point:** Authentication at `/login`, landing on a dedicated Compliance & Audit Portal (`/compliance`).
- **Current Navigation:**
  - No dedicated compliance portal exists in the client navigation.
  - Compliance capabilities are currently embedded inside the Recovery Cockpit ([`RecoveryPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx)):
    - Reviewer navigates `/login` -> `/dashboard` -> `Recovery Cockpit` (`/recovery`).
    - Reviewer selects a case to open the slide-out drawer, reviews the timeline and reasoning traces, and clicks `Export CSV` or `Export JSON`.
- **Target Navigation:**
  - Dedicated `Compliance & Audit` section in the application navigation:
    - `Global Audit Browser` (cross-case search and filter over all system events)
    - `Certified Case Exports` (export history, downloads, signature verification tool)
    - `Unified Explainability` (multi-pillar explainability inspector)
    - `Policy Governance Log` (immutable log of all policy tier and parameter changes)

## 4. End-to-End Workflow
1. **Login and Navigation:**
   - Reviewer authenticates and opens `/recovery`.
   - Status: **VERIFIED CURRENT** ([`LoginPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/LoginPage.tsx), [`RecoveryPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx)).
2. **Case Selection and Triage Audit:**
   - Reviewer filters cases by status (e.g. `suppressed`, `recovered`, `awaiting_approval`) to investigate specific decision outcomes.
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:92-100, 317-342`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L92-L100)).
3. **Event Timeline Narrative Verification:**
   - Reviewer inspects the chronological case timeline (`GET /api/recovery/cases/:caseId/timeline`), verifying `fromStatus` -> `toStatus` state transitions, actor types (`system`, `agent`, `operator`), and transition reasons.
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:628-700`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L628-L700), verified in [`recovery.api.test.ts:164-204`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L164-L204)).
4. **PII Minimization and Reasoning Trace Audit:**
   - Reviewer inspects the AI Reasoning Trace transcript (`GET /api/recovery/cases/:caseId/traces`).
   - Reviewer confirms customer identifiers are masked with explicit placeholders (`[EMAIL_REDACTED]`, `[PHONE_REDACTED]`, `[CARD_REDACTED]`) in prompt texts before submission to the LLM.
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:580-626`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L580-L626), verified in [`recovery.api.test.ts:206-247`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L206-L247)).
5. **Multi-Pillar Explainability Review:**
   - Reviewer examines the unified explainability payload (`GET /api/recovery/cases/:idOrRef/explainability`) showing failure categorization, policy rule evaluation breakdown, and propensity score factors.
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** (The endpoint [`case.routes.ts:227-237`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/case.routes.ts#L227-L237) exists, but the frontend only queries timeline and traces separately).
6. **Exporting Certified Compliance Audit Trail:**
   - Reviewer clicks `Export CSV` or `Export JSON` in the case drawer.
   - Browser downloads RFC 4180 CSV or structured JSON artifact via `GET /api/audit/cases/:idOrRef/export`.
   - Response includes certified SHA-256 signature in `X-Audit-Signature` header and unique `X-Export-Id`.
   - Status: **VERIFIED CURRENT** ([`RecoveryPage.tsx:449-466`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L449-L466), verified in [`recovery.api.test.ts:347-393`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L347-L393), server route [`audit.routes.ts:25-71`](file:///Users/nishant/Documents/PayBridge/server/src/modules/audit/audit.routes.ts#L25-L71)).
7. **Global Cross-Case Audit Log Search:**
   - Reviewer searches across all cases for specific compliance events (e.g. all human rejections or all quiet hours vetoes).
   - Status: **TARGET / MISSING** (No global audit browser exists in the UI).
8. **Audit Signature Verification Tool:**
   - Reviewer uploads a downloaded audit file to verify its SHA-256 signature against database records.
   - Status: **TARGET / MISSING in UI** (Signature generation is verified, but verification tool in UI is unbuilt).

## 5. Screens and Surfaces
1. **Recovery Cockpit Drawer Widgets:**
   - *Status:* Implemented; automated-test-verified at API layer.
   - *Route / Component:* `/recovery` / [`RecoveryPage.tsx:442-700`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L442-L700).
   - *Key Information / Actions:* Event timeline narrative, sanitized AI trace transcript with masked PII, 1-click `Export CSV` and `Export JSON` buttons.
2. **Dedicated Compliance Portal (`/compliance`):**
   - *Status:* **Target Screen (Missing in Frontend).**
   - *Target Route:* `/compliance` or `/audit`.
   - *Key Information / Actions:* Global audit log search, compliance metrics, policy audit history.
3. **Multi-Pillar Explainability Panel:**
   - *Status:* **Target Component (Missing in Frontend).**
   - *Target Location:* Tab inside `/recovery` case drawer or `/compliance`.
   - *Key Information / Actions:* Decision rule evaluations, feature attribution weights, propensity confidence breakdown.
4. **Signature Verification Tool:**
   - *Status:* **Target Screen (Missing in Frontend).**
   - *Target Component:* Utility modal in `/compliance`.
   - *Key Information / Actions:* Upload CSV/JSON export, compute SHA-256 hash, verify against certified audit export SHA-256 signature/header.

## 6. Backend APIs and Services
1. `GET /api/audit/cases/:idOrRef/export`
   - *Module / Service:* `server/src/modules/audit/audit.routes.ts:25-71`, `audit.service.ts`
   - *Purpose:* Generates certified audit trail export (CSV or JSON) with SHA-256 HMAC in `X-Audit-Signature` and unique `X-Export-Id`.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:165-191`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L165-L191).
2. `GET /api/recovery/cases/:caseId/timeline`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts:191-205`, `case.service.ts`
   - *Purpose:* Returns chronological event stream from `case_events` with actor, status, and reason.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:103-108`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L103-L108).
3. `GET /api/recovery/cases/:caseId/traces`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts:207-224`, `trace.service.ts`
   - *Purpose:* Retrieves sanitized agent reasoning traces with masked PII placeholders.
   - *Frontend Consumption:* **Consumed** by [`RecoveryPage.tsx:111-116`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L111-L116).
4. `GET /api/recovery/cases/:idOrRef/explainability`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts:227-237`, `case.service.ts`
   - *Purpose:* Provides unified multi-pillar explainability payload (`BT-C4` / `BEX-003`).
   - *Frontend Consumption:* **NOT Consumed** (Fully implemented in backend; uncalled by client).
5. `GET /api/merchants/policies`
   - *Module / Service:* `server/src/modules/merchant/merchant.routes.ts:107-114`, `policy.service.ts`
   - *Purpose:* Lists all policy versions for merchant audit.
   - *Frontend Consumption:* **NOT Consumed** (Uncalled by client).

## 7. Data Visible to the Persona
- **Currently Exposed Data:**
  - Case metadata: reference, status, recoverable amount, failure category, timestamps.
  - Event timeline: event ID, from/to status, actor type (`system`, `agent`, `operator`), reason string, correlation ID.
  - Sanitized reasoning traces: agent type, latency ms, token usage, user prompt with masked PII placeholders (`[EMAIL_REDACTED]`, `[PHONE_REDACTED]`, `[CARD_REDACTED]`), structured JSON output.
  - Certified export files: RFC 4180 CSV and JSON files with SHA-256 signature in `X-Audit-Signature`.
- **Target Data (Not Yet Exposed in UI):**
  - Unified multi-pillar explainability payload (rule evaluation outcomes, policy veto reasons).
  - Historical policy configuration versions and diffs.
  - Cross-case global audit log entries.
- **Sensitive Data Requiring Authorization:**
  - Unredacted customer PII: must remain strictly inaccessible.
  - Cryptographic signing keys: used internally to generate `X-Audit-Signature`; never exposed to client.

## 8. Allowed Actions
- `audit:read` — View case timeline and sanitized traces (*currently possible*).
- `audit:export` — Download certified CSV and JSON compliance audit trails (*currently possible*).
- `explainability:read` — Inspect multi-pillar decision explainability (*backend-only, target UI*).
- `policies:history_read` — Inspect historical policy versions (*backend-only, target UI*).
- `audit:verify_signature` — Verify certified export signature integrity (*target-only*).
- `audit:global_search` — Query cross-case audit logs (*target-only*).

## 9. Forbidden / Restricted Actions
- **Operational Interventions:** Must NOT approve or reject recovery cases in place of the business operator.
- **Policy Modifications:** Must NOT alter active recovery policies, change autonomy tiers, or adjust budgets.
- **Developer Settings:** Must NOT modify webhook URLs or reveal webhook signing secrets.
- **Unredacted Data Access:** Must NOT view unredacted customer PII or raw provider API keys.
- **Cross-Tenant Data:** Must NOT access cases or audit trails of other merchant tenants.

## 10. Current Implementation Status
- **Overall Persona Status:** `PARTIALLY IMPLEMENTED`
  - 1-Click Certified Audit Export: `IMPLEMENTED` (RFC 4180 CSV & JSON with SHA-256 signature).
  - Sanitized Trace Inspection: `IMPLEMENTED` (with masked PII placeholders).
  - Case Event Timeline: `IMPLEMENTED`.
  - Multi-Pillar Explainability: `BACKEND-ONLY` (endpoint exists, uncalled by frontend).
  - Dedicated Compliance Portal: `MISSING`.
  - Global Cross-Case Audit Log: `MISSING`.
  - Role-Based Authorization Enforcement: `MISSING`.

## 11. Missing Implementation
- **Frontend Gaps:**
  - Dedicated `/compliance` portal in application navigation.
  - "Explainability & Governance" tab in the `/recovery` case drawer consuming `GET /api/recovery/cases/:idOrRef/explainability`.
  - Global cross-case audit trail search screen.
  - In-browser audit signature verification utility.
- **Backend / Authentication / Authorization Gaps:**
  - Add `compliance_reviewer` role to schema and role registry.
  - Enforce `requirePermission('audit:export')` on `/api/audit/*` endpoints.
- **Data / API Gaps:**
  - Global cross-case audit query endpoint (`GET /api/audit/events` with filtering).
- **Operational / Security Gaps:**
  - Verification endpoint or public key distribution for third-party dispute validation of `X-Audit-Signature`.

## 12. Smallest Implementation Slice
- **Scope:** Add an "Explainability & Governance" tab inside the existing `/recovery` case drawer:
  1. Calls existing `GET /api/recovery/cases/:idOrRef/explainability`.
  2. Renders policy rule evaluations (which rules passed/vetoed), propensity breakdown, and certified export signature preview.
- **Capabilities Delivered:**
  - Reviewer can audit the exact policy rules and reasoning factors behind an autonomous decision in a unified UI.
- **Backend Authorization Required:** Add `compliance_reviewer` role and restrict audit exports to authorized compliance personnel.

## 13. Acceptance Criteria
- [ ] Reviewer must authenticate with valid credentials to access audit and compliance surfaces.
- [ ] Reviewer can inspect chronological event timelines and sanitized reasoning traces for any case in their tenant.
- [ ] Customer emails, card details, and phone numbers are verified to be masked with redaction placeholders.
- [ ] Clicking `Export CSV` or `Export JSON` downloads a valid artifact containing the SHA-256 signature header.
- [ ] Reviewer cannot approve or reject recovery cases or modify merchant policies.
- [ ] Reviewer cannot access audit records belonging to another merchant tenant.

## 14. Dependencies
- **RBAC / Permissions (Proposed):** `compliance_reviewer` role and `audit:export` permission.
- **Backend APIs (Verified):** `server/src/modules/audit/audit.routes.ts`, `server/src/modules/recovery/case.routes.ts`.
- **Frontend Shared Infrastructure (Proposed):** Unified `<AppShell />` navigation (`MDB-001`).
- **Operational Infrastructure (Verified):** MySQL `case_events` and `agent_traces` tables.

## 15. Evidence / Source Notes
- Audit export endpoint & signature logic: [`server/src/modules/audit/audit.routes.ts:1-72`](file:///Users/nishant/Documents/PayBridge/server/src/modules/audit/audit.routes.ts#L1-L72), [`server/src/modules/audit/audit.service.ts:1-180`](file:///Users/nishant/Documents/PayBridge/server/src/modules/audit/audit.service.ts#L1-L180).
- Audit export UI implementation: [`client/src/pages/RecoveryPage.tsx:449-466`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L449-L466).
- Audit export automated tests: [`client/src/__tests__/recovery.api.test.ts:347-393`](file:///Users/nishant/Documents/PayBridge/client/src/__tests__/recovery.api.test.ts#L347-L393).
- Explainability API endpoint: [`server/src/modules/recovery/case.routes.ts:227-237`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/case.routes.ts#L227-L237).
- Timeline & Trace routes: [`server/src/modules/recovery/case.routes.ts:191-224`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/case.routes.ts#L191-L224).
