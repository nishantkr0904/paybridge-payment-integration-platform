# Internal Recovery Agent

## 1. Persona Definition
- **Role:** Internal Recovery Agent (The Agent, non-human autonomous software principal).
- **Primary Responsibility:** Ingesting payment failure and checkout abandonment signals from message queues, executing bounded failure diagnosis via prompt-chained foundation models, formulating recovery playbooks, evaluating proposed actions against deterministic merchant policies, executing approved recovery steps, and writing immutable event traces.
- **Primary Objectives:**
  - Ingest signals from `recovery_ingestion_queue` within milliseconds of payment terminal failure.
  - Diagnose failure root causes (e.g. `TRANSIENT_GATEWAY_TIMEOUT` vs `INSUFFICIENT_FUNDS` vs `INVALID_CARD_NUMBER`) using schema-validated LLM outputs.
  - Plan optimal recovery actions (passive smart retry, delayed retry, customer outreach link, incentive discount) based on customer history and propensity scores.
  - Check proposed actions against merchant policy bounds (autonomy tier, budget minor units, contact frequency limits, quiet hours).
  - Transition cases into `awaiting_approval` whenever an action exceeds autonomy bounds or requires explicit human authorization.
  - Dispatch approved or autonomous recovery actions to `payment_processing_queue` via RabbitMQ.
  - Record complete, tamper-evident reasoning traces and event state transitions in MySQL.
- **Primary PayBridge Value:** Automates the labor-intensive payment recovery lifecycle 24/7 with sub-second decision latency, bounded execution safety, and zero manual intervention for standard failures.

## 2. Authentication and Authorization Requirements
- **Authentication Required:**
  - **Non-Interactive System Service:** The Agent does **not** authenticate via HTTP JWT bearer tokens or web sessions.
  - It authenticates at the infrastructure layer via dedicated AMQP broker credentials, Redis authentication, and MySQL connection pool credentials.
- **Intended Role:** `system_agent` (or `recovery_worker_principal`).
- **Intended Permissions:**
  - `signals:consume`
  - `cases:create`, `cases:transition`
  - `traces:write`, `events:append`
  - `policy:evaluate`
  - `actions:dispatch`
- **Tenant / Merchant Isolation Requirements:**
  - Process-level tenant isolation: each message consumed carries `merchant_id` and `correlation_id`.
  - All database lookups and writes are strictly scoped to the `merchant_id` originating the signal.
  - Context builder fetches customer history strictly within that specific `merchant_id`.
- **Sensitive Actions Requiring Bounded Control:**
  - Initiating retry payment requests that incur processor transaction fees.
  - Offering discount incentives that erode merchant revenue.
  - Sending customer notifications (must respect weekly frequency caps).
  - All sensitive actions are governed by the deterministic Policy Engine ([`policy.service.ts`](file:///Users/nishant/Documents/PayBridge/server/src/modules/policy/policy.service.ts)) before execution.
- **Target vs. Current Implementation:**
  - *Target:* Fully autonomous agent bounded by merchant policies with machine audit identity, executing end-to-end auto-advancement for both checkout abandonment and payment failures.
  - *Current Reality:* **Partially Verified / Pipeline Segregation:**
    - *Checkout Abandonment (VERIFIED CURRENT):* Executes the full end-to-end recovery pipeline via `advanceCaseThroughRecoveryPipeline` (diagnosis -> decision -> policy evaluation -> action dispatch).
    - *Payment Failure (VERIFIED CURRENT):* Executes ingestion and case detection into `detected` status (`ingestPaymentFailure`).
    - *Payment Failure Full Auto-Advancement (TARGET / MISSING):* Broader end-to-end auto-advancement for payment failures is not currently wired in `handleRecoveryMessage`.

## 3. Entry Point and Navigation
- **Intended Entry Point:** Event-driven message ingress via RabbitMQ `recovery_ingestion_queue`.
- **Navigation:**
  - **NOT APPLICABLE.** As an autonomous background process, the Internal Recovery Agent has no visual UI, web routes, or navigation paths.
  - Its actions, reasoning traces, and lifecycle states are surfaced to human personas through the Recovery Cockpit ([`RecoveryPage.tsx`](file:///Users/nishant/Documents/PayBridge/client/src/pages/RecoveryPage.tsx)) for Merchant Operators (Priya) and Risk Reviewers (Rahul), and through telemetry streams for Platform Operations (Meera).

## 4. End-to-End Workflow
1. **Signal Ingestion & Case Detection (Payment Failure vs. Checkout Abandonment):**
   - **Payment Failure (CURRENT / VERIFIED):** When a payment attempt fails in `payment.worker.ts`, a `payment.failed` event is published to `recovery_ingestion_queue`. `recovery.worker.ts` consumes the message, and `ingestPaymentFailure` in `case.service.ts` verifies merchant ownership, deduplicates by natural key `(merchantId, transactionId)`, creates a case record in MySQL `recovery_cases` with status `detected`, and records an initial `detected` transition in `case_events` (`actor_type = 'system'`, `actor_id = 'payment_worker'`). **Current implementation stops at case creation/detection; end-to-end auto-advancement of payment failures through subsequent recovery steps is not wired.**
   - **Checkout Abandonment (CURRENT / VERIFIED):** Ingested via `handleCheckoutAbandonmentMessage` in `recovery.worker.ts`, which acquires a Redis distributed lock (`lock:recovery:order:${orderRef}`), validates schema, and invokes `ingestAbandonmentRecovery` in `abandonment-recovery.service.ts` to execute the full `advanceCaseThroughRecoveryPipeline`.
2. **Autonomous Pipeline Execution (CURRENT / VERIFIED for Checkout Abandonment; TARGET / MISSING for Payment Failure):**
   - **LLM Failure Diagnosis:** Case transitions to `diagnosing`. `diagnosePaymentFailure` executes: fetches masked customer payment history, constructs context, redacts PII (`[EMAIL_REDACTED]`, `[PHONE_REDACTED]`, `[CARD_REDACTED]`), and queries the configured LLM provider. Structured JSON diagnosis and reasoning trace are recorded in `agent_traces`.
   - **Recovery Planning & Playbook Selection:** Case transitions to `deciding`. `planRecoveryDecision` evaluates diagnosis, selects candidate playbook (e.g. `SMART_RETRY_PASSIVE`, `RETRY_WITH_INCENTIVE`), and calculates optimal retry delay.
   - **Deterministic Policy Boundary Evaluation:** Proposed action is passed to `evaluateProposedAction` in `policy.service.ts` to check autonomy tier bounds, budget minor units, retry limits, and quiet hours.
   - **Action Branching (Autonomous Execution vs. Human Approval):**
     - *Branch A (Within Policy):* Case transitions to `executing`. Agent dispatches task to `payment_processing_queue` or native TTL holding queue (`retry_delay_holding_queue`).
     - *Branch B (Exceeds Policy / Requires Review):* Case transitions to `awaiting_approval`. Agent yields execution and waits for human operator action in Recovery Cockpit.
   - **Action Worker Execution & Outcome Ingestion:** `action.worker.ts` executes scheduled retry attempt. Upon payment outcome, case transitions to `recovered` (success) or re-enters recovery loop until retries exhaust into `unrecovered` or `suppressed`.
   - **Status:** The autonomous pipeline execution stages are **CURRENT / VERIFIED** for checkout abandonment and for unit/integration modules, but wiring payment failures to auto-advance through this pipeline is **TARGET / MISSING**.

## 5. Screens and Surfaces
- **Human-Facing UI Surfaces:**
  - **NOT APPLICABLE (0% by design).** The Internal Recovery Agent does not require or possess human-facing UI screens.
- **Supervisory and Observability Surfaces Consuming Agent State:**
  1. *Recovery Cockpit (`/recovery`):* Renders agent reasoning traces, latency, token consumption, and human-in-the-loop approval requests for Merchant Operators.
  2. *Certified Audit Export (`GET /api/audit/cases/:idOrRef/export`):* Packages agent prompt versions, step outputs, and event store records for Compliance Reviewers.
  3. *Operations Telemetry (`/metrics` & Grafana):* Streams agent execution metrics (`paybridge_recovery_duration_seconds`, `paybridge_recovery_rate`) for Platform Operations Engineers.

## 6. Backend APIs and Services
1. `server/src/workers/recovery.worker.ts`
   - Consumes failure signals from RabbitMQ `recovery_ingestion_queue` with prefetch throttling.
2. `server/src/workers/action.worker.ts`
   - Consumes approved recovery action tasks from `payment_processing_queue`.
3. `server/src/modules/recovery/case.state-machine.ts`
   - Enforces strict finite state transitions (`detected` -> `diagnosing` -> `deciding` -> `awaiting_approval` -> `executing` -> `recovered`/`unrecovered`).
4. `server/src/modules/ai/diagnosis/diagnosis.agent.ts`
   - Executes root-cause analysis prompt chains against configured LLM provider.
5. `server/src/modules/ai/decision/decision.agent.ts`
   - Formulates structured recovery action proposals and calculates optimal scheduling.
6. `server/src/modules/policy/policy.service.ts`
   - Deterministically evaluates proposed actions against merchant autonomy tier, budget, caps, and quiet hours.
7. `server/src/modules/ai/tracing/trace.service.ts` & `trace.repository.ts`
   - Writes immutable step-by-step reasoning traces and token metrics into MySQL `agent_traces`.

## 7. Data Visible to the Persona
- **Data Ingested by the Agent:**
  - Order metadata: amount, currency, order reference, customer email, created timestamp.
  - Payment transaction attempt data: gateway response code, failure reason string, payment method.
  - Historical customer payment velocity and past recovery attempts for that customer under the same `merchant_id`.
  - Active merchant policy configuration parameters.
- **Data Redacted / Hidden from the Agent:**
  - Raw credit card PANs, CVVs, expiry dates (never stored or processed by PayBridge, PCI-DSS scope minimization).
  - Customer emails, phone numbers, and card numbers (redacted to `[EMAIL_REDACTED]`, `[PHONE_REDACTED]`, `[CARD_REDACTED]` by context builder prior to LLM submission).
  - Cross-tenant payment or customer records.

## 8. Allowed Actions
- `signals:consume` — Consume failure signals from RabbitMQ (*verified active*).
- `cases:create` — Initialize recovery cases in database (*verified active*).
- `cases:transition` — Transition case states per state machine rules (*verified active*).
- `llm:query` — Invoke configured LLM provider for diagnosis and decision planning (*verified active*).
- `policy:evaluate` — Validate proposed actions against merchant policy (*verified active*).
- `traces:record` — Write sanitized reasoning steps to `agent_traces` (*verified active*).
- `actions:dispatch` — Enqueue approved recovery actions to message queues (*verified active*).

## 9. Forbidden / Restricted Actions
- **Unbounded Spending:** Must NOT execute recovery actions that exceed merchant daily budget or maximum incentive percentages.
- **Quiet Hours Violations:** Must NOT trigger direct customer outreach during merchant-defined quiet hours.
- **Autonomy Tier Escalation:** Must NOT execute actions autonomously when the merchant's active autonomy tier requires human approval.
- **Arbitrary State Mutation:** Must NOT bypass state machine transition rules (e.g. cannot transition directly from `detected` to `recovered`).
- **Direct Card Vaulting:** Must NOT store, transmit, or process raw cardholder PAN data.
- **Cross-Tenant Context Mixing:** Must NOT query or inject customer history from one merchant into another merchant's diagnosis prompt.

## 10. Current Implementation Status
- **Overall Persona Status:** `PARTIALLY IMPLEMENTED` (core agents and abandonment pipeline verified; payment-failure auto-advancement pipeline is target) / `NOT APPLICABLE` (for human UI).
  - Payment Failure Ingestion & Case Detection: `IMPLEMENTED` (ingests failure and initializes case in `detected` status).
  - Checkout Abandonment Recovery Pipeline: `IMPLEMENTED` (wired through `advanceCaseThroughRecoveryPipeline`).
  - End-to-End Payment Failure Auto-Advancement Pipeline: `MISSING / TARGET` (not currently wired to auto-advance beyond `detected`).
  - Recovery Ingestion Worker: `IMPLEMENTED` (`recovery.worker.ts`).
  - Action Worker: `IMPLEMENTED` (`action.worker.ts`).
  - State Machine Enforcement: `IMPLEMENTED` (`case.state-machine.ts`).
  - AI Diagnosis Agent: `IMPLEMENTED` (`diagnosis.agent.ts`).
  - AI Decision Planner: `IMPLEMENTED` (`decision.agent.ts`).
  - Deterministic Policy Engine: `IMPLEMENTED` (`policy.service.ts`).
  - Human-Facing UI: `NOT APPLICABLE` (by design).

## 11. Missing Implementation
- **Frontend Gaps:** None. A human UI for the agent is not required.
- **Backend / Algorithmic Gaps:**
  - Wiring payment failure ingestion to the full auto-advancement pipeline (`advanceCaseThroughRecoveryPipeline`).
  - Dynamic reinforcement learning / policy weight updating based on multi-week recovery outcomes (`AI-012`).
  - Multi-channel customer outreach adapters (e.g. live Twilio SMS or SendGrid integration; currently modeled as synthetic simulator).
- **Data / API Gaps:** None for baseline operation.
- **Operational / Security Gaps:**
  - Circuit breaker automatic tripping upon sustained LLM provider 429 quota exhaustion.

## 12. Smallest Implementation Slice
- **Status:** The baseline Internal Recovery Agent is **already implemented and operational** in the repository.
- **Maintenance Slice:** Monitor LLM provider quota handling and ensure mock provider fallback (`MockLLMProvider`) is engaged during continuous integration tests.

## 13. Acceptance Criteria
- [ ] Failure signal on `recovery_ingestion_queue` triggers case initialization within 1 second.
- [ ] Case transitions strictly follow `case.state-machine.ts` transition matrix.
- [ ] LLM diagnosis prompt receives PII-sanitized context and returns valid schema-compliant output.
- [ ] Agent decision proposing action exceeding merchant policy bounds transitions to `awaiting_approval`.
- [ ] Operator approval via `POST /api/recovery/cases/:caseId/actions` resumes case into `executing`.
- [ ] All reasoning steps, latencies, and token counts are recorded in MySQL `agent_traces`.
- [ ] Under zero circumstances does the agent process, store, or transmit unredacted credit card PANs.

## 14. Dependencies
- **Backend Services (Verified):** `server/src/workers/recovery.worker.ts`, `action.worker.ts`.
- **Infrastructure (Verified):** RabbitMQ exchanges (`payment_exchange`, `dlx_exchange`), Redis distributed lock client, MySQL database.
- **LLM Providers (Verified):** `MockLLMProvider`, `OmniRouteProvider`, `GeminiProvider`, `OpenAIProvider`.

## 15. Evidence / Source Notes
- Worker implementations: [`server/src/workers/recovery.worker.ts:1-110`](file:///Users/nishant/Documents/PayBridge/server/src/workers/recovery.worker.ts#L1-L110), [`server/src/workers/action.worker.ts:1-120`](file:///Users/nishant/Documents/PayBridge/server/src/workers/action.worker.ts#L1-L120).
- State machine rules: [`server/src/modules/recovery/case.state-machine.ts:1-85`](file:///Users/nishant/Documents/PayBridge/server/src/modules/recovery/case.state-machine.ts#L1-L85).
- Diagnosis & Decision agents: [`server/src/modules/ai/diagnosis/diagnosis.agent.ts:1-135`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/diagnosis/diagnosis.agent.ts#L1-L135), [`server/src/modules/ai/decision/decision.agent.ts:1-150`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/decision/decision.agent.ts#L1-L150).
- Policy enforcement engine: [`server/src/modules/policy/policy.service.ts:1-260`](file:///Users/nishant/Documents/PayBridge/server/src/modules/policy/policy.service.ts#L1-L260).
- Agent tracing repository: [`server/src/modules/ai/tracing/trace.repository.ts:1-140`](file:///Users/nishant/Documents/PayBridge/server/src/modules/ai/tracing/trace.repository.ts#L1-L140).
