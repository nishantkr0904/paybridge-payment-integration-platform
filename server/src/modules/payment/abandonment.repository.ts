import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import type { CheckoutAbandonedEvent, OrderAbandonmentRecord } from './abandonment.types.js';
import type { Order, OrderStatus } from './payment.types.js';

/* ------------------------------------------------------------------ */
/*  Order Abandonment Persistence (Tenant-Scoped / Invariant I9)     */
/* ------------------------------------------------------------------ */

export async function recordOrderAbandonment(
  merchantId: number,
  orderId: number,
  event: CheckoutAbandonedEvent
): Promise<OrderAbandonmentRecord> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Lock the order row to guarantee transactional concurrency safety
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, metadata FROM orders WHERE id = ? AND merchant_id = ? FOR UPDATE`,
      [orderId, merchantId]
    );

    if (rows.length === 0) {
      await conn.rollback();
      throw new Error(`Order ${orderId} does not exist or does not belong to merchant ${merchantId}`);
    }

    const row = rows[0]!;
    let metadata: Record<string, unknown> = {};

    if (row.metadata) {
      if (typeof row.metadata === 'string') {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          metadata = {};
        }
      } else if (typeof row.metadata === 'object') {
        metadata = { ...(row.metadata as Record<string, unknown>) };
      }
    }

    const history: CheckoutAbandonedEvent[] = Array.isArray(metadata.abandonmentHistory)
      ? (metadata.abandonmentHistory as CheckoutAbandonedEvent[])
      : [];

    // Deduplication check:
    // Duplicate matches by eventId, correlationId, or (sessionId + stage)
    const isDuplicate = history.some((existing) => {
      if (existing.eventId === event.eventId) return true;
      if (existing.correlationId && existing.correlationId === event.correlationId) return true;
      if (
        event.sessionId &&
        existing.sessionId === event.sessionId &&
        existing.stage === event.stage
      ) {
        return true;
      }
      return false;
    });

    if (isDuplicate) {
      await conn.commit();
      return {
        isDuplicate: true,
        totalAbandonmentCount: history.length,
        recordedAt: new Date().toISOString()
      };
    }

    // Append to abandonment history and record latest snapshot
    history.push(event);
    metadata.abandonmentHistory = history;
    metadata.latestAbandonment = {
      eventId: event.eventId,
      stage: event.stage,
      selectedPaymentMethod: event.selectedPaymentMethod,
      dwellTimeSeconds: event.dwellTimeSeconds,
      validationFailureCount: event.validationFailureCount,
      abandonedAt: event.abandonedAt,
      source: event.source,
      correlationId: event.correlationId
    };
    metadata.abandonmentCount = history.length;

    await conn.query<ResultSetHeader>(
      `UPDATE orders SET metadata = ? WHERE id = ? AND merchant_id = ?`,
      [JSON.stringify(metadata), orderId, merchantId]
    );

    await conn.commit();

    return {
      isDuplicate: false,
      totalAbandonmentCount: history.length,
      recordedAt: new Date().toISOString()
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function getOrderAbandonmentHistory(
  merchantId: number,
  orderId: number
): Promise<CheckoutAbandonedEvent[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT metadata FROM orders WHERE id = :orderId AND merchant_id = :merchantId`,
    { orderId, merchantId }
  );

  if (rows.length === 0 || !rows[0]?.metadata) {
    return [];
  }

  let metadata: Record<string, unknown> = {};
  if (typeof rows[0].metadata === 'string') {
    try {
      metadata = JSON.parse(rows[0].metadata);
    } catch {
      return [];
    }
  } else if (typeof rows[0].metadata === 'object') {
    metadata = rows[0].metadata as Record<string, unknown>;
  }

  return Array.isArray(metadata.abandonmentHistory)
    ? (metadata.abandonmentHistory as CheckoutAbandonedEvent[])
    : [];
}

/* ------------------------------------------------------------------ */
/*  Timeout Detection Order Query (SIG-002 / BT-D2)                  */
/* ------------------------------------------------------------------ */

export interface FindPendingOrdersOptions {
  merchantId?: number;
  limit?: number;
}

/**
 * Finds pending checkout orders eligible for timeout detection.
 * Enforces status = 'pending' and optional tenant filtering (SEC-002, Invariant I9).
 */
export async function findPendingOrdersForTimeoutDetection(
  options: FindPendingOrdersOptions = {}
): Promise<Order[]> {
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));

  const [rows] =
    options.merchantId !== undefined
      ? await pool.query<RowDataPacket[]>(
          `SELECT * FROM orders WHERE status = 'pending' AND merchant_id = ? ORDER BY id ASC LIMIT ?`,
          [options.merchantId, limit]
        )
      : await pool.query<RowDataPacket[]>(
          `SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC LIMIT ?`,
          [limit]
        );

  return rows.map((row) => {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      if (typeof row.metadata === 'string') {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          metadata = null;
        }
      } else if (typeof row.metadata === 'object') {
        metadata = row.metadata as Record<string, unknown>;
      }
    }

    return {
      id: row.id,
      merchantId: row.merchant_id,
      orderRef: row.order_ref,
      amount: Number(row.amount),
      currency: row.currency,
      description: row.description ?? null,
      status: row.status as OrderStatus,
      customerEmail: row.customer_email ?? null,
      metadata,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)
    };
  });
}
