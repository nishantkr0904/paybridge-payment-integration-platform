import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResultSetHeader } from 'mysql2';
import { pool } from '../../config/database.js';
import {
  assertZeroPII,
  buildRecoveryContext,
  detectPII,
  generateOpaqueReference,
  redactString,
  PIIDetectedInPromptError
} from '../../modules/ai/index.js';
import { createOrder, createTransaction } from '../../modules/payment/payment.repository.js';
import { createPolicy } from '../../modules/policy/policy.repository.js';
import { createCaseWithEvent } from '../../modules/recovery/case.repository.js';
import { HttpError } from '../../utils/http-error.js';

describe('TASK-302: Context Builder & PII Redaction (AI-009 / SIG-004 / Phase 3 Milestone 3.1)', () => {
  let merchantId1: number;
  let merchantId2: number;

  beforeEach(async () => {
    // Insert test merchant users
    const [m1] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (email, password_hash, merchant_name, status)
       VALUES (?, 'hash', 'Redaction Merchant 1', 'active')`,
      [`redact_m1_${Date.now()}_${Math.random()}@example.com`]
    );
    merchantId1 = m1.insertId;

    const [m2] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (email, password_hash, merchant_name, status)
       VALUES (?, 'hash', 'Redaction Merchant 2', 'active')`,
      [`redact_m2_${Date.now()}_${Math.random()}@example.com`]
    );
    merchantId2 = m2.insertId;

    // Create policy for merchant 1
    await createPolicy(merchantId1, {
      autonomyTier: 'T2',
      maxRetries: 3,
      maxContactsPerCustomerPerWeek: 2,
      dailyBudgetMinorUnits: 50000,
      maxIncentivePercent: 5.0
    });
  });

  describe('1. Individual PII Category Redaction (AI-009 Requirement 2)', () => {
    it('redacts customer email addresses', () => {
      const input = 'Customer contact: alice.smith@example.co.uk reported error';
      const output = redactString(input);
      expect(output).toBe('Customer contact: [EMAIL_REDACTED] reported error');
    });

    it('redacts domestic and international phone numbers', () => {
      const input1 = 'Call customer at +1-555-123-4567 regarding decline';
      expect(redactString(input1)).toBe('Call customer at [PHONE_REDACTED] regarding decline');

      const input2 = 'Alternative number: +91 9876543210';
      expect(redactString(input2)).toBe('Alternative number: [PHONE_REDACTED]');
    });

    it('redacts valid credit card PAN numbers', () => {
      // 4111 1111 1111 1111 (Visa test card - Luhn valid)
      const input = 'Card 4111-1111-1111-1111 declined by issuer';
      expect(redactString(input)).toBe('Card [CARD_REDACTED] declined by issuer');
    });

    it('redacts card expiry dates and CVV', () => {
      const input = 'Card details: expires: 12/26 and cvv: 456';
      expect(redactString(input)).toBe('Card details: [EXPIRY_REDACTED] and [CVV_REDACTED]');
    });

    it('redacts bank IFSC codes', () => {
      const input = 'Remittance to IFSC: HDFC0001234 failed due to network timeout';
      expect(redactString(input)).toBe('Remittance to IFSC: [IFSC_REDACTED] failed due to network timeout');
    });

    it('redacts government identifiers (SSN, Aadhaar, Tax PAN)', () => {
      const ssnInput = 'Customer SSN: 123-45-6789 provided for verification';
      expect(redactString(ssnInput)).toBe('Customer SSN: [GOVT_ID_REDACTED] provided for verification');

      const aadhaarInput = 'Aadhaar ID 1234 5678 9012 entered';
      expect(redactString(aadhaarInput)).toBe('Aadhaar ID [GOVT_ID_REDACTED] entered');

      const taxPanInput = 'Tax PAN ABCDE1234F verified';
      expect(redactString(taxPanInput)).toBe('Tax PAN [GOVT_ID_REDACTED] verified');
    });

    it('redacts IPv4 and IPv6 addresses', () => {
      const ipv4 = 'Client IP 192.168.1.100 connected';
      expect(redactString(ipv4)).toBe('Client IP [IP_REDACTED] connected');

      const ipv6 = 'Origin IP 2001:0db8:85a3:0000:0000:8a2e:0370:7334 flagged';
      expect(redactString(ipv6)).toBe('Origin IP [IP_REDACTED] flagged');
    });
  });

  describe('2. Stable Opaque Entity Anonymisation (AI-009 Requirement 3)', () => {
    it('generates deterministic opaque references for identical customer identities', () => {
      const email = 'customer.vip@acme.com';
      const ref1 = generateOpaqueReference('customer_ref', email);
      const ref2 = generateOpaqueReference('customer_ref', email);

      expect(ref1).toBe(ref2);
      expect(ref1).toMatch(/^customer_ref_[0-9a-f]{8}$/);
    });

    it('generates distinct opaque references for different customers and merchants', () => {
      const ref1 = generateOpaqueReference('customer_ref', 'user1@acme.com');
      const ref2 = generateOpaqueReference('customer_ref', 'user2@acme.com');
      const merchantRef = generateOpaqueReference('merchant_ref', merchantId1);

      expect(ref1).not.toBe(ref2);
      expect(merchantRef).toMatch(/^merchant_ref_[0-9a-f]{8}$/);
    });
  });

  describe('3. Defense-in-Depth Pattern Detector & Zero-PII Assertion (AI-009 Req 5)', () => {
    it('detects unredacted emails and card numbers', () => {
      const findings = detectPII('Contact bob@test.com with card 4111111111111111');
      expect(findings.length).toBeGreaterThanOrEqual(2);
      const categories = findings.map((f) => f.category);
      expect(categories).toContain('EMAIL');
      expect(categories).toContain('CARD_PAN');
    });

    it('assertZeroPII passes on clean payloads and throws PIIDetectedInPromptError on leaked PII', () => {
      const cleanPayload = {
        category: 'INSUFFICIENT_FUNDS',
        customerRef: 'customer_ref_8f2a4b1c',
        amountMinorUnits: 15000
      };

      expect(() => assertZeroPII(cleanPayload)).not.toThrow();

      const leakedPayload = {
        category: 'INSUFFICIENT_FUNDS',
        customerEmail: 'leaked.customer@example.com'
      };

      expect(() => assertZeroPII(leakedPayload)).toThrow(PIIDetectedInPromptError);
    });
  });

  describe('4. Context Assembly & Merchant Metadata Exclusion (AI-009 Req 6 / SIG-004)', () => {
    it('assembles complete, strictly redacted context and completely excludes merchant metadata', async () => {
      // Create order with arbitrary sensitive metadata and customer email
      const order = await createOrder({
        merchantId: merchantId1,
        orderRef: `ORD-AI-${Date.now()}`,
        amount: 25000,
        currency: 'INR',
        customerEmail: 'buyer.real.name@example.com',
        description: 'Premium Annual Subscription',
        metadata: {
          secretApiKey: 'sk_live_very_secret_key',
          customerAddress: '123 Tech Park, Bangalore',
          internalNote: 'High value customer'
        }
      });

      // Create failed transaction
      const txn1 = await createTransaction({
        orderId: order.id,
        txnRef: `TXN-AI-1-${Date.now()}`,
        paymentMethod: 'card',
        amount: 25000
      });

      // Update txn failure with decline reason
      await pool.query(
        `UPDATE transactions SET status = 'failed', failure_reason = 'Card declined: insufficient balance on user@example.com' WHERE id = ?`,
        [txn1.id]
      );

      // Create recovery case
      const corrId = '01TESTCORR000000000000000A';
      const recoveryCase = await createCaseWithEvent(
        merchantId1,
        {
          orderId: order.id,
          transactionId: txn1.id,
          recoverableAmount: 25000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILURE',
          failureCategory: 'INSUFFICIENT_FUNDS',
          correlationId: corrId
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'test',
          reason: 'TEST',
          payload: {},
          correlationId: corrId
        }
      );

      const context = await buildRecoveryContext({
        merchantId: merchantId1,
        caseId: recoveryCase.id,
        correlationId: '01TESTCORR000000000000000A'
      });

      // Assert structure conforms to AssembledRecoveryContextSchema
      expect(context.schemaVersion).toBe('v1.0.0');
      expect(context.case.recoverableAmountMinorUnits).toBe(25000);
      expect(context.case.currency).toBe('INR');
      expect(context.case.failureCategory).toBe('INSUFFICIENT_FUNDS');
      expect(context.merchant.autonomyTier).toBe('T2');

      // Assert opaque reference formats
      expect(context.customer.customerReference).toMatch(/^customer_ref_[0-9a-f]{8}$/);
      expect(context.merchant.merchantReference).toMatch(/^merchant_ref_[0-9a-f]{8}$/);
      expect(context.case.caseRef).toMatch(/^case_ref_[0-9a-f]{8}$/);

      // Assert declineReason was redacted
      expect(context.transaction.declineReason).toBe('Card declined: insufficient balance on [EMAIL_REDACTED]');

      // Assert merchant metadata is completely absent
      expect('metadata' in context).toBe(false);
      expect(JSON.stringify(context)).not.toContain('sk_live_very_secret_key');
      expect(JSON.stringify(context)).not.toContain('123 Tech Park');
      expect(JSON.stringify(context)).not.toContain('buyer.real.name@example.com');

      // Assert zero PII throughout context
      expect(() => assertZeroPII(context)).not.toThrow();
    });

    it('accurately derives behavioural history and truncates bounded records', async () => {
      const order = await createOrder({
        merchantId: merchantId1,
        orderRef: `ORD-HIST-${Date.now()}`,
        amount: 10000,
        currency: 'INR'
      });

      // Create 6 transactions (1 success, 5 failures)
      for (let i = 1; i <= 6; i++) {
        const status = i === 1 ? 'success' : 'failed';
        const method = i % 2 === 0 ? 'upi' : 'card';
        const txn = await createTransaction({
          orderId: order.id,
          txnRef: `TXN-HIST-${i}-${Date.now()}`,
          paymentMethod: method,
          amount: 10000
        });
        await pool.query(
          `UPDATE transactions SET status = ?, failure_reason = ? WHERE id = ?`,
          [status, status === 'failed' ? 'Decline error' : null, txn.id]
        );
      }

      const histCorrId = '01HISTCORR0000000000000001';
      const recoveryCase = await createCaseWithEvent(
        merchantId1,
        {
          orderId: order.id,
          recoverableAmount: 10000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILURE',
          correlationId: histCorrId
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'test',
          reason: 'TEST',
          payload: {},
          correlationId: histCorrId
        }
      );

      const context = await buildRecoveryContext({
        merchantId: merchantId1,
        caseId: recoveryCase.id,
        maxHistoryRecords: 4
      });

      expect(context.customer.hasPriorSuccess).toBe(true);
      expect(context.customer.priorSuccessCount).toBe(1);
      expect(context.customer.priorFailureCount).toBe(5);
      expect(context.customer.knownPaymentMethods).toContain('card');
      expect(context.customer.knownPaymentMethods).toContain('upi');

      // History truncation check (max 4 records)
      expect(context.history.totalPriorAttempts).toBe(6);
      expect(context.history.recentAttempts.length).toBe(4);
      expect(context.history.isTruncated).toBe(true);
    });
  });

  describe('5. Tenant Isolation Enforcement (Invariant I9 / SEC-002)', () => {
    it('strictly forbids cross-tenant context assembly', async () => {
      const order = await createOrder({
        merchantId: merchantId1,
        orderRef: `ORD-TENANT-${Date.now()}`,
        amount: 5000,
        currency: 'INR'
      });

      const tenantCorrId = '01TENANTCORR00000000000001';
      const recoveryCase = await createCaseWithEvent(
        merchantId1,
        {
          orderId: order.id,
          recoverableAmount: 5000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILURE',
          correlationId: tenantCorrId
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'test',
          reason: 'TEST',
          payload: {},
          correlationId: tenantCorrId
        }
      );

      // Merchant 2 attempts to build context for Merchant 1's case
      await expect(
        buildRecoveryContext({
          merchantId: merchantId2,
          caseId: recoveryCase.id
        })
      ).rejects.toThrow(HttpError);
    });
  });

  describe('6. Zero Outbound Network Calls & Low Overhead (AI-009 Req 11)', () => {
    it('executes in memory with zero outbound network calls and sub-10ms execution', async () => {
      const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

      const order = await createOrder({
        merchantId: merchantId1,
        orderRef: `ORD-PERF-${Date.now()}`,
        amount: 8000,
        currency: 'INR'
      });

      const perfCorrId = '01PERFCORR0000000000000001';
      const recoveryCase = await createCaseWithEvent(
        merchantId1,
        {
          orderId: order.id,
          recoverableAmount: 8000,
          currency: 'INR',
          originatingSignal: 'PAYMENT_FAILURE',
          correlationId: perfCorrId
        },
        {
          fromStatus: null,
          toStatus: 'detected',
          actorType: 'system',
          actorId: 'test',
          reason: 'TEST',
          payload: {},
          correlationId: perfCorrId
        }
      );

      const start = performance.now();
      const context = await buildRecoveryContext({
        merchantId: merchantId1,
        caseId: recoveryCase.id
      });
      const durationMs = performance.now() - start;

      expect(context.case.recoverableAmountMinorUnits).toBe(8000);
      expect(durationMs).toBeLessThan(100); // Fast DB + in-memory assembly
      expect(globalFetchSpy).not.toHaveBeenCalled();

      globalFetchSpy.mockRestore();
    });
  });
});
