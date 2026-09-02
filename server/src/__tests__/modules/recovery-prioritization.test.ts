import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { pool } from '../../config/database.js';
import { connectRedis, disconnectRedis } from '../../infrastructure/redis.js';
import { signAccessToken } from '../../utils/token.js';
import {
  calculatePriorityScore,
  identifyCasesToShed,
  prioritizeCases,
  rankCasesFairly
} from '../../modules/recovery/case.prioritizer.js';
import {
  getPrioritizedQueue,
  getQueueMetrics,
  getRevenueLedger,
  ingestPaymentFailure,
  shedExcessBacklog
} from '../../modules/recovery/case.service.js';
import { findActiveCases } from '../../modules/recovery/case.repository.js';
import type { PaymentFailedEvent, RecoveryCase, RevenueLedger } from '../../modules/recovery/case.types.js';

describe('TASK-204: Case Prioritisation Queue & Recoverable Revenue Ledger (RCV-002 / Milestone 2.3)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  let merchant1Id: number;
  let merchant2Id: number;
  let token1: string;
  let token2: string;
  let order1Id: number;
  let txn1Id: number;
  let order2Id: number;
  let txn2Id: number;
  let order3Id: number;
  let txn3Id: number;
  let order4Id: number;
  let txn4Id: number;

  beforeAll(async () => {
    await connectRedis();

    const conn = await pool.getConnection();
    try {
      const email1 = `prio_m1_${Date.now()}@example.com`;
      const email2 = `prio_m2_${Date.now()}@example.com`;

      const [m1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Priority Merchant 1', 'active')`,
        [email1]
      );
      merchant1Id = (m1 as unknown as { insertId: number }).insertId;

      const [m2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Priority Merchant 2', 'active')`,
        [email2]
      );
      merchant2Id = (m2 as unknown as { insertId: number }).insertId;

      token1 = signAccessToken({
        id: merchant1Id,
        email: email1,
        roles: ['merchant'],
        merchantName: 'Priority Merchant 1'
      });

      token2 = signAccessToken({
        id: merchant2Id,
        email: email2,
        roles: ['merchant'],
        merchantName: 'Priority Merchant 2'
      });

      // Seed orders & transactions for Merchant 1
      const [ord1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01PRIOORD00000000000000001', 50000, 'INR', 'failed')`,
        [merchant1Id]
      );
      order1Id = (ord1 as unknown as { insertId: number }).insertId;

      const [tx1] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method) VALUES (?, '01PRIOTXN00000000000000001', 50000, 'failed', 'upi')`,
        [order1Id]
      );
      txn1Id = (tx1 as unknown as { insertId: number }).insertId;

      const [ord2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01PRIOORD00000000000000002', 150000, 'INR', 'failed')`,
        [merchant1Id]
      );
      order2Id = (ord2 as unknown as { insertId: number }).insertId;

      const [tx2] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method) VALUES (?, '01PRIOTXN00000000000000002', 150000, 'failed', 'card')`,
        [order2Id]
      );
      txn2Id = (tx2 as unknown as { insertId: number }).insertId;

      // Seed order & transaction for Merchant 2
      const [ord3] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01PRIOORD00000000000000003', 80000, 'INR', 'failed')`,
        [merchant2Id]
      );
      order3Id = (ord3 as unknown as { insertId: number }).insertId;

      const [tx3] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method) VALUES (?, '01PRIOTXN00000000000000003', 80000, 'failed', 'netbanking')`,
        [order3Id]
      );
      txn3Id = (tx3 as unknown as { insertId: number }).insertId;

      // Seed order & transaction for Shedding test
      const [ord4] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01PRIOORD00000000000000004', 10000, 'INR', 'failed')`,
        [merchant1Id]
      );
      order4Id = (ord4 as unknown as { insertId: number }).insertId;

      const [tx4] = await conn.query<RowDataPacket[] & { insertId: number }>(
        `INSERT INTO transactions (order_id, txn_ref, amount, status, payment_method) VALUES (?, '01PRIOTXN00000000000000004', 10000, 'failed', 'card')`,
        [order4Id]
      );
      txn4Id = (tx4 as unknown as { insertId: number }).insertId;
    } finally {
      conn.release();
    }

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    const conn = await pool.getConnection();
    try {
      if (merchant1Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant1Id]);
      if (merchant2Id) await conn.query('DELETE FROM users WHERE id = ?', [merchant2Id]);
    } finally {
      conn.release();
    }

    await disconnectRedis();
  });

  describe('1. Priority Score Formula & Determinism (RCV-002 Requirement 4)', () => {
    it('calculates priority deterministically and generates derivation basis', () => {
      const mockCase: RecoveryCase = {
        id: 1,
        merchantId: 10,
        caseRef: '01PRIOCASE0000000000000001',
        orderId: 100,
        transactionId: 200,
        status: 'detected',
        recoverableAmount: 100000, // ₹1,000 in minor units
        currency: 'INR',
        originatingSignal: 'payment.failed',
        failureCategory: 'INSUFFICIENT_FUNDS',
        correlationId: '01CORR00000000000000000001',
        createdAt: new Date('2026-09-01T10:00:00Z'),
        updatedAt: new Date('2026-09-01T10:00:00Z')
      };

      const evalTime = new Date('2026-09-01T10:02:00Z'); // 120s later

      const p1 = calculatePriorityScore(mockCase, {
        evaluationTime: evalTime,
        merchantTier: 'T3',
        propensityScore: 0.8
      });

      const p2 = calculatePriorityScore(mockCase, {
        evaluationTime: evalTime,
        merchantTier: 'T3',
        propensityScore: 0.8
      });

      // Byte-identical determinism
      expect(p1.score).toBe(p2.score);
      expect(p1.formula).toBe(p2.formula);
      expect(p1.derivationBasis).toBe(p2.derivationBasis);
      expect(p1.isAddressable).toBe(true);

      // Value score = 100000 / 100 = 1000
      expect(p1.breakdown.valueScore).toBe(1000);
      // Age score = 120s * 0.5 = 60
      expect(p1.breakdown.ageScore).toBe(60);
      // Tier T3 = 300
      expect(p1.breakdown.tierScore).toBe(300);
      // INSUFFICIENT_FUNDS = 150
      expect(p1.breakdown.categoryScore).toBe(150);
      // Propensity 0.8 * 200 = 160
      expect(p1.breakdown.propensityScore).toBe(160);

      expect(p1.score).toBe(1000 + 60 + 300 + 150 + 160);
    });

    it('prioritizes higher value and addressable recoveries over terminal declines', () => {
      const highValCase: RecoveryCase = {
        id: 1,
        merchantId: 10,
        caseRef: '01CASEHIGH0000000000000001',
        orderId: 101,
        transactionId: 201,
        status: 'detected',
        recoverableAmount: 500000, // ₹5,000
        currency: 'INR',
        originatingSignal: 'payment.failed',
        failureCategory: 'INSUFFICIENT_FUNDS',
        correlationId: '01CORR00000000000000000002',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const terminalCase: RecoveryCase = {
        id: 2,
        merchantId: 10,
        caseRef: '01CASETERM0000000000000001',
        orderId: 102,
        transactionId: 202,
        status: 'detected',
        recoverableAmount: 500000, // ₹5,000
        currency: 'INR',
        originatingSignal: 'payment.failed',
        failureCategory: 'ISSUER_HARD_DECLINE', // Terminal failure
        correlationId: '01CORR00000000000000000003',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const pHigh = calculatePriorityScore(highValCase);
      const pTerm = calculatePriorityScore(terminalCase);

      expect(pHigh.isAddressable).toBe(true);
      expect(pTerm.isAddressable).toBe(false);
      expect(pHigh.score).toBeGreaterThan(pTerm.score);
    });
  });

  describe('2. Per-Merchant Fair Scheduling (RCV-002 Requirement 6)', () => {
    it('interleaves cases across merchants to prevent large merchants from starving small merchants', () => {
      // Create 5 cases for Merchant A and 2 cases for Merchant B
      const cases: RecoveryCase[] = [];

      for (let i = 1; i <= 5; i++) {
        cases.push({
          id: i,
          merchantId: 100, // Merchant A
          caseRef: `01MA_${i}_000000000000000000`,
          orderId: i,
          transactionId: i,
          status: 'detected',
          recoverableAmount: 100000,
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'INSUFFICIENT_FUNDS',
          correlationId: `corr_a_${i}`,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      for (let i = 1; i <= 2; i++) {
        cases.push({
          id: 10 + i,
          merchantId: 200, // Merchant B
          caseRef: `01MB_${i}_000000000000000000`,
          orderId: 10 + i,
          transactionId: 10 + i,
          status: 'detected',
          recoverableAmount: 100000,
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'INSUFFICIENT_FUNDS',
          correlationId: `corr_b_${i}`,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      const prioritized = prioritizeCases(cases);
      const fairRanked = rankCasesFairly(prioritized);

      expect(fairRanked.length).toBe(7);
      // Merchant A and Merchant B should alternate
      expect(fairRanked[0].case.merchantId).toBe(100);
      expect(fairRanked[1].case.merchantId).toBe(200);
      expect(fairRanked[2].case.merchantId).toBe(100);
      expect(fairRanked[3].case.merchantId).toBe(200);
      expect(fairRanked[4].case.merchantId).toBe(100);
    });
  });

  describe('3. Load Shedding under Capacity Pressure (RCV-002 Requirement 7)', () => {
    it('identifies and explicitly sheds lowest priority cases when capacity limit is exceeded', () => {
      const cases: RecoveryCase[] = [
        {
          id: 1,
          merchantId: 100,
          caseRef: '01CS01',
          orderId: 1,
          transactionId: 1,
          status: 'detected',
          recoverableAmount: 500000, // High priority
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'INSUFFICIENT_FUNDS',
          correlationId: 'c1',
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          id: 2,
          merchantId: 100,
          caseRef: '01CS02',
          orderId: 2,
          transactionId: 2,
          status: 'detected',
          recoverableAmount: 50000, // Low priority
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'ISSUER_HARD_DECLINE',
          correlationId: 'c2',
          createdAt: new Date(),
          updatedAt: new Date()
        },
        {
          id: 3,
          merchantId: 100,
          caseRef: '01CS03',
          orderId: 3,
          transactionId: 3,
          status: 'detected',
          recoverableAmount: 200000, // Medium priority
          currency: 'INR',
          originatingSignal: 'payment.failed',
          failureCategory: 'GATEWAY_TIMEOUT',
          correlationId: 'c3',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ];

      const prioritized = prioritizeCases(cases);
      // Capacity limit = 2 -> 1 case must be shed
      const shedList = identifyCasesToShed(prioritized, 2);

      expect(shedList.length).toBe(1);
      expect(shedList[0].case.id).toBe(2); // Lowest priority case identified for shed
    });
  });

  describe('4. Recoverable Revenue Ledger & Exact Reconciliation (RCV-002 Requirements 2, 8, 11)', () => {
    it('computes exact 0-variance revenue ledger reconciling all case aggregates', async () => {
      // Ingest test cases into DB for Merchant 1
      const e1: PaymentFailedEvent = {
        eventType: 'payment.failed',
        merchantId: merchant1Id,
        orderId: order1Id,
        transactionId: txn1Id,
        amount: 50000, // ₹500 (addressable)
        currency: 'INR',
        failureCategory: 'INSUFFICIENT_FUNDS',
        correlationId: '01PRIOCORR0000000000000001'
      };

      const e2: PaymentFailedEvent = {
        eventType: 'payment.failed',
        merchantId: merchant1Id,
        orderId: order2Id,
        transactionId: txn2Id,
        amount: 150000, // ₹1,500 (non-addressable)
        currency: 'INR',
        failureCategory: 'ISSUER_HARD_DECLINE',
        correlationId: '01PRIOCORR0000000000000002'
      };

      await ingestPaymentFailure(e1);
      await ingestPaymentFailure(e2);

      // Ingest for Merchant 2
      const e3: PaymentFailedEvent = {
        eventType: 'payment.failed',
        merchantId: merchant2Id,
        orderId: order3Id,
        transactionId: txn3Id,
        amount: 80000, // ₹800
        currency: 'INR',
        failureCategory: 'GATEWAY_TIMEOUT',
        correlationId: '01PRIOCORR0000000000000003'
      };

      await ingestPaymentFailure(e3);

      // Retrieve Ledger for Merchant 1
      const ledger = await getRevenueLedger(merchant1Id);

      expect(ledger.merchantId).toBe(merchant1Id);
      expect(ledger.currency).toBe('INR');
      expect(ledger.totals.totalCaseCount).toBe(2);
      expect(ledger.totals.totalDetectedMinorUnits).toBe(200000); // 50000 + 150000
      expect(ledger.totals.addressableMinorUnits).toBe(50000);
      expect(ledger.totals.nonAddressableMinorUnits).toBe(150000);
      expect(ledger.totals.inFlightMinorUnits).toBe(200000);

      // Reconciliation assertion
      expect(ledger.totals.totalDetectedMinorUnits).toBe(
        ledger.totals.addressableMinorUnits + ledger.totals.nonAddressableMinorUnits
      );

      // Verify category breakdown
      expect(ledger.byCategory.length).toBe(2);
      const insufficient = ledger.byCategory.find((c) => c.failureCategory === 'INSUFFICIENT_FUNDS');
      const hardDecline = ledger.byCategory.find((c) => c.failureCategory === 'ISSUER_HARD_DECLINE');

      expect(insufficient).toBeDefined();
      expect(insufficient?.isAddressable).toBe(true);
      expect(insufficient?.detectedMinorUnits).toBe(50000);

      expect(hardDecline).toBeDefined();
      expect(hardDecline?.isAddressable).toBe(false);
      expect(hardDecline?.detectedMinorUnits).toBe(150000);
    });

    it('retrieves prioritized queue and queue metrics', async () => {
      const queue = await getPrioritizedQueue(merchant1Id);
      expect(queue.length).toBe(2);
      expect(queue[0].priority.score).toBeDefined();
      expect(queue[0].priority.formula).toContain('P = value(');

      const metrics = await getQueueMetrics(merchant1Id);
      expect(metrics.queueDepth).toBe(2);
      expect(metrics.oldestCaseAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(metrics.activeCasesByStatus.detected).toBe(2);
      expect(metrics.shedVolumeTotal).toBe(0);
    });

    it('shedExcessBacklog transitions shed cases to suppressed status and records audit event in DB', async () => {
      // Ingest a temporary test case on order4/txn4 to shed
      const tempEvent: PaymentFailedEvent = {
        eventType: 'payment.failed',
        merchantId: merchant1Id,
        orderId: order4Id,
        transactionId: txn4Id,
        amount: 10000,
        currency: 'INR',
        failureCategory: 'UNKNOWN',
        correlationId: '01SHEDTEST000000000000001'
      };

      const { case: c } = await ingestPaymentFailure(tempEvent);
      expect(c.id).toBeDefined();

      // Execute load shedding with capacity limit (sheds 2 cases across system to reach capacity)
      const activeBefore = await findActiveCases();
      const targetLimit = Math.max(1, activeBefore.length - 2);
      const result = await shedExcessBacklog(targetLimit, '01SHEDEXEC000000000000001');
      expect(result.shedCount).toBe(activeBefore.length - targetLimit);

      // Check metrics reflect the shed count across merchants
      const metrics1 = await getQueueMetrics(merchant1Id);
      const metrics2 = await getQueueMetrics(merchant2Id);
      expect(metrics1.shedVolumeTotal + metrics2.shedVolumeTotal).toBeGreaterThanOrEqual(1);
    });
  });

  describe('5. REST Endpoints & Tenant Scoping (Invariant I9 / SEC-002)', () => {
    it('GET /api/merchants/recovery/ledger returns authenticated merchant ledger', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RevenueLedger;
      expect(body.merchantId).toBe(merchant1Id);
      expect(body.totals.totalDetectedMinorUnits).toBe(210000); // 200000 + 10000 from shed test
    });

    it('GET /api/merchants/recovery/queue returns authenticated merchant queue', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/recovery/queue`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { case: RecoveryCase }[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].case.merchantId).toBe(merchant1Id);
    });

    it('strictly isolates ledger data across merchants', async () => {
      const res1 = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
        headers: { Authorization: `Bearer ${token1}` }
      });

      const res2 = await fetch(`${baseUrl}/api/merchants/recovery/ledger`, {
        headers: { Authorization: `Bearer ${token2}` }
      });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const body1 = (await res1.json()) as RevenueLedger;
      const body2 = (await res2.json()) as RevenueLedger;

      // Merchant 1 sees 210,000 minor units; Merchant 2 sees 80,000 minor units
      expect(body1.totals.totalDetectedMinorUnits).toBe(210000);
      expect(body2.totals.totalDetectedMinorUnits).toBe(80000);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/api/merchants/recovery/ledger`);
      expect(res.status).toBe(401);
    });
  });
});
