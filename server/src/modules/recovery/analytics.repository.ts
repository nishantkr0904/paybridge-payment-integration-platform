import type { RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import type { CaseStatus, RecoveryCase } from './case.types.js';
import type { RecoveryAnalyticsFilters } from './analytics.types.js';

/* ------------------------------------------------------------------ */
/*  Row Types & Mappers                                               */
/* ------------------------------------------------------------------ */

type CaseRow = RowDataPacket & {
  id: number;
  merchant_id: number;
  case_ref: string;
  order_id: number;
  transaction_id: number | null;
  status: CaseStatus;
  recoverable_amount: string | number;
  currency: string;
  originating_signal: string;
  failure_category: string | null;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
};

type LatencyRow = RowDataPacket & {
  caseId: number;
  createdAt: Date;
  recoveredAt: Date;
  durationSeconds: number;
};

type AttemptRow = RowDataPacket & {
  caseId: number;
  actionType: string;
  createdAt: Date;
};

type RecoveredOutcomeRow = RowDataPacket & {
  caseId: number;
  recoverableAmount: string | number;
  currency: string;
  strategy: string;
};

function toCase(row: CaseRow): RecoveryCase {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    caseRef: row.case_ref,
    orderId: row.order_id,
    transactionId: row.transaction_id,
    status: row.status,
    recoverableAmount: Number(row.recoverable_amount),
    currency: row.currency,
    originatingSignal: row.originating_signal,
    failureCategory: row.failure_category,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/* ------------------------------------------------------------------ */
/*  Repository Query Implementations (Tenant-Isolated / Filtered)     */
/* ------------------------------------------------------------------ */

/**
 * Retrieves raw case records for analytics calculation, adhering to strict tenant boundaries.
 */
export async function fetchCasesForAnalytics(
  merchantId: number | null,
  filters?: RecoveryAnalyticsFilters
): Promise<RecoveryCase[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (merchantId !== null) {
    conditions.push('c.merchant_id = ?');
    params.push(merchantId);
  }

  if (filters?.startDate) {
    conditions.push('c.created_at >= ?');
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    conditions.push('c.created_at <= ?');
    params.push(filters.endDate);
  }

  if (filters?.currency) {
    conditions.push('c.currency = ?');
    params.push(filters.currency);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.query<CaseRow[]>(
    `SELECT c.* FROM cases c ${whereClause} ORDER BY c.id ASC`,
    params
  );

  return rows.map(toCase);
}

/**
 * Computes individual case recovery latencies (TTR) from real persisted timestamps.
 * Calculated as the interval between case detection (cases.created_at) and
 * successful recovery capture (case_events.created_at where to_status = 'recovered').
 */
export async function fetchCaseLatencies(
  merchantId: number | null,
  filters?: RecoveryAnalyticsFilters
): Promise<{ caseId: number; durationSeconds: number }[]> {
  const conditions: string[] = ["c.status = 'recovered'", "e.to_status = 'recovered'"];
  const params: unknown[] = [];

  if (merchantId !== null) {
    conditions.push('c.merchant_id = ?', 'e.merchant_id = ?');
    params.push(merchantId, merchantId);
  }

  if (filters?.startDate) {
    conditions.push('c.created_at >= ?');
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    conditions.push('c.created_at <= ?');
    params.push(filters.endDate);
  }

  if (filters?.currency) {
    conditions.push('c.currency = ?');
    params.push(filters.currency);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const [rows] = await pool.query<LatencyRow[]>(
    `SELECT
      c.id AS caseId,
      c.created_at AS createdAt,
      MIN(e.created_at) AS recoveredAt,
      TIMESTAMPDIFF(SECOND, c.created_at, MIN(e.created_at)) AS durationSeconds
    FROM cases c
    JOIN case_events e ON e.case_id = c.id
    ${whereClause}
    GROUP BY c.id, c.created_at
    ORDER BY durationSeconds ASC`,
    params
  );

  return rows.map((r) => ({
    caseId: r.caseId,
    durationSeconds: Math.max(0, Number(r.durationSeconds || 0))
  }));
}

/**
 * Retrieves all executed recovery attempts grouped by action / strategy type.
 * Pulls from the immutable case_events event store for transitions to 'executing'.
 */
export async function fetchExecutionAttempts(
  merchantId: number | null,
  filters?: RecoveryAnalyticsFilters
): Promise<{ caseId: number; actionType: string; createdAt: Date }[]> {
  const conditions: string[] = ["e.to_status = 'executing'"];
  const params: unknown[] = [];

  if (merchantId !== null) {
    conditions.push('e.merchant_id = ?', 'c.merchant_id = ?');
    params.push(merchantId, merchantId);
  }

  if (filters?.startDate) {
    conditions.push('c.created_at >= ?');
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    conditions.push('c.created_at <= ?');
    params.push(filters.endDate);
  }

  if (filters?.currency) {
    conditions.push('c.currency = ?');
    params.push(filters.currency);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const [rows] = await pool.query<AttemptRow[]>(
    `SELECT
      e.case_id AS caseId,
      COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.actionType')), 'null'),
        'RETRY_PAYMENT'
      ) AS actionType,
      e.created_at AS createdAt
    FROM case_events e
    JOIN cases c ON c.id = e.case_id
    ${whereClause}
    ORDER BY e.id ASC`,
    params
  );

  return rows.map((r) => ({
    caseId: r.caseId,
    actionType: r.actionType || 'RETRY_PAYMENT',
    createdAt: r.createdAt
  }));
}

/**
 * Retrieves successfully recovered cases with their attributed strategy and recoverable revenue.
 */
export async function fetchRecoveredCaseStrategies(
  merchantId: number | null,
  filters?: RecoveryAnalyticsFilters
): Promise<{ caseId: number; recoverableAmount: number; currency: string; strategy: string }[]> {
  const conditions: string[] = ["c.status = 'recovered'"];
  const params: unknown[] = [];

  if (merchantId !== null) {
    conditions.push('c.merchant_id = ?');
    params.push(merchantId);
  }

  if (filters?.startDate) {
    conditions.push('c.created_at >= ?');
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    conditions.push('c.created_at <= ?');
    params.push(filters.endDate);
  }

  if (filters?.currency) {
    conditions.push('c.currency = ?');
    params.push(filters.currency);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const [rows] = await pool.query<RecoveredOutcomeRow[]>(
    `SELECT
      c.id AS caseId,
      c.recoverable_amount AS recoverableAmount,
      c.currency AS currency,
      COALESCE(
        (
          SELECT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.actionType')), 'null')
          FROM case_events e
          WHERE e.case_id = c.id
            AND e.to_status IN ('executing', 'recovered')
            AND JSON_EXTRACT(e.payload, '$.actionType') IS NOT NULL
          ORDER BY e.id DESC
          LIMIT 1
        ),
        'RETRY_PAYMENT'
      ) AS strategy
    FROM cases c
    ${whereClause}
    ORDER BY c.id ASC`,
    params
  );

  return rows.map((r) => ({
    caseId: r.caseId,
    recoverableAmount: Number(r.recoverableAmount),
    currency: r.currency,
    strategy: r.strategy || 'RETRY_PAYMENT'
  }));
}
