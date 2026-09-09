# Finance Analyst

## 1. Persona Definition
- **Role:** Finance Analyst (exemplified by Devika, Revenue Operations / Finance Manager).
- **Primary Responsibility:** Owning the revenue recovery numbers, reconciling financial ledgers, auditing gross recoverable amounts versus net recovered revenue (accounting for recovery incentives and messaging costs), measuring causal attribution via randomized holdout groups, and exporting authoritative financial reports for corporate accounting and ERP systems.
- **Primary Objectives:**
  - Reconcile all recovered payment revenue with exact 0-variance integer minor units (Invariant I5).
  - Track Net Recovered Revenue (gross recovered revenue minus incentive discounts and recovery costs).
  - Measure causal incrementality using randomized holdout groups to verify that recovered revenue was truly incremental rather than organic re-billing.
  - Analyze cohort recovery rates by failure date and observe Time-to-Recovery (TTR) percentiles (p50, p90, p99).
  - Generate and export reconciled financial ledger CSV reports for general ledger and tax reconciliation.
- **Primary PayBridge Value:** Replaces unreliable, self-reported recovery counters with an authoritative, double-entry-auditable revenue recovery and leakage ledger grounded in exact minor units and causal attribution.

## 2. Authentication and Authorization Requirements
- **Authentication Required:** Username/password authentication returning a JWT bearer token pair; multi-factor authentication (target).
- **Intended Role:** `finance_analyst`.
- **Intended Permissions:**
  - `finance:read`, `ledger:read`, `ledger:export`
  - `analytics:read`
  - `orders:read`
- **Tenant / Merchant Isolation Requirements:**
  - Strict tenant isolation: the analyst may only view financial ledgers, analytics, and transaction records belonging to their merchant tenant (`merchant_id`).
  - Cross-tenant financial aggregation is strictly prohibited.
- **Sensitive Actions Requiring Authorization:**
  - Exporting financial ledger records (containing aggregate revenue, transaction counts, and leakage figures).
  - Viewing financial margins, incentive spend, and net recovery economics.
- **Target vs. Current Implementation:**
  - *Target:* Dedicated `finance_analyst` role with read-only access to financial ledgers, analytics, and export tools; barred from modifying developer webhooks, changing operational recovery policies, or executing simulated checkout payments.
  - *Current Reality:* Only coarse tenant authentication exists via `authenticate` middleware. No `finance_analyst` role exists in the database schema. While the backend exposes mature ledger and analytics endpoints ([`merchant.routes.ts:226-260`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L226-L260)), **the client frontend makes zero API calls to these endpoints and renders zero aggregate financial figures**.

## 3. Entry Point and Navigation
- **Intended Entry Point:** Authentication at `/login`, landing on the Finance & Revenue Portal (`/finance` or `/ledger`).
- **Current Navigation:**
  - No finance portal exists in the client navigation.
  - The current Dashboard ([`DashboardPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/DashboardPage.tsx)) displays only 4 transaction count cards without monetary values.
  - The only currency values displayed in the UI are individual case amounts in the Recovery Cockpit drawer ([`RecoveryPage.tsx:557-563`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L557-L563)) and order amounts in the Payments list ([`PaymentsPage.tsx:117`](file:///Users/nishant/Documents/PayBridge/client/src/pages/PaymentsPage.tsx#L117)).
- **Target Navigation:**
  - Dedicated `Finance & Revenue` section in application navigation:
    - `Revenue & Leakage Ledger` (Total Value at Risk, Total Value Recovered, Net Leakage, Net Recovery Rate)
    - `Holdout & Attribution` (causal incremental recovery comparison against control groups)
    - `Cohort Analytics` (recovery rates by originating failure cohort, TTR percentiles)
    - `Ledger Exports` (reconciled CSV downloads with date range and currency selectors)

## 4. End-to-End Workflow
1. **Login and Navigation:**
   - Analyst authenticates and navigates to the Finance Portal.
   - Status: **TARGET / MISSING in UI** (User logs into `/dashboard`, but no finance screen exists).
2. **Reviewing the Recoverable Revenue & Leakage Ledger:**
   - Analyst inspects the high-level financial summary: Total Value at Risk (TVaR), Total Value Recovered (TVR), Leakage (unrecovered/suppressed), and Net Recovery Rate.
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** (Calculated with exact 0-variance integer minor units by `getRevenueLedger` in `server/src/modules/recovery/case.service.ts:180-220` and exposed via `GET /api/merchants/recovery/ledger`; frontend has zero UI).
3. **Filtering by Date Range and Currency:**
   - Analyst selects a date range (e.g. `startDate=2026-08-01`, `endDate=2026-08-31`) and currency (`INR`).
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** (Query parameters supported and validated via Zod in [`merchant.routes.ts:210-214`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L210-L214); frontend has zero filter controls).
4. **Analyzing Recovery Performance KPIs and Cohorts:**
   - Analyst reviews Time-to-Recovery percentiles (p50, p90, p99, min, max, avg), multi-tier recovery rates, and strategy recovery performance.
   - Status: **PARTIALLY IMPLEMENTED / BACKEND-ONLY** (Computed by `getRecoveryAnalytics` in `server/src/modules/recovery/analytics.service.ts` and exposed via `GET /api/recovery/analytics`; frontend has zero UI).
5. **Verifying Causal Holdout Attribution:**
   - Analyst compares recovery rates between platform-managed cases and randomized holdout control cases to confirm causal revenue lift.
   - Status: **TARGET / MISSING** (Holdout membership tracking and treatment-vs-holdout causal attribution [RCV-013] are not currently implemented in the database or backend; comparison UI unbuilt).
6. **Exporting Reconciled Financial Ledger CSV:**
   - Analyst clicks `Export Ledger CSV` to download reconciled ledger rows for general ledger ingestion.
   - Status: **TARGET / MISSING** (Audit case exports exist in `audit.routes.ts`, but aggregate financial ledger CSV export is unbuilt).

## 5. Screens and Surfaces
1. **PayBridge Client Web Application (`client/`):**
   - *Status:* **MISSING (0% dedicated finance UI).**
   - *Current Reality:* Neither `/dashboard` nor any other page exposes the financial ledger or recovery analytics.
2. **Finance & Revenue Portal (`/finance` or `/ledger`):**
   - *Status:* **Target Screen (Missing in Frontend).**
   - *Target Route:* `/finance`.
   - *Key Information / Actions:* 4 financial KPI tiles (TVaR, TVR, Leakage, Net Recovery Rate), date range filter, currency selector, failure category breakdown table.
3. **Recovery Performance & Cohorts Screen:**
   - *Status:* **Target Screen (Missing in Frontend).**
   - *Target Route:* `/finance/analytics`.
   - *Key Information / Actions:* TTR percentiles (p50/p90/p99), strategy performance breakdown, volume funnels.
4. **Financial Ledger CSV Export:**
   - *Status:* **Target Action (Missing in Frontend & Backend).**
   - *Target Component:* Export button in `/finance`.
   - *Key Information / Actions:* Download RFC 4180 CSV containing reconciled ledger rows and minor-unit amounts.

## 6. Backend APIs and Services
1. `GET /api/merchants/recovery/ledger`
   - *Module / Service:* `server/src/modules/merchant/merchant.routes.ts:226-242`, `case.service.ts`
   - *Purpose:* Returns Recoverable Revenue & Leakage Ledger with exact 0-variance integer minor units, filtering by `startDate`, `endDate`, and `currency`.
   - *Frontend Consumption:* **NOT Consumed** (Fully implemented in backend; uncalled by client).
2. `GET /api/recovery/analytics` & `GET /api/merchants/recovery/analytics`
   - *Module / Service:* `server/src/modules/recovery/case.routes.ts:98-114`, `merchant.routes.ts:245-260`, `analytics.service.ts`
   - *Purpose:* Returns recovery analytics: volume KPIs, multi-tier recovery rates, TTR percentiles, strategy performance, and failure category distributions.
   - *Frontend Consumption:* **NOT Consumed** (Fully implemented in backend; uncalled by client).
3. Prometheus Financial Metrics
   - *Module / Service:* `server/src/infrastructure/metrics/recovery.metrics.ts`
   - *Purpose:* Exposes `paybridge_recovery_revenue_recovered_minor_units_total` and `paybridge_recovery_rate`.
   - *Frontend Consumption:* **NOT Consumed** (Scraped by Prometheus).
4. Missing Backend Capabilities:
   - Dedicated Financial Ledger CSV export endpoint (`GET /api/merchants/recovery/ledger/export?format=csv`).
   - Persisted holdout membership tracking in database and dedicated holdout attribution comparison endpoint (`RCV-013`).

## 7. Data Visible to the Persona
- **Currently Exposed Data (Backend APIs Only):**
  - Ledger metrics: Total Value at Risk (minor units), Total Value Recovered (minor units), Net Leakage (minor units), Net Recovery Rate (percentage).
  - Analytics KPIs: Total cases count, eligible cases, recovered cases, unrecovered cases, overall recovery rate.
  - TTR percentiles: p50, p90, p99, minimum, maximum, average duration in seconds from initial failure to recovery.
  - Strategy performance: recovery counts and rates split by recovery playbook.
  - Individual case amounts formatted in minor units (INR) in `/recovery`.
- **Target Data (Not Yet Exposed in UI):**
  - Visual financial ledger cards and trend charts.
  - Holdout attribution lift percentages.
  - Cost-to-recover and incentive discount deductions.
- **Sensitive Data Requiring Authorization:**
  - Aggregate merchant revenue and margin figures.
  - Banking or settlement account details (out of scope).

## 8. Allowed Actions
- `ledger:read` — View recoverable revenue and leakage ledger (*backend-only, target UI*).
- `analytics:read` — View recovery KPIs, cohort metrics, and TTR percentiles (*backend-only, target UI*).
- `orders:read` — View order transaction details (*currently possible*).
- `ledger:export` — Export financial ledger as CSV (*target-only*).
- `attribution:read` — Inspect holdout vs treatment lift (*target-only*).

## 9. Forbidden / Restricted Actions
- **Operational Triage Actions:** Must NOT approve or reject recovery cases in place of the merchant operator.
- **Policy Modifications:** Must NOT alter recovery policies, change autonomy tiers, or modify spend budgets.
- **Developer Settings:** Must NOT configure webhook URLs or reveal webhook signing secrets.
- **Payment Execution:** Must NOT execute simulated payments or create customer checkout orders.
- **Cross-Tenant Financials:** Must NOT view financial ledgers or recovery metrics of another merchant.

## 10. Current Implementation Status
- **Overall Persona Status:** `PARTIALLY IMPLEMENTED` (due to mature backend ledger engine) / `MISSING` (for frontend UI).
  - Recoverable Revenue & Leakage Ledger Engine: `BACKEND-ONLY` (verified with exact 0-variance integer minor units).
  - Recovery Analytics Engine: `BACKEND-ONLY` (verified across volume, TTR, and strategy KPIs).
  - Financial Dashboard / Ledger UI: `MISSING` (0% frontend UI).
  - Financial Ledger CSV Export: `MISSING`.
  - Role-Based Authorization Enforcement: `MISSING`.

## 11. Missing Implementation
- **Frontend Gaps:**
  - Dedicated Finance Portal (`/finance` or `/ledger`).
  - Financial KPI cards (TVaR, TVR, Leakage, Net Recovery Rate %).
  - Date range picker and currency filter controls.
  - Breakdown table of recovered revenue by failure category and strategy.
  - Financial ledger CSV download button.
- **Backend / Authentication / Authorization Gaps:**
  - Add `finance_analyst` role to database schema and role registry.
  - Enforce `requirePermission('ledger:read')` on `/api/merchants/recovery/ledger`.
- **Data / API Gaps:**
   - Aggregate financial ledger CSV export endpoint (`GET /api/merchants/recovery/ledger/export`).
   - Persisted holdout membership tracking in database schema and holdout attribution comparison query endpoint (`RCV-013`).
- **Operational / Security Gaps:**
  - Caching for heavy multi-month ledger queries (`CACHE-002`).

## 12. Smallest Implementation Slice
- **Scope:** Build a "Finance & Recovery Ledger" view (or tab in Dashboard) in `client/src/pages/`:
  1. Calls existing `GET /api/merchants/recovery/ledger` and `GET /api/recovery/analytics`.
  2. Displays 4 financial KPI cards: Total Value at Risk, Total Value Recovered, Net Leakage, and Net Recovery Rate %.
  3. Includes a date range selector (Last 7 Days, Last 30 Days, All Time) and currency selector (`INR`).
  4. Renders a summary table of recovery performance by failure category.
- **Capabilities Delivered:**
  - Finance Analyst can immediately view and verify the merchant's financial recovery figures and ROI in major/minor currency units.
- **Backend Authorization Required:** Add `finance_analyst` role and require permission `ledger:read`.

## 13. Acceptance Criteria
- [ ] Analyst must authenticate with valid merchant credentials to access finance surfaces.
- [ ] Financial metrics display amounts in properly formatted major currency units while maintaining integer minor unit accuracy.
- [ ] Total Value at Risk (TVaR) equals Total Value Recovered (TVR) plus Net Leakage with exact 0-variance reconciliation.
- [ ] Date range and currency filter adjustments update the ledger metrics in real time.
- [ ] Analyst cannot approve or reject recovery actions or modify merchant policies.
- [ ] Analyst cannot view financial ledgers belonging to another merchant tenant.

## 14. Dependencies
- **RBAC / Permissions (Proposed):** `finance_analyst` role and `ledger:read` permission (`AUTH-003`).
- **Backend APIs (Verified):** `server/src/modules/merchant/merchant.routes.ts:226-260`, `case.service.ts`, `analytics.service.ts`.
- **Frontend Shared Infrastructure (Proposed):** Unified `<AppShell />` navigation (`MDB-001`).
- **Operational Infrastructure (Verified):** MySQL `recovery_cases` and `orders` tables.

## 15. Evidence / Source Notes
- Revenue ledger route: [`server/src/modules/merchant/merchant.routes.ts:226-242`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L226-L242).
- Revenue ledger service logic: [`server/src/modules/recovery/case.service.ts:180-220`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/case.service.ts#L180-L220).
- Recovery analytics routes: [`server/src/modules/recovery/case.routes.ts:98-114`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/case.routes.ts#L98-L114), [`server/src/modules/merchant/merchant.routes.ts:245-260`](file:///Users/nishant/Documents/PayBridge/server/src/modules/merchant/merchant.routes.ts#L245-L260).
- Recovery analytics service: [`server/src/modules/recovery/analytics.service.ts:1-240`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/analytics.service.ts#L1-L240).
- Minor-unit currency formatting helper in client: [`client/src/pages/RecoveryPage.tsx:56-62`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx#L56-L62).
- Absence of ledger/analytics calls in client: verified via codebase search (zero calls in `client/src/`).
