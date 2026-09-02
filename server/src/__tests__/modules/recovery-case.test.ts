import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import {
  canTransition,
  isTerminalStatus,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  validateTransition,
  InvalidCaseTransitionError
} from '../../modules/recovery/case.state-machine.js';
import {
  findCaseById,
  findCaseByRef,
  findCaseByTransactionId,
  findCasesByMerchantId
} from '../../modules/recovery/case.repository.js';
import {
  getCaseById,
  getCaseByRef,
  getCaseTimeline,
  ingestPaymentFailure,
  transitionCase
} from '../../modules/recovery/case.service.js';
import {
  handleRecoveryMessage,
  type RecoveryChannel
} from '../../workers/recovery.worker.js';
import type { PaymentFailedEvent } from '../../modules/recovery/case.types.js';
import { HttpError } from '../../utils/http-error.js';
import type amqp from 'amqplib';

describe('TASK-203: Recovery Case State Machine & Payment Failure Ingestion (RCV-001 / AT-RCV-001)', () => {
  let merchant1Id: number;
  let merchant2Id: number;
  let order1Id: number;
  let txn1Id: number;
  let order2Id: number;
  let txn2Id: number;

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      const email1 = `rcv_m1_${Date.now()}@example.com`;
      const email2 = `rcv_m2_${Date.now()}@example.com`;

      const [m1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Recovery Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (m1 as unknown as { insertId: number }).insertId;

      const [m2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Recovery Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (m2 as unknown as { insertId: number }).insertId;

      // Seed orders & transactions
      const [ord1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01RCVORDER0000000000000001', 50000, 'INR', 'failed')`,
        [merchant1Id]
      );
      order1Id = (ord1 as unknown as { insertId: number }).insertId;

      const [tx1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method) VALUES (?, '01RCVTXN00000000000000001', 50000, 'failed', 'upi')`,
        [order1Id]
      );
      txn1Id = (tx1 as unknown as { insertId: number }).insertId;

      const [ord2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01RCVORDER0000000000000002', 75000, 'INR', 'failed')`,
        [merchant2Id]
      );
      order2Id = (ord2 as unknown as { insertId: number }).insertId;

      const [tx2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method) VALUES (?, '01RCVTXN00000000000000002', 75000, 'failed', 'card')`,
        [order2Id]
      );
      txn2Id = (tx2 as unknown as { insertId: number }).insertId;
    } finally {
      conn.release();
    }
  });

  afterAll(async () => {
    const conn = await pool.getConnection();
    try {
      if (merchant1Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant1Id]);
      if (merchant2Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant2Id]);
    } finally {
      conn.release();
    }

    await disconnectRedis();
  });

  describe('1. Case State Machine & Transition Rules', () => {
    it('declares exactly the 12 canonical states and 5 terminal states', () => {
      const allStates = Object.keys(LEGAL_TRANSITIONS);
      expect(allStates.length).toBe(12);
      expect(TERMINAL_STATES.size).toBe(5);

      expect(isTerminalStatus('recovered')).toBe(true);
      expect(isTerminalStatus('unrecovered')).toBe(true);
      expect(isTerminalStatus('suppressed')).toBe(true);
      expect(isTerminalStatus('expired')).toBe(true);
      expect(isTerminalStatus('failed')).toBe(true);
      expect(isTerminalStatus('detected')).toBe(false);
      expect(isTerminalStatus('diagnosing')).toBe(false);
    });

    it('allows valid progressive transitions declared in the transition table', () => {
      expect(canTransition('detected', 'diagnosing')).toBe(true);
      expect(canTransition('diagnosing', 'scoring')).toBe(true);
      expect(canTransition('scoring', 'deciding')).toBe(true);
      expect(canTransition('deciding', 'awaiting_approval')).toBe(true);
      expect(canTransition('awaiting_approval', 'executing')).toBe(true);
      expect(canTransition('executing', 'awaiting_outcome')).toBe(true);
      expect(canTransition('awaiting_outcome', 'recovered')).toBe(true);
    });

    it('disallows illegal skips or transitions not in the table', () => {
      expect(canTransition('detected', 'executing')).toBe(false);
      expect(canTransition('diagnosing', 'recovered')).toBe(false);
      expect(canTransition('scoring', 'awaiting_outcome')).toBe(false);

      expect(() => validateTransition('detected', 'recovered')).toThrow(
        InvalidCaseTransitionError
      );
    });

    it('strictly forbids transitions out of terminal states', () => {
      for (const terminal of TERMINAL_STATES) {
        expect(canTransition(terminal, 'diagnosing')).toBe(false);
        expect(canTransition(terminal, 'executing')).toBe(false);
        expect(canTransition(terminal, 'detected')).toBe(false);

        expect(() => validateTransition(terminal, 'diagnosing')).toThrow(
          InvalidCaseTransitionError
        );
      }
    });
  });

  describe('2. Payment Failure Ingestion & Case Creation (AT-RCV-001)', () => {
    let createdCaseRef: string;
    let createdCaseId: number;

    it('ingests PaymentFailed event, creates Case in detected status, and appends initial event', async () => {
      const failureEvent: PaymentFailedEvent = {
        eventType: 'payment.failed',
        merchantId: merchant1Id,
        orderId: order1Id,
        transactionId: txn1Id,
        orderRef: '01RCVORDER0000000000000001',
        txnRef: '01RCVTXN00000000000000001',
        amount: 50000,
        currency: 'INR',
        failureCategory: 'INSUFFICIENT_FUNDS',
        failureReason: 'Insufficient funds',
        correlationId: '01RCVCORR00000000000000001'
      };

      const { case: rCase, isNew } = await ingestPaymentFailure(failureEvent);

      expect(isNew).toBe(true);
      expect(rCase.id).toBeDefined();
      expect(rCase.caseRef).toMatch(/^[0-9A-Z]{26}$/);
      expect(rCase.merchantId).toBe(merchant1Id);
      expect(rCase.orderId).toBe(order1Id);
      expect(rCase.transactionId).toBe(txn1Id);
      expect(rCase.status).toBe('detected');
      expect(rCase.recoverableAmount).toBe(50000);
      expect(rCase.currency).toBe('INR');
      expect(rCase.originatingSignal).toBe('payment.failed');
      expect(rCase.failureCategory).toBe('INSUFFICIENT_FUNDS');
      expect(rCase.correlationId).toBe('01RCVCORR00000000000000001');

      createdCaseRef = rCase.caseRef;
      createdCaseId = rCase.id;

      // Verify CaseCreated event is logged in event store
      const timeline = await getCaseTimeline(rCase.id, merchant1Id);
      expect(timeline.length).toBe(1);
      expect(timeline[0].caseId).toBe(rCase.id);
      expect(timeline[0].merchantId).toBe(merchant1Id);
      expect(timeline[0].fromStatus).toBeNull();
      expect(timeline[0].toStatus).toBe('detected');
      expect(timeline[0].actorType).toBe('system');
      expect(timeline[0].actorId).toBe('payment_worker');
      expect(timeline[0].correlationId).toBe('01RCVCORR00000000000000001');
    });

    it('handles duplicate PaymentFailed events idempotently on natural key', async () => {
      const duplicateEvent: PaymentFailedEvent = {
        eventType: 'payment.failed',
        merchantId: merchant1Id,
        orderId: order1Id,
        transactionId: txn1Id,
        amount: 50000,
        currency: 'INR',
        correlationId: '01RCVCORR_DUP_000000000001'
      };

      const { case: rCase, isNew } = await ingestPaymentFailure(duplicateEvent);

      expect(isNew).toBe(false);
      expect(rCase.id).toBe(createdCaseId);
      expect(rCase.caseRef).toBe(createdCaseRef);

      // Verify no duplicate row was created in database
      const cases = await findCasesByMerchantId(merchant1Id);
      const matchingCases = cases.filter((c) => c.transactionId === txn1Id);
      expect(matchingCases.length).toBe(1);
    });

    it('transitions case lifecycle step-by-step and records immutable event trail', async () => {
      // 1. Transition detected -> diagnosing
      const c1 = await transitionCase(
        createdCaseId,
        merchant1Id,
        'diagnosing',
        { type: 'system', id: 'recovery_orchestrator' },
        'Starting automated root-cause diagnosis',
        { signal: 'payment.failed' },
        '01RCVCORR_STEP1_0000000001'
      );
      expect(c1.status).toBe('diagnosing');

      // 2. Transition diagnosing -> deciding
      const c2 = await transitionCase(
        createdCaseId,
        merchant1Id,
        'deciding',
        { type: 'agent', id: 'decision_agent' },
        'Diagnosis complete: temporary decline, proposing retry',
        { proposedAction: 'RETRY_PAYMENT' },
        '01RCVCORR_STEP2_0000000001'
      );
      expect(c2.status).toBe('deciding');

      // 3. Transition deciding -> executing
      const c3 = await transitionCase(
        createdCaseId,
        merchant1Id,
        'executing',
        { type: 'agent', id: 'action_dispatcher' },
        'Policy approved retry execution',
        { policyVersion: 1 },
        '01RCVCORR_STEP3_0000000001'
      );
      expect(c3.status).toBe('executing');

      // 4. Transition executing -> recovered (Terminal)
      const c4 = await transitionCase(
        createdCaseId,
        merchant1Id,
        'recovered',
        { type: 'system', id: 'payment_gateway' },
        'Payment retry settled successfully',
        { recoveredAmount: 50000 },
        '01RCVCORR_STEP4_0000000001'
      );
      expect(c4.status).toBe('recovered');

      // Verify complete timeline in event store
      const timeline = await getCaseTimeline(createdCaseId, merchant1Id);
      expect(timeline.length).toBe(5); // initial + 4 transitions
      expect(timeline.map((e) => e.toStatus)).toEqual([
        'detected',
        'diagnosing',
        'deciding',
        'executing',
        'recovered'
      ]);

      // Verify cannot transition out of terminal recovered state
      await expect(
        transitionCase(
          createdCaseId,
          merchant1Id,
          'executing',
          { type: 'system' }
        )
      ).rejects.toThrow(InvalidCaseTransitionError);
    });
  });

  describe('3. Repository-Layer Tenant Isolation (Invariant I9)', () => {
    it('strictly isolates cases between merchants at SQL query boundary', async () => {
      // Create case for Merchant 2
      const m2Event: PaymentFailedEvent = {
        eventType: 'payment.failed',
        merchantId: merchant2Id,
        orderId: order2Id,
        transactionId: txn2Id,
        amount: 75000,
        currency: 'INR',
        failureCategory: 'ISSUER_HARD_DECLINE',
        correlationId: '01M2CORR0000000000000000001'
      };

      const { case: m2Case } = await ingestPaymentFailure(m2Event);

      // Same merchant can retrieve case
      const ownCase = await findCaseById(m2Case.id, merchant2Id);
      expect(ownCase).not.toBeNull();
      expect(ownCase?.id).toBe(m2Case.id);

      // Foreign merchant query by ID returns NULL
      const foreignCaseById = await findCaseById(m2Case.id, merchant1Id);
      expect(foreignCaseById).toBeNull();

      // Foreign merchant query by Ref returns NULL
      const foreignCaseByRef = await findCaseByRef(m2Case.caseRef, merchant1Id);
      expect(foreignCaseByRef).toBeNull();

      // Foreign merchant query by TransactionId returns NULL
      const foreignCaseByTxn = await findCaseByTransactionId(txn2Id, merchant1Id);
      expect(foreignCaseByTxn).toBeNull();

      // Service layer throws 404 CASE_NOT_FOUND for foreign merchant
      await expect(getCaseById(m2Case.id, merchant1Id)).rejects.toThrow(HttpError);
      await expect(getCaseByRef(m2Case.caseRef, merchant1Id)).rejects.toThrow(HttpError);
      await expect(getCaseTimeline(m2Case.id, merchant1Id)).rejects.toThrow(HttpError);

      // Foreign merchant transition fails closed
      await expect(
        transitionCase(m2Case.id, merchant1Id, 'diagnosing', { type: 'system' })
      ).rejects.toThrow();
    });
  });

  describe('4. Recovery Ingestion Worker & Message Safety', () => {
    it('acknowledges message after successful durable case ingestion', async () => {
      const mockChannel: RecoveryChannel = {
        ack: vi.fn(),
        nack: vi.fn()
      };

      // Create new transaction for worker test
      let workerTxnId: number;
      const conn = await pool.getConnection();
      try {
        const [tx] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method) VALUES (?, '01WRKTXN000000000000000001', 30000, 'failed', 'upi')`,
          [order1Id]
        );
        workerTxnId = (tx as unknown as { insertId: number }).insertId;
      } finally {
        conn.release();
      }

      const validPayload = {
        eventType: 'payment.failed',
        merchantId: merchant1Id,
        orderId: order1Id,
        transactionId: workerTxnId,
        amount: 30000,
        currency: 'INR',
        failureCategory: 'GATEWAY_TIMEOUT',
        failureReason: 'Gateway timeout'
      };

      const mockMessage = {
        content: Buffer.from(JSON.stringify(validPayload)),
        properties: {
          headers: { 'x-correlation-id': '01WRKCORR0000000000000001' }
        }
      } as unknown as amqp.ConsumeMessage;

      await handleRecoveryMessage(mockChannel, mockMessage);

      expect(mockChannel.ack).toHaveBeenCalledWith(mockMessage);
      expect(mockChannel.nack).not.toHaveBeenCalled();

      // Verify case was created in DB
      const created = await findCaseByTransactionId(workerTxnId, merchant1Id);
      expect(created).not.toBeNull();
      expect(created?.status).toBe('detected');
      expect(created?.recoverableAmount).toBe(30000);
    });

    it('nacks malformed JSON message to DLQ without crashing', async () => {
      const mockChannel: RecoveryChannel = {
        ack: vi.fn(),
        nack: vi.fn()
      };

      const malformedMessage = {
        content: Buffer.from('invalid-non-json-string{'),
        properties: {}
      } as unknown as amqp.ConsumeMessage;

      await handleRecoveryMessage(mockChannel, malformedMessage);

      expect(mockChannel.nack).toHaveBeenCalledWith(malformedMessage, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });

    it('nacks payload missing required fields to DLQ', async () => {
      const mockChannel: RecoveryChannel = {
        ack: vi.fn(),
        nack: vi.fn()
      };

      const incompletePayload = {
        eventType: 'payment.failed',
        // missing merchantId, orderId, transactionId
        amount: 30000
      };

      const mockMessage = {
        content: Buffer.from(JSON.stringify(incompletePayload)),
        properties: {}
      } as unknown as amqp.ConsumeMessage;

      await handleRecoveryMessage(mockChannel, mockMessage);

      expect(mockChannel.nack).toHaveBeenCalledWith(mockMessage, false, false);
      expect(mockChannel.ack).not.toHaveBeenCalled();
    });
  });
});
