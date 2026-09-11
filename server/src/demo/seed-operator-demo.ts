#!/usr/bin/env node
import '../config/env.js'; // loads environment variables
import bcrypt from 'bcryptjs';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool, closePool } from '../config/database.js';

/* ------------------------------------------------------------------ */
/*  Deterministic Demo Operator Seeding (Task 1)                      */
/* ------------------------------------------------------------------ */

export interface SeedOperatorDemoResult {
  merchantId: number;
  email: string;
  merchantName: string;
  role: string;
  policyId: number;
  cases: {
    awaitingApprovalCaseRef: string;
    awaitingApprovalCaseId: number;
    recoveredCaseRef: string;
    recoveredCaseId: number;
    suppressedCaseRef: string;
    suppressedCaseId: number;
  };
}

export async function seedOperatorDemo(): Promise<SeedOperatorDemoResult> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Deterministic Demo Operator User
    const demoEmail = 'operator@paybridge.test';
    const demoPassword = 'Operator123!';
    const demoMerchantName = "Priya's Merchant Store";
    const demoRole = 'merchant_operator';

    const [existingUsers] = await conn.query<RowDataPacket[]>(
      `SELECT id, email FROM users WHERE email = ?`,
      [demoEmail]
    );

    let merchantId: number;
    const passwordHash = await bcrypt.hash(demoPassword, 12);

    if (existingUsers.length > 0 && existingUsers[0]?.id) {
      merchantId = Number(existingUsers[0].id);
      await conn.query(
        `UPDATE users SET password_hash = ?, merchant_name = ?, status = 'active' WHERE id = ?`,
        [passwordHash, demoMerchantName, merchantId]
      );
    } else {
      const [insertUser] = await conn.query<ResultSetHeader>(
        `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, ?, ?, 'active')`,
        [demoEmail, passwordHash, demoMerchantName]
      );
      merchantId = insertUser.insertId;
    }

    // Assign 'merchant_operator' role idempotently
    await conn.query(
      `INSERT IGNORE INTO user_roles (user_id, role_id)
       SELECT ?, id FROM roles WHERE name = ?`,
      [merchantId, demoRole]
    );

    // 2. Active Governance Policy (Tier T2 Assistive)
    const [existingPolicies] = await conn.query<RowDataPacket[]>(
      `SELECT id, autonomy_tier, is_active FROM policies WHERE merchant_id = ? AND is_active = TRUE LIMIT 1`,
      [merchantId]
    );

    let policyId: number;
    if (existingPolicies.length === 0) {
      const [vRows] = await conn.query<(RowDataPacket & { next_version: number })[]>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM policies WHERE merchant_id = ?`,
        [merchantId]
      );
      const nextVersion = vRows[0]?.next_version || 1;

      const [insertPolicy] = await conn.query<ResultSetHeader>(
        `INSERT INTO policies (
          merchant_id, autonomy_tier, max_retries, max_contacts_per_customer_per_week,
          daily_budget_minor_units, max_incentive_percent, is_active, version, timezone
        ) VALUES (?, 'T2', 3, 3, 500000, 5.00, TRUE, ?, 'UTC')`,
        [merchantId, nextVersion]
      );
      policyId = insertPolicy.insertId;
    } else {
      policyId = Number(existingPolicies[0]!.id);
      if (existingPolicies[0]!.autonomy_tier !== 'T2') {
        await conn.query(
          `UPDATE policies SET autonomy_tier = 'T2', max_incentive_percent = 5.00 WHERE id = ?`,
          [policyId]
        );
      }
    }

    // 3. Helper for Orders (Idempotent by order_ref)
    async function ensureOrder(
      orderRef: string,
      amountDecimal: string,
      status: 'pending' | 'processing' | 'success' | 'failed',
      customerEmail: string,
      description: string
    ): Promise<number> {
      const [existing] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM orders WHERE order_ref = ?`,
        [orderRef]
      );
      if (existing.length > 0 && existing[0]?.id) {
        return Number(existing[0].id);
      }
      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO orders (merchant_id, order_ref, amount, currency, status, customer_email, description)
         VALUES (?, ?, ?, 'INR', ?, ?, ?)`,
        [merchantId, orderRef, amountDecimal, status, customerEmail, description]
      );
      return result.insertId;
    }

    // 4. Helper for Cases (Idempotent by case_ref)
    async function ensureCase(
      caseRef: string,
      orderId: number,
      status: 'awaiting_approval' | 'recovered' | 'suppressed',
      recoverableAmountMinorUnits: number,
      originatingSignal: string,
      failureCategory: string,
      correlationId: string
    ): Promise<number> {
      const [existing] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM cases WHERE case_ref = ?`,
        [caseRef]
      );
      if (existing.length > 0 && existing[0]?.id) {
        const caseId = Number(existing[0].id);
        // Reset status to baseline if it was previously actioned during manual testing
        await conn.query(
          `UPDATE cases SET status = ?, recoverable_amount = ?, failure_category = ? WHERE id = ?`,
          [status, recoverableAmountMinorUnits, failureCategory, caseId]
        );
        return caseId;
      }
      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO cases (
          merchant_id, case_ref, order_id, status, recoverable_amount, currency,
          originating_signal, failure_category, correlation_id
        ) VALUES (?, ?, ?, ?, ?, 'INR', ?, ?, ?)`,
        [
          merchantId,
          caseRef,
          orderId,
          status,
          recoverableAmountMinorUnits,
          originatingSignal,
          failureCategory,
          correlationId
        ]
      );
      return result.insertId;
    }

    // 5. Create Deterministic Scenarios
    // --- Scenario 1: Awaiting Approval (CASE_DEMO_OP_AWAITING_001) ---
    const order1Id = await ensureOrder(
      'ORD_DEMO_OP_001',
      '450.00',
      'failed',
      'customer1@example.com',
      'Order #ORD_DEMO_OP_001 - Premium Headphones'
    );

    const case1Id = await ensureCase(
      'CASE_DEMO_OP_AWAITING_001',
      order1Id,
      'awaiting_approval',
      45000,
      'PAYMENT_FAILED',
      'INSUFFICIENT_FUNDS',
      '01DEMOCORR_AWAITING_001'
    );

    // --- Scenario 2: Recovered (CASE_DEMO_OP_RECOVERED_002) ---
    const order2Id = await ensureOrder(
      'ORD_DEMO_OP_002',
      '120.00',
      'success',
      'customer2@example.com',
      'Order #ORD_DEMO_OP_002 - Wireless Mouse'
    );

    const case2Id = await ensureCase(
      'CASE_DEMO_OP_RECOVERED_002',
      order2Id,
      'recovered',
      12000,
      'PAYMENT_FAILED',
      'NETWORK_TIMEOUT',
      '01DEMOCORR_RECOVERED_002'
    );

    // --- Scenario 3: Suppressed (CASE_DEMO_OP_SUPPRESSED_003) ---
    const order3Id = await ensureOrder(
      'ORD_DEMO_OP_003',
      '890.00',
      'failed',
      'customer3@example.com',
      'Order #ORD_DEMO_OP_003 - Mechanical Keyboard'
    );

    const case3Id = await ensureCase(
      'CASE_DEMO_OP_SUPPRESS_003',
      order3Id,
      'suppressed',
      89000,
      'PAYMENT_FAILED',
      'FRAUD_BLOCKED',
      '01DEMOCORR_SUPPRESSED_003'
    );

    // 6. Data Payloads for Case 1 (Diagnosis, Decision, Policy Evaluation)
    const diagnosisPayload = {
      category: 'INSUFFICIENT_FUNDS',
      reasonCode: 'LACK_OF_FUNDS',
      rootCause: 'Customer account balance was insufficient at transaction attempt time.',
      contributingFactors: [
        'Debit card issuer returned decline code 51 (insufficient funds)',
        'Transaction occurred outside typical salary disbursement window'
      ],
      recoverable: true,
      recommendedStrategy: 'CUSTOMER_OUTREACH',
      confidence: 0.92,
      explanation: 'Customer balance replenishment typically occurs within 24-48 hours. Sending a personalized payment link with a 5% discount incentive has high historical conversion.',
      evidence: ['issuer_decline_code_51', 'active_customer_profile'],
      provenance: {
        source: 'model',
        promptId: 'prompt_diagnosis_v1',
        promptVersion: '1.0.0',
        modelId: 'gpt-4o-mini',
        tokens: { inputTokens: 350, outputTokens: 180, totalTokens: 530 },
        latencyMs: 628,
        contextVersion: '1.0',
        rulesVersion: null,
        repairAttempted: false,
        fallbackReason: null
      }
    };

    const decisionPayload = {
      planRationale: 'Offer personalized recovery payment link with 5% incentive discount scheduled 15 minutes post-decline.',
      actions: [
        {
          actionType: 'OFFER_INCENTIVE',
          toolName: 'send_recovery_link',
          scheduledDelaySeconds: 900,
          costMinorUnits: 250,
          incentivePercent: 5.0,
          rationale: 'Send recovery checkout link offering 5% discount if completed within 2 hours.',
          parameters: {
            channel: 'whatsapp_and_email',
            discountPercent: 5,
            expiresInMinutes: 120
          }
        }
      ],
      primaryAction: {
        actionType: 'OFFER_INCENTIVE',
        toolName: 'send_recovery_link',
        scheduledDelaySeconds: 900,
        costMinorUnits: 250,
        incentivePercent: 5.0,
        rationale: 'Send recovery checkout link offering 5% discount if completed within 2 hours.',
        parameters: {
          channel: 'whatsapp_and_email',
          discountPercent: 5,
          expiresInMinutes: 120
        }
      },
      costOrderingRespect: true,
      provenance: {
        source: 'model',
        promptId: 'prompt_decision_v1',
        promptVersion: '1.0.0',
        modelId: 'gpt-4o-mini',
        tokens: { inputTokens: 420, outputTokens: 210, totalTokens: 630 },
        latencyMs: 750,
        contextVersion: '1.0',
        diagnosisCategory: 'INSUFFICIENT_FUNDS',
        rulesVersion: null,
        repairAttempted: false,
        fallbackReason: null
      }
    };

    const policyEvalPayload = {
      decision: 'REQUIRES_HUMAN',
      ruleId: 'RULE_TIER_T2_INCENTIVE_APPROVAL',
      reason: 'Autonomy Tier T2 Assistive requires human operator sign-off for financial incentives above 0%.',
      matchedConditions: {
        autonomyTier: 'T2',
        incentivePercent: 5.0,
        requiresApproval: true
      }
    };

    // 7. Case Events (Idempotent: seed only if case has 0 events)
    async function seedEventsIfEmpty(
      caseId: number,
      events: Array<{
        fromStatus: string | null;
        toStatus: string;
        actorType: 'system' | 'agent' | 'operator' | 'merchant';
        actorId: string;
        reason: string;
        payload?: Record<string, unknown>;
        correlationId: string;
      }>
    ): Promise<void> {
      const [existing] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM case_events WHERE case_id = ?`,
        [caseId]
      );
      if (Number(existing[0]?.cnt || 0) > 0) return;

      for (const e of events) {
        await conn.query(
          `INSERT INTO case_events (
            case_id, merchant_id, from_status, to_status,
            actor_type, actor_id, reason, payload, correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            caseId,
            merchantId,
            e.fromStatus,
            e.toStatus,
            e.actorType,
            e.actorId,
            e.reason,
            e.payload ? JSON.stringify(e.payload) : null,
            e.correlationId
          ]
        );
      }
    }

    // Events for Case 1 (Awaiting Approval)
    await seedEventsIfEmpty(case1Id, [
      {
        fromStatus: null,
        toStatus: 'detected',
        actorType: 'system',
        actorId: 'payment_gateway',
        reason: 'Payment transaction failed with INSUFFICIENT_FUNDS',
        correlationId: '01DEMOCORR_AWAITING_001'
      },
      {
        fromStatus: 'detected',
        toStatus: 'diagnosing',
        actorType: 'agent',
        actorId: 'diagnosis_agent',
        reason: 'Autonomous diagnostic evaluation initiated',
        payload: { diagnosis: diagnosisPayload },
        correlationId: '01DEMOCORR_AWAITING_001'
      },
      {
        fromStatus: 'diagnosing',
        toStatus: 'deciding',
        actorType: 'agent',
        actorId: 'decision_agent',
        reason: 'Diagnostic evaluation complete; formulating action plan',
        payload: { decision: decisionPayload },
        correlationId: '01DEMOCORR_AWAITING_001'
      },
      {
        fromStatus: 'deciding',
        toStatus: 'awaiting_approval',
        actorType: 'agent',
        actorId: 'decision_agent',
        reason: 'Action submitted for human operator review: Tier T2 requires authorization for recovery incentives.',
        payload: {
          policyEvaluation: policyEvalPayload,
          primaryAction: decisionPayload.primaryAction
        },
        correlationId: '01DEMOCORR_AWAITING_001'
      }
    ]);

    // Events for Case 2 (Recovered)
    await seedEventsIfEmpty(case2Id, [
      {
        fromStatus: null,
        toStatus: 'detected',
        actorType: 'system',
        actorId: 'payment_gateway',
        reason: 'Payment transaction timed out at acquiring network',
        correlationId: '01DEMOCORR_RECOVERED_002'
      },
      {
        fromStatus: 'detected',
        toStatus: 'executing',
        actorType: 'system',
        actorId: 'recovery_scheduler',
        reason: 'Autonomous immediate retry dispatched under policy T2',
        correlationId: '01DEMOCORR_RECOVERED_002'
      },
      {
        fromStatus: 'executing',
        toStatus: 'recovered',
        actorType: 'system',
        actorId: 'payment_gateway',
        reason: 'Payment successfully captured on retry attempt 1',
        correlationId: '01DEMOCORR_RECOVERED_002'
      }
    ]);

    // Events for Case 3 (Suppressed)
    await seedEventsIfEmpty(case3Id, [
      {
        fromStatus: null,
        toStatus: 'detected',
        actorType: 'system',
        actorId: 'risk_engine',
        reason: 'Transaction flagged by automated velocity limit check',
        correlationId: '01DEMOCORR_SUPPRESSED_003'
      },
      {
        fromStatus: 'detected',
        toStatus: 'suppressed',
        actorType: 'system',
        actorId: 'policy_engine',
        reason: 'Case suppressed: non-addressable failure category FRAUD_BLOCKED',
        correlationId: '01DEMOCORR_SUPPRESSED_003'
      }
    ]);

    // 8. Agent Traces for Case 1 (Idempotent: seed only if case has 0 traces)
    const [existingTraces] = await conn.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM agent_traces WHERE case_id = ?`,
      [case1Id]
    );

    if (Number(existingTraces[0]?.cnt || 0) === 0) {
      // Trace 1: Diagnosis
      const [diagTraceHeader] = await conn.query<ResultSetHeader>(
        `INSERT INTO agent_traces (
          merchant_id, case_id, trace_ref, agent_type, status,
          termination_reason, total_duration_ms, total_input_tokens,
          total_output_tokens, correlation_id
        ) VALUES (?, ?, 'TRACE_DEMO_DIAG_001', 'diagnosis', 'success', NULL, 640, 350, 180, '01DEMOCORR_AWAITING_001')`,
        [merchantId, case1Id]
      );
      const diagTraceId = diagTraceHeader.insertId;

      await conn.query(
        `INSERT INTO agent_trace_steps (
          trace_id, step_number, step_type, prompt_id, prompt_version,
          model_id, system_prompt, user_prompt, raw_response, parsed_output,
          validation_status, validation_errors, tool_invoked, tool_arguments,
          tool_result, duration_ms, input_tokens, output_tokens
        ) VALUES
        (?, 1, 'prompt_render', 'prompt_diag_v1', '1.0.0', NULL, NULL, NULL, NULL, NULL, 'passed', NULL, NULL, NULL, NULL, 12, 0, 0),
        (?, 2, 'model_completion', 'prompt_diag_v1', '1.0.0', 'gpt-4o-mini', 'You are PayBridge diagnosis agent.', 'Diagnose payment decline code 51 for order ORD_DEMO_OP_001.', ?, ?, 'passed', NULL, NULL, NULL, NULL, 628, 350, 180)`,
        [
          diagTraceId,
          diagTraceId,
          JSON.stringify(diagnosisPayload),
          JSON.stringify(diagnosisPayload)
        ]
      );

      // Trace 2: Decision
      const [decTraceHeader] = await conn.query<ResultSetHeader>(
        `INSERT INTO agent_traces (
          merchant_id, case_id, trace_ref, agent_type, status,
          termination_reason, total_duration_ms, total_input_tokens,
          total_output_tokens, correlation_id
        ) VALUES (?, ?, 'TRACE_DEMO_DEC_001', 'decision', 'success', NULL, 780, 420, 210, '01DEMOCORR_AWAITING_001')`,
        [merchantId, case1Id]
      );
      const decTraceId = decTraceHeader.insertId;

      await conn.query(
        `INSERT INTO agent_trace_steps (
          trace_id, step_number, step_type, prompt_id, prompt_version,
          model_id, system_prompt, user_prompt, raw_response, parsed_output,
          validation_status, validation_errors, tool_invoked, tool_arguments,
          tool_result, duration_ms, input_tokens, output_tokens
        ) VALUES
        (?, 1, 'prompt_render', 'prompt_dec_v1', '1.0.0', NULL, NULL, NULL, NULL, NULL, 'passed', NULL, NULL, NULL, NULL, 15, 0, 0),
        (?, 2, 'model_completion', 'prompt_dec_v1', '1.0.0', 'gpt-4o-mini', 'You are PayBridge decision agent.', 'Formulate recovery plan for INSUFFICIENT_FUNDS under Tier T2.', ?, ?, 'passed', NULL, NULL, NULL, NULL, 750, 420, 210),
        (?, 3, 'policy_evaluation', NULL, NULL, NULL, NULL, NULL, NULL, ?, 'passed', NULL, 'evaluate_policy', NULL, ?, 15, 0, 0)`,
        [
          decTraceId,
          decTraceId,
          JSON.stringify(decisionPayload),
          JSON.stringify(decisionPayload),
          decTraceId,
          JSON.stringify(policyEvalPayload),
          JSON.stringify(policyEvalPayload)
        ]
      );
    }

    await conn.commit();

    return {
      merchantId,
      email: demoEmail,
      merchantName: demoMerchantName,
      role: demoRole,
      policyId,
      cases: {
        awaitingApprovalCaseRef: 'CASE_DEMO_OP_AWAITING_001',
        awaitingApprovalCaseId: case1Id,
        recoveredCaseRef: 'CASE_DEMO_OP_RECOVERED_002',
        recoveredCaseId: case2Id,
        suppressedCaseRef: 'CASE_DEMO_OP_SUPPRESS_003',
        suppressedCaseId: case3Id
      }
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/* ------------------------------------------------------------------ */
/*  CLI Entrypoint Execution                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('\n============================================================');
  console.log('🌱 PayBridge Merchant Operator Demo Seeding');
  console.log('============================================================\n');

  try {
    const result = await seedOperatorDemo();
    console.log('✅ Merchant Operator Demo Seeded Successfully:');
    console.log(`   • Merchant ID   : ${result.merchantId}`);
    console.log(`   • Email         : ${result.email}`);
    console.log(`   • Password      : Operator123!`);
    console.log(`   • Merchant Name : ${result.merchantName}`);
    console.log(`   • Assigned Role : ${result.role}`);
    console.log(`   • Active Policy : Policy ID #${result.policyId} (Autonomy Tier T2)`);
    console.log('\n📋 Seeded Cases:');
    console.log(`   1. [awaiting_approval] ${result.cases.awaitingApprovalCaseRef} (ID: ${result.cases.awaitingApprovalCaseId}, ₹450.00, INSUFFICIENT_FUNDS)`);
    console.log(`   2. [recovered]         ${result.cases.recoveredCaseRef} (ID: ${result.cases.recoveredCaseId}, ₹120.00, NETWORK_TIMEOUT)`);
    console.log(`   3. [suppressed]        ${result.cases.suppressedCaseRef} (ID: ${result.cases.suppressedCaseId}, ₹890.00, FRAUD_BLOCKED)`);
    console.log('\n============================================================\n');
  } catch (error) {
    console.error('\n❌ Seed Failed with Error:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

// Execute directly if run via CLI
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('seed-operator-demo.ts') ||
    process.argv[1].endsWith('seed-operator-demo.js'));

if (isDirectRun) {
  void main();
}
