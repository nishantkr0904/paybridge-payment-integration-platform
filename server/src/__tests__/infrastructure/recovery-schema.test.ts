import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/database.js';
import {
  runMigrations,
  rollbackMigrations,
  getMigrationStatus,
  getDefaultMigrationsDir
} from '../../infrastructure/migrator.js';

describe('TASK-102: Event Store & Case Management Schemas (005_recovery_schema)', () => {
  const migrationsDir = getDefaultMigrationsDir();

  beforeAll(async () => {
    // Ensure database is migrated up to 005
    await runMigrations({ migrationsDir });
  });

  afterAll(async () => {
    // Ensure migrations are in applied state for subsequent tests
    await runMigrations({ migrationsDir });
  });

  describe('Table Existence & Schema Verification', () => {
    it('creates all 4 required recovery domain tables in MySQL', async () => {
      const conn = await pool.getConnection();
      try {
        const [tables] = await conn.query<RowDataPacket[]>(`
          SELECT TABLE_NAME 
          FROM information_schema.tables 
          WHERE table_schema = DATABASE() 
            AND table_name IN ('cases', 'case_events', 'policies', 'audit_logs')
        `);

        const tableNames = tables.map((t) => t.TABLE_NAME?.toLowerCase());
        expect(tableNames).toContain('cases');
        expect(tableNames).toContain('case_events');
        expect(tableNames).toContain('policies');
        expect(tableNames).toContain('audit_logs');
      } finally {
        conn.release();
      }
    });

    it('verifies columns and data types of cases table', async () => {
      const conn = await pool.getConnection();
      try {
        const [columns] = await conn.query<RowDataPacket[]>(`
          SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
          FROM information_schema.columns 
          WHERE table_schema = DATABASE() AND table_name = 'cases'
        `);

        const colMap = new Map(columns.map((c) => [c.COLUMN_NAME, c]));
        
        expect(colMap.has('id')).toBe(true);
        expect(colMap.get('id')?.DATA_TYPE).toBe('bigint');
        
        expect(colMap.has('merchant_id')).toBe(true);
        expect(colMap.get('merchant_id')?.DATA_TYPE).toBe('bigint');
        expect(colMap.get('merchant_id')?.IS_NULLABLE).toBe('NO');

        expect(colMap.has('case_ref')).toBe(true);
        expect(colMap.get('case_ref')?.DATA_TYPE).toBe('char');

        expect(colMap.has('order_id')).toBe(true);
        expect(colMap.get('order_id')?.DATA_TYPE).toBe('bigint');

        expect(colMap.has('transaction_id')).toBe(true);
        expect(colMap.get('transaction_id')?.DATA_TYPE).toBe('bigint');
        expect(colMap.get('transaction_id')?.IS_NULLABLE).toBe('YES');

        expect(colMap.has('status')).toBe(true);
        expect(colMap.get('status')?.DATA_TYPE).toBe('enum');
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'detected'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'diagnosing'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'scoring'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'deciding'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'awaiting_approval'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'executing'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'awaiting_outcome'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'recovered'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'unrecovered'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'suppressed'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'expired'");
        expect(colMap.get('status')?.COLUMN_TYPE).toContain("'failed'");

        expect(colMap.has('recoverable_amount')).toBe(true);
        expect(colMap.get('recoverable_amount')?.DATA_TYPE).toBe('bigint');

        expect(colMap.has('currency')).toBe(true);
        expect(colMap.has('originating_signal')).toBe(true);
        expect(colMap.has('failure_category')).toBe(true);
        expect(colMap.has('correlation_id')).toBe(true);
        expect(colMap.has('created_at')).toBe(true);
        expect(colMap.has('updated_at')).toBe(true);
      } finally {
        conn.release();
      }
    });

    it('verifies columns and data types of case_events table', async () => {
      const conn = await pool.getConnection();
      try {
        const [columns] = await conn.query<RowDataPacket[]>(`
          SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
          FROM information_schema.columns 
          WHERE table_schema = DATABASE() AND table_name = 'case_events'
        `);

        const colMap = new Map(columns.map((c) => [c.COLUMN_NAME, c]));
        
        expect(colMap.has('id')).toBe(true);
        expect(colMap.has('case_id')).toBe(true);
        expect(colMap.has('merchant_id')).toBe(true);
        expect(colMap.has('from_status')).toBe(true);
        expect(colMap.has('to_status')).toBe(true);
        expect(colMap.has('actor_type')).toBe(true);
        expect(colMap.get('actor_type')?.COLUMN_TYPE).toContain("'system'");
        expect(colMap.get('actor_type')?.COLUMN_TYPE).toContain("'agent'");
        expect(colMap.get('actor_type')?.COLUMN_TYPE).toContain("'operator'");
        expect(colMap.get('actor_type')?.COLUMN_TYPE).toContain("'merchant'");
        expect(colMap.has('actor_id')).toBe(true);
        expect(colMap.has('reason')).toBe(true);
        expect(colMap.has('payload')).toBe(true);
        expect(colMap.has('correlation_id')).toBe(true);
        expect(colMap.has('created_at')).toBe(true);
      } finally {
        conn.release();
      }
    });

    it('verifies columns and data types of policies table', async () => {
      const conn = await pool.getConnection();
      try {
        const [columns] = await conn.query<RowDataPacket[]>(`
          SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
          FROM information_schema.columns 
          WHERE table_schema = DATABASE() AND table_name = 'policies'
        `);

        const colMap = new Map(columns.map((c) => [c.COLUMN_NAME, c]));
        
        expect(colMap.has('id')).toBe(true);
        expect(colMap.has('merchant_id')).toBe(true);
        expect(colMap.has('autonomy_tier')).toBe(true);
        expect(colMap.get('autonomy_tier')?.COLUMN_TYPE).toContain("'T0'");
        expect(colMap.get('autonomy_tier')?.COLUMN_TYPE).toContain("'T1'");
        expect(colMap.get('autonomy_tier')?.COLUMN_TYPE).toContain("'T2'");
        expect(colMap.get('autonomy_tier')?.COLUMN_TYPE).toContain("'T3'");
        expect(colMap.get('autonomy_tier')?.COLUMN_TYPE).toContain("'T4'");
        expect(colMap.has('max_retries')).toBe(true);
        expect(colMap.has('max_contacts_per_customer_per_week')).toBe(true);
        expect(colMap.has('daily_budget_minor_units')).toBe(true);
        expect(colMap.has('max_incentive_percent')).toBe(true);
        expect(colMap.has('quiet_hours_start')).toBe(true);
        expect(colMap.has('quiet_hours_end')).toBe(true);
        expect(colMap.has('timezone')).toBe(true);
        expect(colMap.has('is_active')).toBe(true);
        expect(colMap.has('version')).toBe(true);
      } finally {
        conn.release();
      }
    });

    it('verifies columns and data types of audit_logs table', async () => {
      const conn = await pool.getConnection();
      try {
        const [columns] = await conn.query<RowDataPacket[]>(`
          SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
          FROM information_schema.columns 
          WHERE table_schema = DATABASE() AND table_name = 'audit_logs'
        `);

        const colMap = new Map(columns.map((c) => [c.COLUMN_NAME, c]));
        
        expect(colMap.has('id')).toBe(true);
        expect(colMap.has('merchant_id')).toBe(true);
        expect(colMap.get('merchant_id')?.IS_NULLABLE).toBe('YES');
        expect(colMap.has('actor_type')).toBe(true);
        expect(colMap.has('actor_id')).toBe(true);
        expect(colMap.has('event_type')).toBe(true);
        expect(colMap.has('resource_type')).toBe(true);
        expect(colMap.has('resource_id')).toBe(true);
        expect(colMap.has('payload_before')).toBe(true);
        expect(colMap.has('payload_after')).toBe(true);
        expect(colMap.has('ip_address')).toBe(true);
        expect(colMap.has('correlation_id')).toBe(true);
        expect(colMap.has('created_at')).toBe(true);
      } finally {
        conn.release();
      }
    });
  });

  describe('Foreign Key Constraints & Indexes', () => {
    it('verifies foreign key constraints exist on all 4 tables', async () => {
      const conn = await pool.getConnection();
      try {
        const [fks] = await conn.query<RowDataPacket[]>(`
          SELECT TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME 
          FROM information_schema.KEY_COLUMN_USAGE 
          WHERE TABLE_SCHEMA = DATABASE() 
            AND REFERENCED_TABLE_NAME IS NOT NULL
            AND TABLE_NAME IN ('cases', 'case_events', 'policies', 'audit_logs')
        `);

        const fkMap = new Map<string, string[]>();
        for (const fk of fks) {
          const list = fkMap.get(fk.TABLE_NAME) || [];
          list.push(`${fk.CONSTRAINT_NAME}->${fk.REFERENCED_TABLE_NAME}`);
          fkMap.set(fk.TABLE_NAME, list);
        }

        // cases constraints: merchant -> users, order -> orders, transaction -> transactions
        const caseFks = fkMap.get('cases') || [];
        expect(caseFks.some((f) => f.includes('users'))).toBe(true);
        expect(caseFks.some((f) => f.includes('orders'))).toBe(true);
        expect(caseFks.some((f) => f.includes('transactions'))).toBe(true);

        // case_events constraints: case -> cases, merchant -> users
        const eventFks = fkMap.get('case_events') || [];
        expect(eventFks.some((f) => f.includes('cases'))).toBe(true);
        expect(eventFks.some((f) => f.includes('users'))).toBe(true);

        // policies constraints: merchant -> users
        const policyFks = fkMap.get('policies') || [];
        expect(policyFks.some((f) => f.includes('users'))).toBe(true);

        // audit_logs constraints: merchant -> users
        const auditFks = fkMap.get('audit_logs') || [];
        expect(auditFks.some((f) => f.includes('users'))).toBe(true);
      } finally {
        conn.release();
      }
    });

    it('verifies unique and performance indexes on recovery tables', async () => {
      const conn = await pool.getConnection();
      try {
        const [indexes] = await conn.query<RowDataPacket[]>(`
          SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME
          FROM information_schema.STATISTICS 
          WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME IN ('cases', 'case_events', 'policies', 'audit_logs')
        `);

        const caseIndices = indexes.filter((i) => i.TABLE_NAME === 'cases').map((i) => i.INDEX_NAME);
        expect(caseIndices).toContain('PRIMARY');
        expect(caseIndices).toContain('uq_cases_ref');
        expect(caseIndices).toContain('idx_cases_merchant_status');

        const policyIndices = indexes.filter((i) => i.TABLE_NAME === 'policies').map((i) => i.INDEX_NAME);
        expect(policyIndices).toContain('PRIMARY');
        expect(policyIndices).toContain('uq_policies_merchant_version');
        expect(policyIndices).toContain('idx_policies_merchant_active');

        const eventIndices = indexes.filter((i) => i.TABLE_NAME === 'case_events').map((i) => i.INDEX_NAME);
        expect(eventIndices).toContain('PRIMARY');
        expect(eventIndices).toContain('idx_case_events_case_id');
        expect(eventIndices).toContain('idx_case_events_merchant_id');

        const auditIndices = indexes.filter((i) => i.TABLE_NAME === 'audit_logs').map((i) => i.INDEX_NAME);
        expect(auditIndices).toContain('PRIMARY');
        expect(auditIndices).toContain('idx_audit_logs_resource');
      } finally {
        conn.release();
      }
    });
  });

  describe('Data Lifecycle & Relational Integrity (Integration)', () => {
    it('successfully inserts and links cases, case_events, policies, and audit_logs', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // 1. Create a test merchant
        const testEmail = `test_rcv_${Date.now()}@example.com`;
        const [userRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Test Merchant', 'active')`,
          [testEmail]
        );
        const merchantId = (userRes as unknown as { insertId: number }).insertId;

        // 2. Create a test order and transaction
        const [orderRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01JRCVORDER00000000000001', 50.00, 'INR', 'failed')`,
          [merchantId]
        );
        const orderId = (orderRes as unknown as { insertId: number }).insertId;

        const [txnRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO transactions (order_id, txn_ref, payment_method, status, amount) VALUES (?, '01JRCVTXN00000000000000001', 'card', 'failed', 50.00)`,
          [orderId]
        );
        const txnId = (txnRes as unknown as { insertId: number }).insertId;

        // 3. Insert recovery case
        const caseRef = '01JRCVCASE0000000000000001';
        const correlationId = '01JRCVCORR0000000000000001';
        const [caseRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO cases (
            merchant_id, case_ref, order_id, transaction_id, status, recoverable_amount, currency, originating_signal, failure_category, correlation_id
          ) VALUES (?, ?, ?, ?, 'detected', 5000, 'INR', 'payment_failed', 'insufficient_funds', ?)`,
          [merchantId, caseRef, orderId, txnId, correlationId]
        );
        const caseId = (caseRes as unknown as { insertId: number }).insertId;
        expect(caseId).toBeGreaterThan(0);

        // 4. Insert case event
        const [eventRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO case_events (
            case_id, merchant_id, from_status, to_status, actor_type, actor_id, reason, payload, correlation_id
          ) VALUES (?, ?, 'detected', 'diagnosing', 'agent', 'agent-v1', 'Automated failure diagnosis initiated', JSON_OBJECT('rule', 'auto_diagnose'), ?)`,
          [caseId, merchantId, correlationId]
        );
        const eventId = (eventRes as unknown as { insertId: number }).insertId;
        expect(eventId).toBeGreaterThan(0);

        // 5. Insert merchant policy
        const [policyRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO policies (
            merchant_id, autonomy_tier, max_retries, daily_budget_minor_units, max_incentive_percent, timezone, is_active, version
          ) VALUES (?, 'T2', 4, 100000, 10.00, 'Asia/Kolkata', TRUE, 1)`,
          [merchantId]
        );
        const policyId = (policyRes as unknown as { insertId: number }).insertId;
        expect(policyId).toBeGreaterThan(0);

        // 6. Insert audit log
        const [auditRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO audit_logs (
            merchant_id, actor_type, actor_id, event_type, resource_type, resource_id, payload_after, ip_address, correlation_id
          ) VALUES (?, 'operator', 'op-123', 'case_status_transition', 'case', ?, JSON_OBJECT('new_status', 'diagnosing'), '127.0.0.1', ?)`,
          [merchantId, String(caseId), correlationId]
        );
        const auditId = (auditRes as unknown as { insertId: number }).insertId;
        expect(auditId).toBeGreaterThan(0);

        // Verify retrieval and join
        const [joined] = await conn.query<RowDataPacket[]>(
          `SELECT c.case_ref, c.status, c.recoverable_amount, e.to_status, e.actor_type, p.autonomy_tier 
           FROM cases c
           JOIN case_events e ON e.case_id = c.id
           JOIN policies p ON p.merchant_id = c.merchant_id
           WHERE c.id = ?`,
          [caseId]
        );

        expect(joined.length).toBe(1);
        expect(joined[0].case_ref).toBe(caseRef);
        expect(joined[0].status).toBe('detected');
        expect(joined[0].to_status).toBe('diagnosing');
        expect(joined[0].actor_type).toBe('agent');
        expect(joined[0].autonomy_tier).toBe('T2');
        expect(Number(joined[0].recoverable_amount)).toBe(5000);

        await conn.rollback();
      } finally {
        conn.release();
      }
    });

    it('enforces foreign key cascading when a case or user is deleted', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const testEmail = `test_cascade_${Date.now()}@example.com`;
        const [userRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO users (email, password_hash, merchant_name, status) VALUES (?, 'hash', 'Cascade Test', 'active')`,
          [testEmail]
        );
        const merchantId = (userRes as unknown as { insertId: number }).insertId;

        const [orderRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO orders (merchant_id, order_ref, amount, currency, status) VALUES (?, '01JCASORDER00000000000001', 10.00, 'INR', 'failed')`,
          [merchantId]
        );
        const orderId = (orderRes as unknown as { insertId: number }).insertId;

        const [caseRes] = await conn.query<RowDataPacket[] & { insertId: number }>(
          `INSERT INTO cases (merchant_id, case_ref, order_id, status, recoverable_amount, originating_signal, correlation_id)
           VALUES (?, '01JCASCASE0000000000000001', ?, 'detected', 1000, 'payment_failed', '01JCASCORR0000000000000001')`,
          [merchantId, orderId]
        );
        const caseId = (caseRes as unknown as { insertId: number }).insertId;

        await conn.query(
          `INSERT INTO case_events (case_id, merchant_id, from_status, to_status, actor_type, correlation_id)
           VALUES (?, ?, 'detected', 'diagnosing', 'system', '01JCASCORR0000000000000001')`,
          [caseId, merchantId]
        );

        // Delete the case -> case_events should cascade delete
        await conn.query('DELETE FROM cases WHERE id = ?', [caseId]);

        const [eventsAfter] = await conn.query<RowDataPacket[]>(
          'SELECT * FROM case_events WHERE case_id = ?',
          [caseId]
        );
        expect(eventsAfter.length).toBe(0);

        await conn.rollback();
      } finally {
        conn.release();
      }
    });
  });

  describe('Migration Rollback & Reversibility', () => {
    it('cleanly rolls back migration 005 and re-applies it without errors', async () => {
      // 1. Rollback 1 step (005_recovery_schema)
      const rollbackResult = await rollbackMigrations({ migrationsDir, step: 1 });
      expect(rollbackResult.length).toBe(1);
      expect(rollbackResult[0].version).toBe(5);
      expect(rollbackResult[0].name).toBe('recovery_schema');

      // 2. Verify tables are dropped
      const conn = await pool.getConnection();
      try {
        const [tables] = await conn.query<RowDataPacket[]>(`
          SELECT TABLE_NAME 
          FROM information_schema.tables 
          WHERE table_schema = DATABASE() 
            AND table_name IN ('cases', 'case_events', 'policies', 'audit_logs')
        `);
        expect(tables.length).toBe(0);
      } finally {
        conn.release();
      }

      // 3. Verify status reports 005 as PENDING
      const statusAfterRollback = await getMigrationStatus({ migrationsDir });
      expect(statusAfterRollback.appliedCount).toBe(4);
      expect(statusAfterRollback.pendingCount).toBe(1);
      const pendingMigration = statusAfterRollback.migrations.find((m) => m.version === 5);
      expect(pendingMigration?.status).toBe('PENDING');

      // 4. Re-apply migration 005
      const reApplyResult = await runMigrations({ migrationsDir });
      expect(reApplyResult.length).toBe(1);
      expect(reApplyResult[0].version).toBe(5);

      // 5. Verify all 5 migrations are APPLIED
      const finalStatus = await getMigrationStatus({ migrationsDir });
      expect(finalStatus.appliedCount).toBe(5);
      expect(finalStatus.pendingCount).toBe(0);
      expect(finalStatus.hasMismatch).toBe(false);
    });
  });
});
