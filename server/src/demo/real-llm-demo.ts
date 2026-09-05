import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { pool } from '../config/database.js';
import {
  createRawLLMProvider,
  loadLLMConfig,
  OrchestratedLLMProvider
} from '../infrastructure/llm/llm.provider.js';
import {
  LLMConfigurationError,
  LLMProvider,
  LLMRequest,
  LLMResponse
} from '../infrastructure/llm/llm.types.js';
import type {
  AbandonmentPaymentMethod,
  CheckoutAbandonedEvent,
  CheckoutAbandonmentStage
} from '../modules/payment/abandonment.types.js';
import { createPolicy, findActivePolicyByMerchantId } from '../modules/policy/policy.repository.js';
import { ingestAbandonmentRecovery } from '../modules/recovery/abandonment-recovery.service.js';
import { getCaseExplainability } from '../modules/recovery/explainability.service.js';
import { assertZeroPII } from '../modules/ai/redaction.service.js';
import { logger } from '../utils/logger.js';
import { generateUlid } from '../utils/ulid.js';

/* ------------------------------------------------------------------ */
/*  Types & Interfaces (E1 Demonstration Harness)                     */
/* ------------------------------------------------------------------ */

export type DemoExecutionMode = 'deterministic' | 'openai';

export interface RunDemoOptions {
  mode?: DemoExecutionMode;
  merchantId?: number;
  orderId?: number;
  orderRef?: string;
  amountMinorUnits?: number;
  currency?: string;
  stage?: CheckoutAbandonmentStage;
  selectedPaymentMethod?: AbandonmentPaymentMethod | null;
  dwellTimeSeconds?: number;
  correlationId?: string;
  traceId?: string;
  autonomyTier?: 'T1' | 'T2' | 'T3';
  customProvider?: LLMProvider;
}

export interface InvocationRecord {
  request: LLMRequest;
  response: LLMResponse;
  durationMs: number;
}

export interface RealLLMDemoResult {
  success: boolean;
  mode: DemoExecutionMode;
  provider: string;
  models: {
    diagnosis: string;
    decision: string;
  };
  scenario: {
    merchantId: number;
    orderId: number;
    orderRef: string;
    caseId: number;
    caseRef: string;
    stage: string;
    amountMinorUnits: number;
    amountFormatted: string;
    currency: string;
  };
  diagnosis: {
    category: string;
    strategy: string;
    confidence: number;
    rootCause: string;
    recoverable: boolean;
    source: 'model' | 'rules';
  } | null;
  decision: {
    planRationale: string;
    primaryAction: {
      actionType: string;
      toolName: string;
      costMinorUnits: number;
      incentivePercent: number;
      scheduledDelaySeconds: number;
    } | null;
    source: 'model' | 'rules';
  } | null;
  policy: {
    governingTier: string;
    decision: string;
    ruleId?: string;
    message?: string;
    targetStatus: string;
  } | null;
  observability: {
    correlationId: string;
    traceId: string;
    providerRequestId?: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  explainabilityRef: string;
  zeroPiiVerified: boolean;
}

/* ------------------------------------------------------------------ */
/*  Observing Provider Wrapper (Zero modification to core classes)     */
/* ------------------------------------------------------------------ */

export class ObservingLLMProviderWrapper implements LLMProvider {
  public readonly invocations: InvocationRecord[] = [];

  constructor(private readonly inner: LLMProvider) {}

  public async complete(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    const response = await this.inner.complete(request);
    const durationMs = Date.now() - startTime;
    this.invocations.push({ request, response, durationMs });
    return response;
  }
}

/* ------------------------------------------------------------------ */
/*  Provider Resolution (AI-001 / E1 Mode Selection)                  */
/* ------------------------------------------------------------------ */

export function resolveDemoProvider(
  mode: DemoExecutionMode,
  customProvider?: LLMProvider
): { provider: ObservingLLMProviderWrapper; providerName: string; models: { diagnosis: string; decision: string } } {
  const baseConfig = loadLLMConfig();

  if (customProvider) {
    const wrapper = new ObservingLLMProviderWrapper(customProvider);
    return {
      provider: wrapper,
      providerName: 'custom (injected)',
      models: {
        diagnosis: baseConfig.taskModelMapping.diagnosis,
        decision: baseConfig.taskModelMapping.decision
      }
    };
  }

  if (mode === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey.trim() === '') {
      throw new LLMConfigurationError(
        'OPENAI_API_KEY is required for real OpenAI demonstration mode.'
      );
    }

    const config = {
      ...baseConfig,
      aiEnabled: true,
      provider: 'openai' as const,
      openaiApiKey: apiKey.trim()
    };

    const rawProvider = createRawLLMProvider(config);
    const orchestrated = new OrchestratedLLMProvider(rawProvider, config);
    const wrapper = new ObservingLLMProviderWrapper(orchestrated);

    return {
      provider: wrapper,
      providerName: 'openai (OpenAIProvider via OrchestratedLLMProvider)',
      models: {
        diagnosis: config.taskModelMapping.diagnosis,
        decision: config.taskModelMapping.decision
      }
    };
  }

  // Deterministic mode (MockLLMProvider)
  const config = {
    ...baseConfig,
    aiEnabled: true,
    provider: 'mock' as const
  };

  const rawProvider = createRawLLMProvider(config);
  const orchestrated = new OrchestratedLLMProvider(rawProvider, config);
  const wrapper = new ObservingLLMProviderWrapper(orchestrated);

  return {
    provider: wrapper,
    providerName: 'mock (MockLLMProvider via OrchestratedLLMProvider)',
    models: {
      diagnosis: config.taskModelMapping.diagnosis,
      decision: config.taskModelMapping.decision
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Demo Merchant & Order Provisioning                                */
/* ------------------------------------------------------------------ */

export async function ensureDemoMerchantAndOrder(options?: RunDemoOptions): Promise<{
  merchantId: number;
  orderId: number;
  orderRef: string;
  amountMinorUnits: number;
  currency: string;
  autonomyTier: 'T1' | 'T2' | 'T3';
}> {
  const conn = await pool.getConnection();
  try {
    let merchantId = options?.merchantId;
    const autonomyTier = options?.autonomyTier || 'T1';

    if (!merchantId) {
      const demoEmail = `llm-demo-merchant-${autonomyTier.toLowerCase()}@paybridge.test`;
      const [existingUsers] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM users WHERE email = ? LIMIT 1`,
        [demoEmail]
      );

      if (existingUsers.length > 0 && existingUsers[0]?.id) {
        merchantId = existingUsers[0].id as number;
      } else {
        const [insertUser] = await conn.query<ResultSetHeader>(
          `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'demo_hash_not_for_login', ?, 'active')`,
          [demoEmail, `PayBridge Demo Merchant (${autonomyTier})`]
        );
        merchantId = insertUser.insertId;
      }

      // Ensure active governing policy exists matching requested autonomyTier
      const existingPolicy = await findActivePolicyByMerchantId(merchantId);
      if (!existingPolicy) {
        await createPolicy(merchantId, {
          autonomyTier,
          maxRetries: 3,
          maxIncentivePercent: 10,
          dailyBudgetMinorUnits: 500000,
          isActive: true
        });
      } else if (existingPolicy.autonomyTier !== autonomyTier) {
        await createPolicy(merchantId, {
          autonomyTier,
          maxRetries: existingPolicy.maxRetries || 3,
          maxIncentivePercent: existingPolicy.maxIncentivePercent || 10,
          dailyBudgetMinorUnits: existingPolicy.dailyBudgetMinorUnits || 500000,
          isActive: true
        });
      }
    }

    let orderId = options?.orderId;
    const orderRef = options?.orderRef || generateUlid();
    const amountMinorUnits = options?.amountMinorUnits || 50000; // ₹500.00
    const currency = options?.currency || 'INR';

    if (!orderId) {
      const amountDecimal = (amountMinorUnits / 100).toFixed(2);
      const [insertOrder] = await conn.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, customer_email) VALUES (?, ?, ?, ?, 'pending', 'customer@example.com')`,
        [merchantId, orderRef, amountDecimal, currency]
      );
      orderId = insertOrder.insertId;
    }

    return {
      merchantId,
      orderId,
      orderRef,
      amountMinorUnits,
      currency,
      autonomyTier
    };
  } finally {
    conn.release();
  }
}

/* ------------------------------------------------------------------ */
/*  Core Demonstration Execution (E1 Pipeline Harness)                */
/* ------------------------------------------------------------------ */

export async function runRealLLMDemo(options?: RunDemoOptions): Promise<RealLLMDemoResult> {
  // 1. Resolve execution mode (default to deterministic unless explicitly set)
  const mode: DemoExecutionMode =
    options?.mode ||
    (process.env.PAYBRIDGE_REAL_LLM_DEMO === 'true' || process.env.LLM_PROVIDER === 'openai'
      ? 'openai'
      : 'deterministic');

  const correlationId = options?.correlationId || `01DEMOCORR_${generateUlid()}`;
  const traceId = options?.traceId || `01DEMOTRACE_${generateUlid()}`;

  const demoLogger = logger.child({
    correlationId,
    traceId,
    mode
  });

  demoLogger.info(`[RealLLMDemo] Starting demonstration in mode: '${mode}'`);

  // 2. Resolve LLM provider
  const { provider: observingProvider, providerName, models } = resolveDemoProvider(
    mode,
    options?.customProvider
  );

  // 3. Ensure demo entities exist
  const {
    merchantId,
    orderId,
    orderRef,
    amountMinorUnits,
    currency,
    autonomyTier
  } = await ensureDemoMerchantAndOrder(options);

  // 4. Construct canonical CheckoutAbandonedEvent (BT-D1 / SIG-002)
  const stage: CheckoutAbandonmentStage = options?.stage || 'details_entered';
  const selectedPaymentMethod: AbandonmentPaymentMethod | null =
    options?.selectedPaymentMethod !== undefined ? options.selectedPaymentMethod : 'upi';
  const dwellTimeSeconds = options?.dwellTimeSeconds || 600;

  const event: CheckoutAbandonedEvent = {
    eventId: generateUlid(),
    eventType: 'checkout.abandoned',
    merchantId,
    orderId,
    orderRef,
    sessionId: `sess_${generateUlid()}`,
    stage,
    selectedPaymentMethod,
    dwellTimeSeconds,
    validationFailureCount: 0,
    amountMinorUnits,
    currency,
    customerEmail: 'customer@example.com',
    hasConsentedChannel: true,
    lastActiveAt: new Date(Date.now() - dwellTimeSeconds * 1000).toISOString(),
    abandonedAt: new Date().toISOString(),
    source: 'client_beacon',
    correlationId,
    traceId
  };

  // 5. Ingest event into the canonical autonomous recovery pipeline (BT-D3 / RCV-001)
  const ingestResult = await ingestAbandonmentRecovery(event, {
    autoAdvance: true,
    llmProvider: observingProvider
  });

  if (!ingestResult.case) {
    throw new Error(`Abandonment recovery case creation failed for order ${orderId}`);
  }

  const recoveryCase = ingestResult.case;

  // 6. Retrieve comprehensive unified explainability payload (BT-C4 / BEX-003)
  const explainability = await getCaseExplainability(recoveryCase.id, merchantId);

  // 7. Verify zero-PII invariant across entire explainability graph (SEC-002 / AI-009)
  assertZeroPII(explainability);

  // 8. Compute telemetry aggregations
  const invocations = observingProvider.invocations;
  const totalTokens = invocations.reduce((acc, inv) => acc + (inv.response.usage?.totalTokens || 0), 0);
  const inputTokens = invocations.reduce((acc, inv) => acc + (inv.response.usage?.inputTokens || 0), 0);
  const outputTokens = invocations.reduce((acc, inv) => acc + (inv.response.usage?.outputTokens || 0), 0);
  const totalDurationMs = invocations.reduce((acc, inv) => acc + inv.durationMs, 0);

  const lastResponse = invocations[invocations.length - 1]?.response;
  const providerRequestId = lastResponse?.providerRequestId;

  const amountFormatted = `₹${(amountMinorUnits / 100).toFixed(2)}`;

  const result: RealLLMDemoResult = {
    success: true,
    mode,
    provider: providerName,
    models,
    scenario: {
      merchantId,
      orderId,
      orderRef,
      caseId: recoveryCase.id,
      caseRef: recoveryCase.caseRef,
      stage,
      amountMinorUnits,
      amountFormatted,
      currency
    },
    diagnosis: explainability.diagnosis
      ? {
          category: explainability.diagnosis.category,
          strategy: explainability.diagnosis.recommendedStrategy,
          confidence: explainability.diagnosis.confidence,
          rootCause: explainability.diagnosis.rootCause,
          recoverable: explainability.diagnosis.recoverable,
          source: explainability.diagnosis.provenance?.source || 'model'
        }
      : null,
    decision: explainability.decision
      ? {
          planRationale: explainability.decision.planRationale,
          primaryAction: explainability.decision.primaryAction
            ? {
                actionType: explainability.decision.primaryAction.actionType,
                toolName: explainability.decision.primaryAction.toolName,
                costMinorUnits: explainability.decision.primaryAction.costMinorUnits,
                incentivePercent: explainability.decision.primaryAction.incentivePercent,
                scheduledDelaySeconds: explainability.decision.primaryAction.scheduledDelaySeconds
              }
            : null,
          source: explainability.decision.provenance?.source || 'model'
        }
      : null,
    policy: {
      governingTier: autonomyTier,
      decision: ingestResult.policyDecision || explainability.policy?.evaluation?.decision || 'UNKNOWN',
      ruleId: explainability.policy?.evaluation?.ruleId,
      message: explainability.policy?.evaluation?.message,
      targetStatus: recoveryCase.status
    },
    observability: {
      correlationId,
      traceId,
      providerRequestId,
      latencyMs: totalDurationMs,
      inputTokens,
      outputTokens,
      totalTokens
    },
    explainabilityRef: recoveryCase.caseRef,
    zeroPiiVerified: true
  };

  demoLogger.info(
    {
      caseRef: recoveryCase.caseRef,
      policyDecision: result.policy?.decision,
      totalTokens,
      totalDurationMs
    },
    '[RealLLMDemo] Demonstration scenario completed successfully'
  );

  return result;
}

/* ------------------------------------------------------------------ */
/*  Output Formatter (Clean, Human-Readable CLI Output)               */
/* ------------------------------------------------------------------ */

export function formatDemoOutput(result: RealLLMDemoResult): string {
  const lines: string[] = [];

  const sep = '='.repeat(80);
  const subSep = '-'.repeat(80);

  lines.push(sep);
  lines.push('           PAYBRIDGE AUTONOMOUS RECOVERY — REAL LLM DEMONSTRATION');
  lines.push(sep);
  lines.push(`Mode:                 ${result.mode === 'openai' ? 'REAL OPENAI MODE' : 'DETERMINISTIC MODE (Mock Provider)'}`);
  lines.push(`Provider:             ${result.provider}`);
  lines.push(`Models:               Diagnosis: ${result.models.diagnosis} | Decision: ${result.models.decision}`);
  lines.push(`Correlation ID:       ${result.observability.correlationId}`);
  lines.push(`Trace ID:             ${result.observability.traceId}`);
  if (result.observability.providerRequestId) {
    lines.push(`Provider Request ID:  ${result.observability.providerRequestId}`);
  }
  lines.push('');

  lines.push('--- 1. SCENARIO / ABANDONED CHECKOUT ---');
  lines.push(`Case Reference:       ${result.scenario.caseRef}`);
  lines.push(`Order Reference:      ${result.scenario.orderRef} (ID: ${result.scenario.orderId})`);
  lines.push(`Merchant ID:          ${result.scenario.merchantId}`);
  lines.push(`Stage:                ${result.scenario.stage}`);
  lines.push(`Recoverable Amount:   ${result.scenario.amountFormatted} (${result.scenario.amountMinorUnits} minor units, ${result.scenario.currency})`);
  lines.push('');

  lines.push('--- 2. AI DIAGNOSIS (AI-002 / AI-007) ---');
  if (result.diagnosis) {
    lines.push(`Source:               ${result.diagnosis.source}`);
    lines.push(`Category:             ${result.diagnosis.category}`);
    lines.push(`Recommended Strategy: ${result.diagnosis.strategy}`);
    lines.push(`Confidence:           ${Math.round(result.diagnosis.confidence * 100)}%`);
    lines.push(`Root Cause:           ${result.diagnosis.rootCause}`);
    lines.push(`Recoverable:          ${result.diagnosis.recoverable}`);
  } else {
    lines.push('Diagnosis:            None recorded');
  }
  lines.push('');

  lines.push('--- 3. RECOVERY DECISION & PLAYBOOK (AI-005 / AI-006) ---');
  if (result.decision) {
    lines.push(`Source:               ${result.decision.source}`);
    lines.push(`Plan Rationale:       ${result.decision.planRationale}`);
    if (result.decision.primaryAction) {
      const act = result.decision.primaryAction;
      lines.push(`Primary Action:       ${act.actionType} (${act.toolName})`);
      lines.push(`Cost / Incentive:     ₹${(act.costMinorUnits / 100).toFixed(2)} / ${act.incentivePercent}%`);
      lines.push(`Scheduled Delay:      ${act.scheduledDelaySeconds}s`);
    } else {
      lines.push('Primary Action:       None proposed');
    }
  } else {
    lines.push('Decision:             None recorded');
  }
  lines.push('');

  lines.push('--- 4. DETERMINISTIC POLICY GATE (RCV-002 / Invariant I5) ---');
  if (result.policy) {
    lines.push(`Governing Tier:       ${result.policy.governingTier}`);
    lines.push(`Policy Decision:      ${result.policy.decision}${result.policy.ruleId ? ` (${result.policy.ruleId})` : ''}`);
    lines.push(`Case Pipeline Status: ${result.policy.targetStatus}`);
    if (result.policy.message) {
      lines.push(`Policy Message:       ${result.policy.message}`);
    }
  } else {
    lines.push('Policy Evaluation:    None recorded');
  }
  lines.push('');

  lines.push('--- 5. OBSERVABILITY & ZERO-PII PROVENANCE ---');
  lines.push(`Explainability Ref:   ${result.explainabilityRef} (Unified Explainability Verified)`);
  lines.push(`Zero PII Check:       ${result.zeroPiiVerified ? 'PASSED (Zero PII invariant verified across all payloads)' : 'FAILED'}`);
  lines.push(`Total Latency:        ${result.observability.latencyMs}ms`);
  lines.push(`Token Telemetry:      Input: ${result.observability.inputTokens} | Output: ${result.observability.outputTokens} | Total: ${result.observability.totalTokens}`);
  lines.push('');

  lines.push(subSep);
  lines.push('Status: DEMO COMPLETED SUCCESSFULLY');
  lines.push(sep);

  return lines.join('\n');
}
