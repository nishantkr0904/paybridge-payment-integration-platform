import { recordAbandonmentRecoveryMetric } from '../../infrastructure/metrics.js';
import type { LLMProvider } from '../../infrastructure/llm/llm.types.js';
import { logger } from '../../utils/logger.js';
import { generateUlid } from '../../utils/ulid.js';
import { findOrderById } from '../payment/payment.repository.js';
import {
  CheckoutAbandonedEventSchema,
  type CheckoutAbandonedEvent
} from '../payment/abandonment.types.js';
import { buildRecoveryContext } from '../ai/context.builder.js';
import {
  executeDiagnosisWithTrace,
  executeDecisionWithTrace
} from '../ai/tracing/trace.orchestrator.js';
import type { DiagnosisResult } from '../ai/diagnosis/diagnosis.types.js';
import type { DecisionPlan } from '../ai/decision/decision.types.js';
import { evaluateProposedAction } from '../policy/policy.service.js';
import type { ProposedAction } from '../policy/policy.types.js';
import {
  addCaseEvent,
  createCaseWithEvent,
  findCaseByOrderId,
  findCaseEventsByCaseId
} from './case.repository.js';
import { transitionCase } from './case.service.js';
import { TERMINAL_STATES } from './case.state-machine.js';
import type { CaseStatus, RecoveryCase } from './case.types.js';

/* ------------------------------------------------------------------ */
/*  Abandonment Recovery Ingestion Options & Result Types             */
/* ------------------------------------------------------------------ */

export interface AbandonmentRecoveryOptions {
  llmProvider?: LLMProvider;
  autoAdvance?: boolean;
  evaluationTime?: Date;
}

export interface AbandonmentRecoveryResult {
  case: RecoveryCase | null;
  isNew: boolean;
  isDuplicate: boolean;
  isTerminal?: boolean;
  skipped?: boolean;
  skippedReason?: string;
  pipelineStatus?: CaseStatus;
  policyDecision?: string;
  diagnosis?: DiagnosisResult;
  decision?: DecisionPlan;
  correlationId: string;
  traceId: string;
}

export interface PipelineAdvanceOptions {
  llmProvider?: LLMProvider;
  evaluationTime?: Date;
}

export interface PipelineAdvanceResult {
  updatedCase: RecoveryCase;
  policyDecision?: string;
  diagnosis?: DiagnosisResult;
  decision?: DecisionPlan;
}

/* ------------------------------------------------------------------ */
/*  Core Abandonment Recovery Ingestion Service (BT-D3)               */
/* ------------------------------------------------------------------ */

/**
 * Ingests a qualifying checkout abandonment event into PayBridge's existing
 * recovery domain. Preserves tenant isolation, enforces idempotency, prevents
 * duplicate cases across sessions, and enters the existing recovery decision
 * pipeline (diagnosis -> decision -> policy evaluation).
 */
export async function ingestAbandonmentRecovery(
  rawEvent: CheckoutAbandonedEvent,
  options?: AbandonmentRecoveryOptions
): Promise<AbandonmentRecoveryResult> {
  // 1. Strict canonical schema validation
  const event = CheckoutAbandonedEventSchema.parse(rawEvent);
  const correlationId = event.correlationId || generateUlid();
  const traceId = event.traceId || correlationId;

  const recoveryLogger = logger.child({
    merchantId: event.merchantId,
    orderId: event.orderId,
    orderRef: event.orderRef,
    stage: event.stage,
    eventId: event.eventId,
    correlationId,
    traceId
  });

  recoveryLogger.info('[Abandonment Recovery] Ingesting checkout abandonment event into recovery domain');

  // 2. Tenant isolation & entity existence check (SEC-002, Invariant I9)
  const order = await findOrderById(event.orderId, event.merchantId);
  if (!order) {
    recoveryLogger.warn('[Abandonment Recovery] Order not found or cross-tenant access attempted');
    recordAbandonmentRecoveryMetric({ stage: event.stage, status: 'failed' });
    throw new Error(
      `Order ${event.orderId} does not exist or does not belong to merchant ${event.merchantId}`
    );
  }

  // 3. Terminal state check on underlying order: Paid orders must never enter recovery
  if (order.status === 'success') {
    recoveryLogger.info(
      { orderStatus: order.status },
      '[Abandonment Recovery] Order is already paid (success). Skipping recovery case creation.'
    );
    recordAbandonmentRecoveryMetric({ stage: event.stage, status: 'terminal_skipped' });
    return {
      case: null,
      isNew: false,
      isDuplicate: false,
      skipped: true,
      skippedReason: 'ORDER_ALREADY_PAID',
      correlationId,
      traceId
    };
  }

  if (order.status === 'failed') {
    recoveryLogger.info(
      { orderStatus: order.status },
      '[Abandonment Recovery] Order is already failed. Skipping checkout abandonment recovery.'
    );
    recordAbandonmentRecoveryMetric({ stage: event.stage, status: 'terminal_skipped' });
    return {
      case: null,
      isNew: false,
      isDuplicate: false,
      skipped: true,
      skippedReason: 'ORDER_ALREADY_FAILED',
      correlationId,
      traceId
    };
  }

  // 4. Idempotency & Case Deduplication (One case per order invariant / RCV-001)
  const existingCase = await findCaseByOrderId(event.orderId, event.merchantId);

  if (existingCase) {
    const existingEvents = await findCaseEventsByCaseId(existingCase.id, event.merchantId);

    // Exact event idempotency check
    const isDuplicate = existingEvents.some(
      (e) =>
        e.payload &&
        typeof e.payload === 'object' &&
        (e.payload as Record<string, unknown>).eventId === event.eventId
    );

    if (isDuplicate) {
      recoveryLogger.info(
        { caseId: existingCase.id, caseRef: existingCase.caseRef },
        '[Abandonment Recovery] Duplicate checkout abandonment event detected; suppressing duplicate processing.'
      );
      recordAbandonmentRecoveryMetric({ stage: event.stage, status: 'duplicate_suppressed' });
      return {
        case: existingCase,
        isNew: false,
        isDuplicate: true,
        pipelineStatus: existingCase.status,
        correlationId,
        traceId
      };
    }

    // If case is in terminal state, record audit event and do not re-open
    if (TERMINAL_STATES.has(existingCase.status)) {
      recoveryLogger.info(
        { caseId: existingCase.id, status: existingCase.status },
        `[Abandonment Recovery] Recovery case ${existingCase.caseRef} is already in terminal state '${existingCase.status}'. Skipping pipeline execution.`
      );
      recordAbandonmentRecoveryMetric({ stage: event.stage, status: 'terminal_skipped' });
      return {
        case: existingCase,
        isNew: false,
        isDuplicate: false,
        isTerminal: true,
        pipelineStatus: existingCase.status,
        correlationId,
        traceId
      };
    }

    // Active case exists: link subsequent abandonment event without duplicating case or resetting status
    recoveryLogger.info(
      { caseId: existingCase.id, currentStatus: existingCase.status },
      `[Abandonment Recovery] Linking subsequent abandonment event to active case ${existingCase.caseRef}`
    );

    await addCaseEvent(existingCase.id, event.merchantId, {
      fromStatus: existingCase.status,
      toStatus: existingCase.status,
      actorType: 'system',
      actorId: 'abandonment_worker',
      reason: `Subsequent checkout abandonment recorded at stage: ${event.stage}`,
      payload: {
        eventId: event.eventId,
        stage: event.stage,
        dwellTimeSeconds: event.dwellTimeSeconds,
        selectedPaymentMethod: event.selectedPaymentMethod || null,
        lastActiveAt: event.lastActiveAt,
        source: event.source
      },
      correlationId
    });

    recordAbandonmentRecoveryMetric({ stage: event.stage, status: 'linked' });

    return {
      case: existingCase,
      isNew: false,
      isDuplicate: false,
      pipelineStatus: existingCase.status,
      correlationId,
      traceId
    };
  }

  // 5. Create new recovery case in 'detected' status
  const createdCase = await createCaseWithEvent(
    event.merchantId,
    {
      orderId: event.orderId,
      transactionId: null,
      recoverableAmount: event.amountMinorUnits,
      currency: event.currency || 'INR',
      originatingSignal: 'checkout.abandoned',
      failureCategory: 'CUSTOMER_ABANDONED',
      correlationId,
      initialStatus: 'detected'
    },
    {
      fromStatus: null,
      toStatus: 'detected',
      actorType: 'system',
      actorId: 'abandonment_worker',
      reason: `Checkout abandonment detected at stage: ${event.stage}`,
      payload: {
        eventId: event.eventId,
        stage: event.stage,
        dwellTimeSeconds: event.dwellTimeSeconds,
        selectedPaymentMethod: event.selectedPaymentMethod || null,
        lastActiveAt: event.lastActiveAt,
        source: event.source
      },
      correlationId
    }
  );

  recoveryLogger.info(
    { caseId: createdCase.id, caseRef: createdCase.caseRef },
    `[Abandonment Recovery] Created new recovery case ${createdCase.caseRef} (status: detected)`
  );

  recordAbandonmentRecoveryMetric({ stage: event.stage, status: 'created' });

  // 6. Autonomous Pipeline Progression (diagnosis -> decision -> policy evaluation)
  const shouldAdvance = options?.autoAdvance !== false;
  if (!shouldAdvance) {
    return {
      case: createdCase,
      isNew: true,
      isDuplicate: false,
      pipelineStatus: 'detected',
      correlationId,
      traceId
    };
  }

  const advanceResult = await advanceCaseThroughRecoveryPipeline(createdCase, {
    llmProvider: options?.llmProvider,
    evaluationTime: options?.evaluationTime
  });

  return {
    case: advanceResult.updatedCase,
    isNew: true,
    isDuplicate: false,
    pipelineStatus: advanceResult.updatedCase.status,
    policyDecision: advanceResult.policyDecision,
    diagnosis: advanceResult.diagnosis,
    decision: advanceResult.decision,
    correlationId,
    traceId
  };
}

/* ------------------------------------------------------------------ */
/*  Autonomous Pipeline Execution (TASK-601 Architecture Reused)      */
/* ------------------------------------------------------------------ */

/**
 * Transitions a case from 'detected' through AI diagnosis, decision planning,
 * and deterministic policy evaluation into an approved or gated execution state.
 */
export async function advanceCaseThroughRecoveryPipeline(
  recoveryCase: RecoveryCase,
  options?: PipelineAdvanceOptions
): Promise<PipelineAdvanceResult> {
  const correlationId = recoveryCase.correlationId || generateUlid();
  const merchantId = recoveryCase.merchantId;
  const caseId = recoveryCase.id;

  const pipelineLogger = logger.child({
    caseId,
    caseRef: recoveryCase.caseRef,
    merchantId,
    correlationId
  });

  // Step 1: Transition 'detected' -> 'diagnosing'
  await transitionCase(
    caseId,
    merchantId,
    'diagnosing',
    { type: 'system', id: 'abandonment_pipeline' },
    'Initiating autonomous diagnosis for checkout abandonment',
    undefined,
    correlationId
  );

  // Step 2: Build Allowlisted, strictly PII-redacted context
  const context = await buildRecoveryContext({
    caseId,
    merchantId,
    correlationId
  });

  // Step 3: Execute Diagnosis Agent with complete provenance & fallback
  const { diagnosis } = await executeDiagnosisWithTrace(
    { context, correlationId },
    options?.llmProvider,
    merchantId,
    caseId
  );

  pipelineLogger.info(
    {
      category: diagnosis.category,
      strategy: diagnosis.recommendedStrategy,
      confidence: diagnosis.confidence
    },
    `[Abandonment Recovery] Diagnosis complete: ${diagnosis.category}`
  );

  // Step 4: Transition 'diagnosing' -> 'deciding'
  await transitionCase(
    caseId,
    merchantId,
    'deciding',
    { type: 'agent', id: 'diagnosis-agent' },
    `Diagnosis concluded ${diagnosis.category} (${diagnosis.recommendedStrategy})`,
    { diagnosis },
    correlationId
  );

  // Step 5: Execute Decision Agent with complete provenance & fallback
  const { decision } = await executeDecisionWithTrace(
    { context, diagnosis, correlationId },
    options?.llmProvider,
    merchantId,
    caseId
  );

  pipelineLogger.info(
    {
      planRationale: decision.planRationale,
      primaryActionType: decision.primaryAction?.actionType
    },
    `[Abandonment Recovery] Decision plan formulated`
  );

  // Step 6: Policy Engine Evaluation
  let policyDecision = 'REQUIRES_HUMAN';
  let targetStatus: CaseStatus = 'awaiting_approval';
  let policyMessage = 'Action submitted for human operator review';
  let policyRuleId = 'RULE_HUMAN_APPROVAL_REQUIRED';

  if (decision.primaryAction) {
    const proposedAction: ProposedAction = {
      actionType: decision.primaryAction.actionType as ProposedAction['actionType'],
      costMinorUnits: decision.primaryAction.costMinorUnits,
      incentivePercent: decision.primaryAction.incentivePercent
    };

    const policyEval = await evaluateProposedAction(
      merchantId,
      proposedAction,
      {
        evaluationTime: options?.evaluationTime || new Date(),
        correlationId,
        failureCategory: diagnosis.category
      }
    );

    policyDecision = policyEval.decision;
    policyMessage = policyEval.message;
    policyRuleId = policyEval.ruleId;

    if (policyEval.decision === 'APPROVED') {
      targetStatus = 'executing';
    } else if (policyEval.decision === 'REQUIRES_HUMAN') {
      targetStatus = 'awaiting_approval';
    } else {
      targetStatus = 'suppressed';
    }
  }

  pipelineLogger.info(
    { policyDecision, targetStatus, policyRuleId },
    `[Abandonment Recovery] Policy evaluation completed: ${policyDecision}`
  );

  // Step 7: Transition to final state based on policy decision
  const updatedCase = await transitionCase(
    caseId,
    merchantId,
    targetStatus,
    targetStatus === 'executing'
      ? { type: 'system', id: 'policy_engine' }
      : targetStatus === 'awaiting_approval'
        ? { type: 'agent', id: 'decision-agent' }
        : { type: 'system', id: 'policy_engine' },
    policyMessage,
    {
      policyEvaluationRef: policyRuleId,
      policyDecision,
      primaryAction: decision.primaryAction
    },
    correlationId
  );

  return {
    updatedCase,
    policyDecision,
    diagnosis,
    decision
  };
}
