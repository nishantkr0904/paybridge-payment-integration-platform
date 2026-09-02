import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import { generateUlid } from '../../utils/ulid.js';
import { validateTransition } from './case.state-machine.js';
import type {
  ActorType,
  CaseEvent,
  CaseStatus,
  CreateCaseEventInput,
  CreateCaseInput,
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

export async function findCasesByMerchantId(merchantId: number): Promise<RecoveryCase[]> {
  const [rows] = await pool.query<CaseRow[]>(
    `SELECT * FROM cases WHERE merchant_id = :merchantId ORDER BY id DESC`,
    { merchantId }
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

    return toCase(rows[0]);
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

    return toCase(updatedRows[0]!);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
