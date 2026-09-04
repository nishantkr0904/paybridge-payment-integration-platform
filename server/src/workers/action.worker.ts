import 'dotenv/config';
import type amqp from 'amqplib';
import { z } from 'zod';
import { getRabbitMQChannel, QUEUES, publishDelayedRetry, MIN_RETRY_DELAY_MS } from '../infrastructure/rabbitmq.js';
import { acquireLock, releaseLock } from '../infrastructure/redis.js';
import { findTransactionById, updateOrderStatus, updateTransactionStatus } from '../modules/payment/payment.repository.js';
import { findActivePolicyByMerchantId } from '../modules/policy/policy.repository.js';
import { findCaseById, findCaseEventsByCaseId } from '../modules/recovery/case.repository.js';
import { transitionCase } from '../modules/recovery/case.service.js';
import { TERMINAL_STATES } from '../modules/recovery/case.state-machine.js';
import {
  actionExecutionDuplicatesSuppressedTotal,
  actionExecutionsTotal,
  recordRecoveryAttempt
} from '../infrastructure/metrics.js';
import { logger } from '../utils/logger.js';
import { generateUlid } from '../utils/ulid.js';

/* ------------------------------------------------------------------ */
/*  Action Job Payload Schema (TASK-402 / RCV-010 / OBS-001)          */
/* ------------------------------------------------------------------ */

export const ActionJobPayloadSchema = z.object({
  merchantId: z.number().int().positive(),
  caseId: z.number().int().positive(),
  orderId: z.number().int().positive().optional(),
  transactionId: z.number().int().positive().optional(),
  orderRef: z.string().optional(),
  txnRef: z.string().optional(),
  amountMinorUnits: z.number().int().positive().optional(),
  currency: z.string().length(3).optional().default('INR'),
  retryAttempt: z.number().int().min(1).max(10).default(1),
  actionType: z.enum([
    'RETRY_PAYMENT',
    'DELAYED_RETRY',
    'CHARGE_PAYMENT',
    'CUSTOMER_OUTREACH',
    'ALTERNATE_PAYMENT_METHOD'
  ]).default('RETRY_PAYMENT'),
  policyEvaluationRef: z.string().min(1),
  correlationId: z.string().min(1),
  traceId: z.string().optional(),
  scheduledAt: z.string().optional(),
  executeAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export type ActionJobPayload = z.infer<typeof ActionJobPayloadSchema>;

export interface ActionChannel {
  ack(message: amqp.Message, allUpTo?: boolean): void;
  nack(message: amqp.Message, allUpTo?: boolean, requeue?: boolean): void;
}

export interface ActionGatewayResult {
  success: boolean;
  gatewayResponse: Record<string, unknown>;
  failureReason?: string;
  failureCategory?: string;
}

export type GatewayRunner = (
  paymentMethod: string,
  providerIdempotencyRef: string
) => ActionGatewayResult | Promise<ActionGatewayResult>;

export const WORKER_ACTION_LOCK_TTL_SECONDS = 30;

/* ------------------------------------------------------------------ */
/*  Default Gateway Simulator (Deterministic Provider Idempotency)    */
/* ------------------------------------------------------------------ */

export function defaultActionGatewayRunner(
  paymentMethod: string,
  providerIdempotencyRef: string
): ActionGatewayResult {
  return {
    success: true,
    gatewayResponse: {
      provider: 'paybridge-sim',
      method: paymentMethod,
      providerIdempotencyRef,
      authCode: generateUlid().slice(0, 12),
      processedAt: new Date().toISOString()
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Action Message Consumer (TASK-402 / RCV-010 / RTY-003 / POL-001)  */
/* ------------------------------------------------------------------ */

export async function handleActionMessage(
  channel: ActionChannel,
  msg: amqp.ConsumeMessage,
  gatewayRunner: GatewayRunner = defaultActionGatewayRunner
): Promise<void> {
  const correlationId =
    (msg.properties?.headers?.['x-correlation-id'] as string | undefined) ||
    (msg.properties?.headers?.traceId as string | undefined) ||
    msg.properties?.correlationId ||
    generateUlid();

  const traceId =
    (msg.properties?.headers?.['x-trace-id'] as string | undefined) ||
    correlationId;

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(msg.content.toString());
  } catch (err) {
    logger.error(
      { err, correlationId, traceId },
      '[Action Worker] Failed to parse message JSON, routing to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  // 1. Validate incoming payload schema (Requirement 2)
  const parseResult = ActionJobPayloadSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    logger.error(
      {
        errors: parseResult.error.errors,
        correlationId,
        traceId,
        rawPayload
      },
      '[Action Worker] Action job payload failed schema validation, routing to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  const payload = parseResult.data;
  const workerLogger = logger.child({
    correlationId,
    traceId,
    caseId: payload.caseId,
    merchantId: payload.merchantId,
    transactionId: payload.transactionId,
    actionType: payload.actionType,
    retryAttempt: payload.retryAttempt
  });

  // 2. Tenant isolation & entity existence check (Requirement 3)
  const recoveryCase = await findCaseById(payload.caseId, payload.merchantId);
  if (!recoveryCase) {
    workerLogger.error(
      { caseId: payload.caseId, merchantId: payload.merchantId },
      '[Action Worker] Case does not exist or does not belong to merchant, routing to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  const transaction = payload.transactionId
    ? await findTransactionById(payload.transactionId, payload.merchantId)
    : recoveryCase.transactionId
      ? await findTransactionById(recoveryCase.transactionId, payload.merchantId)
      : null;

  if (payload.transactionId && !transaction) {
    workerLogger.error(
      { transactionId: payload.transactionId, merchantId: payload.merchantId },
      '[Action Worker] Referenced transaction not found for merchant, routing to DLQ'
    );
    channel.nack(msg, false, false);
    return;
  }

  // 3. Pre-lock terminal check (Fast-path: no side effects on terminal state)
  if (TERMINAL_STATES.has(recoveryCase.status)) {
    workerLogger.info(
      { caseStatus: recoveryCase.status },
      `[Action Worker] Case ${payload.caseId} is already in terminal state '${recoveryCase.status}'. Safely acknowledging duplicate message.`
    );
    channel.ack(msg);
    return;
  }

  if (transaction && transaction.status === 'success') {
    workerLogger.info(
      { transactionStatus: transaction.status },
      `[Action Worker] Transaction ${transaction.id} is already in terminal 'success'. Transitioning case to recovered and acknowledging message.`
    );
    if (recoveryCase.status !== 'recovered') {
      await transitionCase(
        payload.caseId,
        payload.merchantId,
        'recovered',
        { type: 'system', id: 'action_worker' },
        'Transaction already succeeded externally',
        { transactionId: transaction.id },
        correlationId
      );
    }
    channel.ack(msg);
    return;
  }

  // 4. Deterministic Idempotency Key & Effect Ledger check (Requirement 6 / RCV-010)
  const idempotencyKey = `idem:${payload.caseId}:${payload.actionType}:${payload.retryAttempt}`;
  const caseEvents = await findCaseEventsByCaseId(payload.caseId, payload.merchantId);
  const existingExecutedEvent = caseEvents.find(
    (e) =>
      e.payload &&
      typeof e.payload === 'object' &&
      (e.payload as Record<string, unknown>).idempotencyKey === idempotencyKey &&
      (e.toStatus === 'recovered' || e.toStatus === 'unrecovered' || e.toStatus === 'awaiting_outcome')
  );

  if (existingExecutedEvent) {
    actionExecutionDuplicatesSuppressedTotal.inc({ action_type: payload.actionType });
    workerLogger.info(
      { idempotencyKey, recordedOutcome: existingExecutedEvent.toStatus },
      `[Action Worker] Duplicate delivery of action ${idempotencyKey} suppressed. Safely acknowledging message.`
    );
    channel.ack(msg);
    return;
  }

  // 5. Distributed Action Lock Acquisition (Requirement 7 / Invariant I1)
  const lockKey = `lock:worker:action:${payload.caseId}`;
  const ownerToken = generateUlid();
  const lockAcquired = await acquireLock(
    lockKey,
    WORKER_ACTION_LOCK_TTL_SECONDS,
    ownerToken
  );

  if (!lockAcquired) {
    workerLogger.warn(
      `[Action Worker] Case ${payload.caseId} is currently being processed by another worker. Requeueing message.`
    );
    channel.nack(msg, false, true);
    return;
  }

  try {
    // 6. Pre-Execution Policy Re-validation & Gating (Requirements 4, 5 / RCV-003)
    const policy = await findActivePolicyByMerchantId(payload.merchantId);
    if (!policy || !policy.isActive) {
      workerLogger.warn(
        `[Action Worker] Merchant policy is inactive or disabled. Cancelling action execution.`
      );
      await transitionCase(
        payload.caseId,
        payload.merchantId,
        'unrecovered',
        { type: 'system', id: 'action_worker' },
        'Merchant policy inactive or disabled during execution re-validation',
        { idempotencyKey, policyEvaluationRef: payload.policyEvaluationRef },
        correlationId
      );
      actionExecutionsTotal.inc({ action_type: payload.actionType, status: 'policy_disabled' });
      channel.ack(msg);
      return;
    }

    if (payload.retryAttempt > policy.maxRetries) {
      workerLogger.warn(
        { retryAttempt: payload.retryAttempt, maxRetries: policy.maxRetries },
        `[Action Worker] Retry attempt ${payload.retryAttempt} exceeds maximum allowable retries (${policy.maxRetries}). Marking unrecovered.`
      );
      await transitionCase(
        payload.caseId,
        payload.merchantId,
        'unrecovered',
        { type: 'system', id: 'action_worker' },
        `Max retries (${policy.maxRetries}) exceeded`,
        { idempotencyKey, policyEvaluationRef: payload.policyEvaluationRef, retryAttempt: payload.retryAttempt },
        correlationId
      );
      actionExecutionsTotal.inc({ action_type: payload.actionType, status: 'max_retries_exceeded' });
      channel.ack(msg);
      return;
    }

    // 7. Transition Case to 'executing' (Requirement 10)
    if (recoveryCase.status !== 'executing') {
      await transitionCase(
        payload.caseId,
        payload.merchantId,
        'executing',
        { type: 'system', id: 'action_worker' },
        `Action execution initiated (Attempt ${payload.retryAttempt})`,
        {
          idempotencyKey,
          policyEvaluationRef: payload.policyEvaluationRef,
          actionType: payload.actionType
        },
        correlationId
      );
    }
    recordRecoveryAttempt(payload.actionType);

    // 8. Execute Gateway Charge with Stable Idempotency Reference (Requirement 8)
    const baseTxnRef =
      payload.txnRef ||
      transaction?.txnRef ||
      `txn_${payload.transactionId || payload.caseId}`;

    const providerIdempotencyRef = `${baseTxnRef}_att${payload.retryAttempt}`;
    const paymentMethod = transaction?.paymentMethod || 'card';

    workerLogger.info(
      { providerIdempotencyRef, paymentMethod, attempt: payload.retryAttempt },
      `[Action Worker] Executing gateway charge via ${paymentMethod} (Attempt ${payload.retryAttempt})`
    );

    const gatewayResult = await gatewayRunner(paymentMethod, providerIdempotencyRef);

    // 9. Handle Execution Outcome (Requirements 10, 11, 12)
    if (gatewayResult.success) {
      workerLogger.info(
        { providerIdempotencyRef },
        `[Action Worker] Gateway charge succeeded. Transitioning case to recovered.`
      );

      if (transaction) {
        await updateTransactionStatus(transaction.id, payload.merchantId, 'success', gatewayResult.gatewayResponse);
        if (transaction.orderId) {
          await updateOrderStatus(transaction.orderId, payload.merchantId, 'success');
        }
      }

      await transitionCase(
        payload.caseId,
        payload.merchantId,
        'recovered',
        { type: 'system', id: 'action_worker' },
        'Payment successfully captured by action worker',
        {
          idempotencyKey,
          policyEvaluationRef: payload.policyEvaluationRef,
          providerIdempotencyRef,
          gatewayResponse: gatewayResult.gatewayResponse,
          retryAttempt: payload.retryAttempt,
          amountRecovered: recoveryCase.recoverableAmount,
          actionType: payload.actionType
        },
        correlationId
      );

      actionExecutionsTotal.inc({ action_type: payload.actionType, status: 'recovered' });
      channel.ack(msg);
    } else {
      const failureReason = gatewayResult.failureReason || 'Gateway declined payment';
      const isHardDecline =
        gatewayResult.failureCategory === 'ISSUER_HARD_DECLINE' ||
        gatewayResult.failureCategory === 'CARD_EXPIRED' ||
        gatewayResult.failureCategory === 'FRAUD_BLOCK';

      const canRetry = !isHardDecline && payload.retryAttempt < policy.maxRetries;

      if (canRetry) {
        // Schedule next delayed retry via TASK-401 delayed retry queue (Requirement 12)
        const nextAttempt = payload.retryAttempt + 1;
        const nextDelayMs = Math.max(MIN_RETRY_DELAY_MS, 60 * 1000 * Math.pow(2, payload.retryAttempt)); // Exponential backoff (min 1m)

        workerLogger.info(
          { nextAttempt, nextDelayMs, failureReason },
          `[Action Worker] Retry attempt ${payload.retryAttempt} declined (${failureReason}). Scheduling next retry (Attempt ${nextAttempt}) in ${nextDelayMs}ms.`
        );

        await publishDelayedRetry({
          payload: {
            merchantId: payload.merchantId,
            caseId: payload.caseId,
            orderId: payload.orderId,
            transactionId: payload.transactionId,
            orderRef: payload.orderRef,
            txnRef: payload.txnRef,
            amountMinorUnits: payload.amountMinorUnits,
            currency: payload.currency,
            retryAttempt: nextAttempt,
            actionType: payload.actionType,
            policyEvaluationRef: payload.policyEvaluationRef,
            correlationId,
            traceId,
            metadata: { previousFailureReason: failureReason }
          },
          delayMs: nextDelayMs
        });

        await transitionCase(
          payload.caseId,
          payload.merchantId,
          'awaiting_outcome',
          { type: 'system', id: 'action_worker' },
          `Retry attempt ${payload.retryAttempt} declined (${failureReason}). Next retry scheduled for +${nextDelayMs}ms.`,
          {
            idempotencyKey,
            policyEvaluationRef: payload.policyEvaluationRef,
            providerIdempotencyRef,
            failureReason,
            nextRetryAttempt: nextAttempt,
            nextDelayMs
          },
          correlationId
        );

        actionExecutionsTotal.inc({ action_type: payload.actionType, status: 'retry_scheduled' });
        channel.ack(msg);
      } else {
        workerLogger.warn(
          { attempt: payload.retryAttempt, failureReason, isHardDecline },
          `[Action Worker] Recovery attempts exhausted or hard decline encountered. Transitioning case to unrecovered.`
        );

        if (transaction) {
          await updateTransactionStatus(transaction.id, payload.merchantId, 'failed', gatewayResult.gatewayResponse, failureReason);
        }

        await transitionCase(
          payload.caseId,
          payload.merchantId,
          'unrecovered',
          { type: 'system', id: 'action_worker' },
          `Recovery failed: ${failureReason}`,
          {
            idempotencyKey,
            policyEvaluationRef: payload.policyEvaluationRef,
            providerIdempotencyRef,
            failureReason,
            retryAttempt: payload.retryAttempt
          },
          correlationId
        );

        actionExecutionsTotal.inc({ action_type: payload.actionType, status: 'unrecovered' });
        channel.ack(msg);
      }
    }
  } catch (error) {
    workerLogger.error(
      { error },
      '[Action Worker] Unexpected error during action execution'
    );
    // On unexpected error, route to DLQ without re-executing
    channel.nack(msg, false, false);
  } finally {
    await releaseLock(lockKey, ownerToken);
  }
}

/* ------------------------------------------------------------------ */
/*  Worker Startup & Graceful Shutdown Integration (Requirement 15)   */
/* ------------------------------------------------------------------ */

export async function startActionWorker(
  customChannel?: amqp.Channel,
  gatewayRunner: GatewayRunner = defaultActionGatewayRunner
): Promise<{ consumerTag: string; stop: () => Promise<void> }> {
  const ch = customChannel || (await getRabbitMQChannel());
  await ch.prefetch(1);

  const { consumerTag } = await ch.consume(
    QUEUES.PAYMENT_PROCESSING,
    (msg) => {
      if (msg) {
        handleActionMessage(ch, msg, gatewayRunner).catch((err) => {
          logger.error({ err }, '[Action Worker] Unhandled exception in handleActionMessage');
        });
      }
    },
    { noAck: false }
  );

  logger.info({ consumerTag }, '[Action Worker] Action handler worker started');

  return {
    consumerTag,
    stop: async () => {
      try {
        await ch.cancel(consumerTag);
        logger.info({ consumerTag }, '[Action Worker] Action handler worker stopped');
      } catch (err) {
        logger.error({ err, consumerTag }, '[Action Worker] Error cancelling consumer');
      }
    }
  };
}
