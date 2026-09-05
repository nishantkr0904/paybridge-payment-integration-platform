import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import { generateUlid } from '../../utils/ulid.js';
import { validateTransition } from './case.state-machine.js';
import { recordCaseTransition, recordRecoverySuccess } from '../../infrastructure/metrics.js';
import type {
  ActorType,
  CaseEvent,
  CaseStatus,
  CreateCaseEventInput,
  CreateCaseInput,
  LedgerFilters,
  RecoveryCase,
  TransitionCaseInput
} from './case.types.js';

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

type CaseEventRow = RowDataPacket & {
  id: number;
  case_id: number;
  merchant_id: number;
  from_status: CaseStatus | null;
  to_status: CaseStatus;
  actor_type: ActorType;
  actor_id: string | null;
  reason: string | null;
  payload: string | Record<string, unknown> | null;
  correlation_id: string;
  created_at: Date;
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

function toCaseEvent(row: CaseEventRow): CaseEvent {
  let parsedPayload: Record<string, unknown> | null = null;
  if (row.payload) {
    if (typeof row.payload === 'object') {
      parsedPayload = row.payload as Record<string, unknown>;
    } else if (typeof row.payload === 'string') {
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch {
        parsedPayload = null;
      }
    }
  }

  return {
    id: row.id,
    caseId: row.case_id,
    merchantId: row.merchant_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorType: row.actor_type,
    actorId: row.actor_id,
    reason: row.reason,
    payload: parsedPayload,
    correlationId: row.correlation_id,
    createdAt: row.created_at
  };
}

/* ------------------------------------------------------------------ */
/*  Tenant-Scoped Repository Queries                                  */
/* ------------------------------------------------------------------ */

export async function findCaseByRef(
  caseRef: string,
  merchantId: number
): Promise<RecoveryCase | null> {
  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE case_ref = :caseRef AND merchant_id = :merchantId`,
    { caseRef, merchantId }
  );
  return rows[0] ? toCase(rows[0]) : null;
}

export async function findCaseById(
  id: number,
  merchantId: number
): Promise<RecoveryCase | null> {
  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE id = :id AND merchant_id = :merchantId`,
    { id, merchantId }
  );
  return rows[0] ? toCase(rows[0]) : null;
}

export async function findCaseByTransactionId(
  transactionId: number,
  merchantId: number
): Promise<RecoveryCase | null> {
  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE transaction_id = :transactionId AND merchant_id = :merchantId`,
    { transactionId, merchantId }
  );
  return rows[0] ? toCase(rows[0]) : null;
}

export async function findCaseByOrderId(
  orderId: number,
  merchantId: number
): Promise<RecoveryCase | null> {
  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE order_id = :orderId AND merchant_id = :merchantId ORDER BY id DESC LIMIT 1`,
    { orderId, merchantId }
  );
  return rows[0] ? toCase(rows[0]) : null;
}

export async function findCasesByMerchantId(merchantId: number): Promise<RecoveryCase[]> {
  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE merchant_id = :merchantId ORDER BY id DESC`,
    { merchantId }
  );
  return rows.map(toCase);
}

export async function findActiveCases(merchantId?: number): Promise<RecoveryCase[]> {
  const activeStatuses = [
    'detected',
    'diagnosing',
    'scoring',
    'deciding',
    'awaiting_approval',
    'executing',
    'awaiting_outcome'
  ];

  if (merchantId) {
    const [rows] = await pool.query<CaseRow[]>(
      `SELECT * FROM cases WHERE merchant_id = ? AND status IN (?) ORDER BY id ASC`,
      [merchantId, activeStatuses]
    );
    return rows.map(toCase);
  }

  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE status IN (?) ORDER BY id ASC`,
    [activeStatuses]
  );
  return rows.map(toCase);
}

export async function findCasesWithFilters(
  merchantId: number,
  filters?: LedgerFilters
): Promise<RecoveryCase[]> {
  const conditions: string[] = ['merchant_id = ?'];
  const params: unknown[] = [merchantId];

  if (filters?.startDate) {
    conditions.push('created_at >= ?');
    params.push(filters.startDate);
  }

  if (filters?.endDate) {
    conditions.push('created_at <= ?');
    params.push(filters.endDate);
  }

  if (filters?.currency) {
    conditions.push('currency = ?');
    params.push(filters.currency);
  }

  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE ${conditions.join(' AND ')} ORDER BY id DESC`,
    params
  );
  return rows.map(toCase);
}

export async function findCaseEventsByCaseId(
  caseId: number,
  merchantId: number
): Promise<CaseEvent[]> {
  const [rows] = await pool.query<CaseEventRow[]>(
    `SELECT * FROM case_events WHERE case_id = :caseId AND merchant_id = :merchantId ORDER BY id ASC`,
    { caseId, merchantId }
  );
  return rows.map(toCaseEvent);
}

/**
 * Appends a new event to a case's chronological event store without changing case status.
 */
export async function addCaseEvent(
  caseId: number,
  merchantId: number,
  event: CreateCaseEventInput
): Promise<CaseEvent> {
  const conn = await pool.getConnection();
  try {
    const payloadJson = event.payload ? JSON.stringify(event.payload) : null;
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO case_events (
        case_id, merchant_id, from_status, to_status,
        actor_type, actor_id, reason, payload, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        caseId,
        merchantId,
        event.fromStatus ?? null,
        event.toStatus,
        event.actorType,
        event.actorId ?? null,
        event.reason ?? null,
        payloadJson,
        event.correlationId
      ]
    );

    const [rows] = await conn.query<CaseEventRow[]>(
      `SELECT * FROM case_events WHERE id = ? AND merchant_id = ?`,
      [result.insertId, merchantId]
    );

    if (!rows[0]) {
      throw new Error(`Failed to retrieve newly appended event for case ${caseId}`);
    }

    return toCaseEvent(rows[0]);
  } finally {
    conn.release();
  }
}

export async function getShedEventCount(merchantId?: number): Promise<number> {
  if (merchantId) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM case_events WHERE merchant_id = :merchantId AND to_status = 'suppressed' AND reason LIKE '%CAPACITY_LOAD_SHED%'`,
      { merchantId }
    );
    return Number(rows[0]?.cnt || 0);
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) as cnt FROM case_events WHERE to_status = 'suppressed' AND reason LIKE '%CAPACITY_LOAD_SHED%'`
  );
  return Number(rows[0]?.cnt || 0);
}

/* ------------------------------------------------------------------ */
/*  Transactional Mutations & Event Store Ingestion                   */
/* ------------------------------------------------------------------ */

/**
 * Creates a new recovery case and records its initial CaseCreated event atomically.
 */
export async function createCaseWithEvent(
  merchantId: number,
  input: CreateCaseInput,
  event: CreateCaseEventInput
): Promise<RecoveryCase> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    if (input.transactionId) {
      const [existingRows] = await conn.query<CaseRow[]>(
        `SELECT * FROM cases WHERE transaction_id = ? AND merchant_id = ? FOR UPDATE`,
        [input.transactionId, merchantId]
      );
      if (existingRows.length > 0) {
        await conn.commit();
        return toCase(existingRows[0]!);
      }
    } else if (input.orderId) {
      const [existingRows] = await conn.query<CaseRow[]>(
        `SELECT * FROM cases WHERE order_id = ? AND merchant_id = ? FOR UPDATE`,
        [input.orderId, merchantId]
      );
      if (existingRows.length > 0) {
        await conn.commit();
        return toCase(existingRows[0]!);
      }
    }

    const caseRef = generateUlid();
    const status = input.initialStatus || 'detected';
    const currency = input.currency || 'INR';

    const [caseResult] = await conn.query<ResultSetHeader>(
      `INSERT INTO cases (
        merchant_id, case_ref, order_id, transaction_id,
        status, recoverable_amount, currency, originating_signal,
        failure_category, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchantId,
        caseRef,
        input.orderId,
        input.transactionId ?? null,
        status,
        input.recoverableAmount,
        currency,
        input.originatingSignal,
        input.failureCategory ?? null,
        input.correlationId
      ]
    );

    const caseId = caseResult.insertId;

    const payloadJson = event.payload ? JSON.stringify(event.payload) : null;

    await conn.query<ResultSetHeader>(
      `INSERT INTO case_events (
        case_id, merchant_id, from_status, to_status,
        actor_type, actor_id, reason, payload, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        caseId,
        merchantId,
        event.fromStatus ?? null,
        event.toStatus,
        event.actorType,
        event.actorId ?? null,
        event.reason ?? null,
        payloadJson,
        event.correlationId
      ]
    );

    const [rows] = await conn.query<CaseRow[]>(
      `SELECT * FROM cases WHERE id = ? AND merchant_id = ?`,
      [caseId, merchantId]
    );

    await conn.commit();

    if (!rows[0]) {
      throw new Error('Failed to retrieve newly created case');
    }

    const created = toCase(rows[0]);
    recordCaseTransition(null, created.status);

    return created;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Transitions a case to a new status and records the transition event atomically.
 * Validates transition rules under row lock.
 */
export async function transitionCaseStatus(
  caseId: number,
  merchantId: number,
  input: TransitionCaseInput
): Promise<RecoveryCase> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [caseRows] = await conn.query<CaseRow[]>(
      `SELECT * FROM cases WHERE id = ? AND merchant_id = ? FOR UPDATE`,
      [caseId, merchantId]
    );

    if (!caseRows[0]) {
      throw new Error(`Recovery case ${caseId} not found for merchant ${merchantId}`);
    }

    const currentCase = toCase(caseRows[0]);
    const fromStatus = currentCase.status;
    const toStatus = input.toStatus;

    // Validate state transition through the deterministic state machine
    validateTransition(fromStatus, toStatus);

    // Update status in storage
    await conn.query(
      `UPDATE cases SET status = ? WHERE id = ? AND merchant_id = ?`,
      [toStatus, caseId, merchantId]
    );

    // Append to immutable case_events event store
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null;

    await conn.query<ResultSetHeader>(
      `INSERT INTO case_events (
        case_id, merchant_id, from_status, to_status,
        actor_type, actor_id, reason, payload, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        caseId,
        merchantId,
        fromStatus,
        toStatus,
        input.actorType,
        input.actorId ?? null,
        input.reason ?? null,
        payloadJson,
        input.correlationId
      ]
    );

    const [updatedRows] = await conn.query<CaseRow[]>(
      `SELECT * FROM cases WHERE id = ? AND merchant_id = ?`,
      [caseId, merchantId]
    );

    await conn.commit();

    const updatedCase = toCase(updatedRows[0]!);
    recordCaseTransition(fromStatus, toStatus);

    if (toStatus === 'recovered') {
      const durationSeconds = (Date.now() - new Date(currentCase.createdAt).getTime()) / 1000;
      recordRecoverySuccess({
        durationSeconds: Math.max(0, durationSeconds),
        actionType: (input.payload?.actionType as string) || 'RETRY_PAYMENT',
        amountMinorUnits: currentCase.recoverableAmount,
        currency: currentCase.currency
      });
    }

    return updatedCase;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Bulk sheds cases by transitioning them to 'suppressed' status with a recorded shed event.
 * (RCV-002 Requirement 7)
 */
export async function bulkShedCases(
  caseIds: number[],
  merchantId: number,
  reason: string,
  correlationId: string
): Promise<RecoveryCase[]> {
  if (caseIds.length === 0) return [];

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [caseRows] = await conn.query<CaseRow[]>(
      `SELECT * FROM cases WHERE id IN (?) AND merchant_id = ? FOR UPDATE`,
      [caseIds, merchantId]
    );

    const updatedCases: RecoveryCase[] = [];

    for (const row of caseRows) {
      const currentCase = toCase(row);
      validateTransition(currentCase.status, 'suppressed');

      await conn.query(
        `UPDATE cases SET status = 'suppressed' WHERE id = ? AND merchant_id = ?`,
        [currentCase.id, merchantId]
      );

      await conn.query<ResultSetHeader>(
        `INSERT INTO case_events (
          case_id, merchant_id, from_status, to_status,
          actor_type, actor_id, reason, payload, correlation_id
        ) VALUES (?, ?, ?, 'suppressed', 'system', 'queue_load_shedder', ?, ?, ?)`,
        [
          currentCase.id,
          merchantId,
          currentCase.status,
          reason,
          JSON.stringify({ shedAt: new Date().toISOString() }),
          correlationId
        ]
      );

      currentCase.status = 'suppressed';
      updatedCases.push(currentCase);
    }

    await conn.commit();

    for (const c of updatedCases) {
      recordCaseTransition(c.status, 'suppressed');
    }

    return updatedCases;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
