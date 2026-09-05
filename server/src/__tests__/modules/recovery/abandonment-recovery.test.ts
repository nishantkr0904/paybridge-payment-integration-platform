import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ResultSetHeader } from 'mysql2/promise';
import type amqp from 'amqplib';
import { pool } from '../../../config/database.js';
import { connectRedis, disconnectRedis } from '../../../infrastructure/redis.js';
import { generateUlid } from '../../../utils/ulid.js';
import { createPolicy } from '../../../modules/policy/policy.repository.js';
import { findCaseEventsByCaseId } from '../../../modules/recovery/case.repository.js';
import { getCaseExplainability } from '../../../modules/recovery/explainability.service.js';
import {
  ingestAbandonmentRecovery
} from '../../../modules/recovery/abandonment-recovery.service.js';
import {
  handleCheckoutAbandonmentMessage,
  type RecoveryChannel
} from '../../../workers/recovery.worker.js';
import type { CheckoutAbandonedEvent } from '../../../modules/payment/abandonment.types.js';
import { checkOrderTimeout } from '../../../modules/payment/timeout-detector.service.js';

function createMockConsumeMessage(payload: unknown, headers: Record<string, unknown> = {}): amqp.ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: {} as never,
    properties: {
      headers: {
        'x-correlation-id': (headers['x-correlation-id'] as string) || generateUlid(),
        'x-trace-id': (headers['x-trace-id'] as string) || generateUlid(),
        ...headers
      },
      correlationId: (headers['x-correlation-id'] as string) || generateUlid()
    } as never
  } as unknown as amqp.ConsumeMessage;
}

describe('BT-D3: Integrate Checkout Abandonment with the Existing Autonomous Recovery Pipeline (SIG-002 / RCV-001 / Invariants I1, I2, I5, I9)', () => {
  let merchant1Id: number;
  let merchant2Id: number;

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      const email1 = `btd3_m1_${Date.now()}@example.com`;
      const email2 = `btd3_m2_${Date.now()}@example.com`;

      const [res1] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'BT-D3 Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = res1.insertId;

      const [res2] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'BT-D3 Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = res2.insertId;

      // Merchant 1: Autonomy Tier T1 (Requires Human Approval)
      await createPolicy(merchant1Id, {
        autonomyTier: 'T1',
        maxRetries: 3,
        maxIncentivePercent: 10,
        dailyBudgetMinorUnits: 500000,
        isActive: true
      });

      // Merchant 2: Autonomy Tier T3 (Autonomous Execution Approved)
      await createPolicy(merchant2Id, {
        autonomyTier: 'T3',
        maxRetries: 3,
        maxIncentivePercent: 15,
        dailyBudgetMinorUnits: 1000000,
        isActive: true
      });
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    await disconnectRedis();
  });

  describe('1. Ingestion & Case Creation', () => {
    it('creates a new recovery case in detected status when autoAdvance is false', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 75000, 'INR', 'pending')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const event: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        sessionId: 'sess_123',
        stage: 'details_entered',
        selectedPaymentMethod: 'card',
        dwellTimeSeconds: 420,
        validationFailureCount: 0,
        amountMinorUnits: 7500000,
        currency: 'INR',
        customerEmail: 'customer@example.com',
        hasConsentedChannel: true,
        lastActiveAt: new Date(Date.now() - 420000).toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'client_beacon',
        correlationId: `01CORR_${generateUlid()}`,
        traceId: `01TRACE_${generateUlid()}`
      };

      const result = await ingestAbandonmentRecovery(event, { autoAdvance: false });

      expect(result.isNew).toBe(true);
      expect(result.isDuplicate).toBe(false);
      expect(result.case).not.toBeNull();
      expect(result.case?.status).toBe('detected');
      expect(result.case?.recoverableAmount).toBe(7500000);
      expect(result.case?.originatingSignal).toBe('checkout.abandoned');
      expect(result.case?.failureCategory).toBe('CUSTOMER_ABANDONED');
      expect(result.case?.correlationId).toBe(event.correlationId);

      // Verify audit event written
      const events = await findCaseEventsByCaseId(result.case!.id, merchant1Id);
      expect(events.length).toBe(1);
      expect(events[0].toStatus).toBe('detected');
      expect(events[0].actorId).toBe('abandonment_worker');
    });

    it('advances a new abandonment case through the autonomous decision pipeline (Tier T1 -> awaiting_approval)', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 50000, 'INR', 'pending')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const event: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'method_selected',
        selectedPaymentMethod: 'upi',
        dwellTimeSeconds: 300,
        validationFailureCount: 0,
        amountMinorUnits: 5000000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date(Date.now() - 300000).toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'merchant_api',
        correlationId: `01CORR_${generateUlid()}`,
        traceId: `01TRACE_${generateUlid()}`
      };

      const result = await ingestAbandonmentRecovery(event, { autoAdvance: true });

      expect(result.isNew).toBe(true);
      expect(result.isDuplicate).toBe(false);
      expect(result.case).not.toBeNull();
      // Under Tier T1, the policy engine holds proposed actions for human operator approval
      expect(result.case?.status).toBe('awaiting_approval');
      expect(result.policyDecision).toBe('REQUIRES_HUMAN');
      expect(result.diagnosis).toBeDefined();
      expect(result.diagnosis?.category).toBe('CUSTOMER_ABANDONED');
      expect(result.decision).toBeDefined();
      expect(result.decision?.primaryAction?.actionType).toBe('CUSTOMER_OUTREACH');

      // Verify chronological case events trace the transition flow: detected -> diagnosing -> deciding -> awaiting_approval
      const events = await findCaseEventsByCaseId(result.case!.id, merchant1Id);
      const statuses = events.map((e) => e.toStatus);
      expect(statuses).toEqual(['detected', 'diagnosing', 'deciding', 'awaiting_approval']);
    });

    it('advances a new abandonment case through autonomous execution approval under Tier T3 (Tier T3 -> executing)', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 25000, 'INR', 'pending')`,
          [merchant2Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const event: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant2Id,
        orderId,
        orderRef,
        stage: 'details_entered',
        selectedPaymentMethod: 'card',
        dwellTimeSeconds: 600,
        validationFailureCount: 1,
        amountMinorUnits: 2500000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date(Date.now() - 600000).toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'timeout_detector',
        correlationId: `01CORR_${generateUlid()}`,
        traceId: `01TRACE_${generateUlid()}`
      };

      const result = await ingestAbandonmentRecovery(event, { autoAdvance: true });

      expect(result.isNew).toBe(true);
      expect(result.case?.status).toBe('executing');
      expect(result.policyDecision).toBe('APPROVED');
      expect(result.decision?.primaryAction?.actionType).toBe('CUSTOMER_OUTREACH');

      const events = await findCaseEventsByCaseId(result.case!.id, merchant2Id);
      const statuses = events.map((e) => e.toStatus);
      expect(statuses).toEqual(['detected', 'diagnosing', 'deciding', 'executing']);
    });
  });

  describe('2. Idempotency & Duplicate Suppression', () => {
    it('suppresses duplicate processing when identical abandonment event is ingested twice', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 40000, 'INR', 'pending')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const eventId = generateUlid();
      const event: CheckoutAbandonedEvent = {
        eventId,
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'method_selected',
        dwellTimeSeconds: 200,
        validationFailureCount: 0,
        amountMinorUnits: 4000000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date(Date.now() - 200000).toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'merchant_api',
        correlationId: `01CORR_${generateUlid()}`,
        traceId: `01TRACE_${generateUlid()}`
      };

      // Ingestion 1
      const res1 = await ingestAbandonmentRecovery(event, { autoAdvance: false });
      expect(res1.isNew).toBe(true);
      expect(res1.isDuplicate).toBe(false);

      // Ingestion 2 (identical event)
      const res2 = await ingestAbandonmentRecovery(event, { autoAdvance: false });
      expect(res2.isNew).toBe(false);
      expect(res2.isDuplicate).toBe(true);
      expect(res2.case?.id).toBe(res1.case?.id);

      // Verify no duplicate cases or duplicate events were created
      const events = await findCaseEventsByCaseId(res1.case!.id, merchant1Id);
      expect(events.length).toBe(1);
    });

    it('links subsequent abandonment events on the same order to the existing active case without duplication', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 60000, 'INR', 'pending')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      // Event 1: stage = method_selected
      const event1: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'method_selected',
        dwellTimeSeconds: 150,
        validationFailureCount: 0,
        amountMinorUnits: 6000000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date(Date.now() - 150000).toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'client_beacon',
        correlationId: `01CORR_1_${generateUlid()}`,
        traceId: `01TRACE_1_${generateUlid()}`
      };

      const res1 = await ingestAbandonmentRecovery(event1, { autoAdvance: false });
      expect(res1.isNew).toBe(true);

      // Event 2: customer resumes later, enters details, and abandons again (stage = details_entered)
      const event2: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'details_entered',
        dwellTimeSeconds: 450,
        validationFailureCount: 1,
        amountMinorUnits: 6000000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date(Date.now() - 450000).toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'client_beacon',
        correlationId: `01CORR_2_${generateUlid()}`,
        traceId: `01TRACE_2_${generateUlid()}`
      };

      const res2 = await ingestAbandonmentRecovery(event2, { autoAdvance: false });
      expect(res2.isNew).toBe(false);
      expect(res2.isDuplicate).toBe(false);
      expect(res2.case?.id).toBe(res1.case?.id);

      // Verify the case has both the creation event and the linked subsequent event
      const events = await findCaseEventsByCaseId(res1.case!.id, merchant1Id);
      expect(events.length).toBe(2);
      expect(events[1].reason).toContain('Subsequent checkout abandonment');
    });
  });

  describe('3. Tenant Isolation & Security (SEC-002 / Invariant I9)', () => {
    it('fails safely and rejects abandonment when orderId belongs to a different merchant', async () => {
      const conn = await pool.getConnection();
      let order1Id: number;
      const orderRef = generateUlid();

      try {
        // Create order owned by Merchant 1
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 30000, 'INR', 'pending')`,
          [merchant1Id, orderRef]
        );
        order1Id = ord.insertId;
      } finally {
        conn.release();
      }

      // Merchant 2 attempts to ingest abandonment referencing Merchant 1's order
      const crossTenantEvent: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant2Id, // Mismatched merchant!
        orderId: order1Id,
        orderRef,
        stage: 'method_selected',
        dwellTimeSeconds: 100,
        validationFailureCount: 0,
        amountMinorUnits: 3000000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'merchant_api',
        correlationId: `01CORR_CROSS_${generateUlid()}`,
        traceId: `01TRACE_CROSS_${generateUlid()}`
      };

      await expect(ingestAbandonmentRecovery(crossTenantEvent)).rejects.toThrow(
        `Order ${order1Id} does not exist or does not belong to merchant ${merchant2Id}`
      );
    });
  });

  describe('4. Terminal State Correctness & Non-Terminal Invariance', () => {
    it('skips abandonment recovery when order is already successfully paid (success)', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 20000, 'INR', 'success')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const event: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'details_entered',
        dwellTimeSeconds: 120,
        validationFailureCount: 0,
        amountMinorUnits: 2000000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'timeout_detector',
        correlationId: `01CORR_PAID_${generateUlid()}`,
        traceId: `01TRACE_PAID_${generateUlid()}`
      };

      const result = await ingestAbandonmentRecovery(event);
      expect(result.skipped).toBe(true);
      expect(result.skippedReason).toBe('ORDER_ALREADY_PAID');
      expect(result.case).toBeNull();
    });

    it('skips abandonment recovery when order is in failed state (failed)', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 15000, 'INR', 'failed')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const event: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'details_entered',
        dwellTimeSeconds: 120,
        validationFailureCount: 0,
        amountMinorUnits: 1500000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'timeout_detector',
        correlationId: `01CORR_FAILED_${generateUlid()}`,
        traceId: `01TRACE_FAILED_${generateUlid()}`
      };

      const result = await ingestAbandonmentRecovery(event);
      expect(result.skipped).toBe(true);
      expect(result.skippedReason).toBe('ORDER_ALREADY_FAILED');
      expect(result.case).toBeNull();
    });
  });

  describe('5. RabbitMQ Worker Integration (handleCheckoutAbandonmentMessage)', () => {
    it('successfully processes a valid message and acknowledges it', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 35000, 'INR', 'pending')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const event: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'details_entered',
        dwellTimeSeconds: 300,
        validationFailureCount: 0,
        amountMinorUnits: 3500000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'merchant_api',
        correlationId: `01CORR_RMQ_${generateUlid()}`,
        traceId: `01TRACE_RMQ_${generateUlid()}`
      };

      let ackCalled = false;
      let nackCalled = false;
      const mockChannel: RecoveryChannel = {
        ack: () => { ackCalled = true; },
        nack: () => { nackCalled = true; }
      };

      const msg = createMockConsumeMessage(event, {
        'x-correlation-id': event.correlationId,
        'x-trace-id': event.traceId
      });

      await handleCheckoutAbandonmentMessage(mockChannel, msg);

      expect(ackCalled).toBe(true);
      expect(nackCalled).toBe(false);
    });

    it('routes to DLQ (nack with requeue=false) when message contains invalid JSON', async () => {
      let ackCalled = false;
      let nackCalled = false;
      let nackRequeue: boolean | undefined;

      const mockChannel: RecoveryChannel = {
        ack: () => { ackCalled = true; },
        nack: (_m, _allUpTo, requeue) => {
          nackCalled = true;
          nackRequeue = requeue;
        }
      };

      const badMsg = {
        content: Buffer.from('{ invalid-json'),
        properties: { headers: {} }
      } as unknown as amqp.ConsumeMessage;

      await handleCheckoutAbandonmentMessage(mockChannel, badMsg);

      expect(ackCalled).toBe(false);
      expect(nackCalled).toBe(true);
      expect(nackRequeue).toBe(false);
    });

    it('routes to DLQ when message fails schema validation', async () => {
      let ackCalled = false;
      let nackCalled = false;
      let nackRequeue: boolean | undefined;

      const mockChannel: RecoveryChannel = {
        ack: () => { ackCalled = true; },
        nack: (_m, _allUpTo, requeue) => {
          nackCalled = true;
          nackRequeue = requeue;
        }
      };

      // Missing required eventId and invalid stage
      const invalidEvent = {
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        stage: 'invalid_stage'
      };

      const msg = createMockConsumeMessage(invalidEvent);

      await handleCheckoutAbandonmentMessage(mockChannel, msg);

      expect(ackCalled).toBe(false);
      expect(nackCalled).toBe(true);
      expect(nackRequeue).toBe(false);
    });

    it('routes to DLQ when order does not exist or violates tenant boundaries', async () => {
      let ackCalled = false;
      let nackCalled = false;
      let nackRequeue: boolean | undefined;

      const mockChannel: RecoveryChannel = {
        ack: () => { ackCalled = true; },
        nack: (_m, _allUpTo, requeue) => {
          nackCalled = true;
          nackRequeue = requeue;
        }
      };

      const ghostEvent: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId: 999999999, // Non-existent order
        orderRef: 'ORD_GHOST',
        stage: 'details_entered',
        dwellTimeSeconds: 100,
        validationFailureCount: 0,
        amountMinorUnits: 100000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'merchant_api',
        correlationId: `01CORR_GHOST_${generateUlid()}`,
        traceId: `01TRACE_GHOST_${generateUlid()}`
      };

      const msg = createMockConsumeMessage(ghostEvent);

      await handleCheckoutAbandonmentMessage(mockChannel, msg);

      expect(ackCalled).toBe(false);
      expect(nackCalled).toBe(true);
      expect(nackRequeue).toBe(false);
    });
  });

  describe('6. Compatibility with Unified Explainability (BT-C4 Integration)', () => {
    it('produces a full unified explainability payload for checkout abandonment recovery cases', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, ?, 85000, 'INR', 'pending')`,
          [merchant1Id, orderRef]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      const event: CheckoutAbandonedEvent = {
        eventId: generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant1Id,
        orderId,
        orderRef,
        stage: 'submit_attempted_failed_validation',
        selectedPaymentMethod: 'card',
        dwellTimeSeconds: 500,
        validationFailureCount: 2,
        amountMinorUnits: 8500000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: new Date().toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'client_beacon',
        correlationId: `01CORR_EXP_${generateUlid()}`,
        traceId: `01TRACE_EXP_${generateUlid()}`
      };

      const result = await ingestAbandonmentRecovery(event, { autoAdvance: true });
      expect(result.case).not.toBeNull();

      // Retrieve unified explainability for this abandonment recovery case
      const explainability = await getCaseExplainability(result.case!.id, merchant1Id);

      expect(explainability.case.caseRef).toBe(result.case?.caseRef);
      expect(explainability.case.originatingSignal).toBe('checkout.abandoned');
      expect(explainability.case.recoverableAmountMinorUnits).toBe(8500000);
      expect(explainability.diagnosis).not.toBeNull();
      expect(explainability.diagnosis?.category).toBe('CUSTOMER_ABANDONED');
      expect(explainability.decision).not.toBeNull();
      expect(explainability.policy).not.toBeNull();
      expect(explainability.policy?.evaluation?.decision).toBe('REQUIRES_HUMAN');
      expect(explainability.trace).not.toBeNull();
      expect(explainability.trace!.traces.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('7. Compatibility with D2 Timeout Detection End-to-End', () => {
    it('detects timeout on inactive order and flows through to recovery pipeline', async () => {
      const conn = await pool.getConnection();
      let orderId: number;
      const orderRef = generateUlid();

      // Seed order inactive since 20 minutes ago (1200 seconds dwell)
      const twentyMinutesAgo = new Date(Date.now() - 1200 * 1000);
      try {
        const [ord] = await conn.query<ResultSetHeader>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, created_at)
           VALUES (?, ?, 95000, 'INR', 'pending', ?)`,
          [merchant2Id, orderRef, twentyMinutesAgo]
        );
        orderId = ord.insertId;
      } finally {
        conn.release();
      }

      // Step 1: Detect timeout via D2 service (using 900s threshold)
      const detectResult = await checkOrderTimeout(orderRef, merchant2Id, {
        timeoutThresholdSeconds: 900,
        now: new Date(),
        correlationId: `01CORR_TIMEOUT_${generateUlid()}`
      });

      expect(detectResult.isAbandoned).toBe(true);

      // Step 2: Ingest the generated event through the D3 recovery pipeline
      const recoveryResult = await ingestAbandonmentRecovery({
        eventId: detectResult.eventId || generateUlid(),
        eventType: 'checkout.abandoned',
        merchantId: merchant2Id,
        orderId,
        orderRef,
        stage: detectResult.stage || 'details_entered',
        dwellTimeSeconds: detectResult.dwellTimeSeconds,
        validationFailureCount: 0,
        amountMinorUnits: 9500000,
        currency: 'INR',
        hasConsentedChannel: true,
        lastActiveAt: twentyMinutesAgo.toISOString(),
        abandonedAt: new Date().toISOString(),
        source: 'timeout_detector',
        correlationId: `01CORR_TIMEOUT_${generateUlid()}`,
        traceId: `01TRACE_TIMEOUT_${generateUlid()}`
      }, {
        autoAdvance: true
      });

      expect(recoveryResult.isNew).toBe(true);
      expect(recoveryResult.case).not.toBeNull();
      expect(recoveryResult.case?.originatingSignal).toBe('checkout.abandoned');
      expect(recoveryResult.case?.recoverableAmount).toBe(9500000);
      // Under Merchant 2's Tier T3 policy, recovery case is approved and enters 'executing'
      expect(recoveryResult.case?.status).toBe('executing');
      expect(recoveryResult.policyDecision).toBe('APPROVED');
    });
  });
});
