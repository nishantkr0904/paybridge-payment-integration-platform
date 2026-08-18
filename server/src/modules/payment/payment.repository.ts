import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import type {
  Order,
  OrderFilters,
  OrderStatus,
  Transaction,
  TransactionStatus
} from './payment.types.js';

/* ------------------------------------------------------------------ */
/*  Row types                                                         */
/* ------------------------------------------------------------------ */

type OrderRow = RowDataPacket & {
  id: number;
  merchant_id: number;
  order_ref: string;
  amount: string;
  currency: string;
  description: string | null;
  status: OrderStatus;
  customer_email: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

type TransactionRow = RowDataPacket & {
  id: number;
  order_id: number;
  txn_ref: string;
  payment_method: Transaction['paymentMethod'];
  status: TransactionStatus;
  gateway_response: Record<string, unknown> | null;
  failure_reason: string | null;
  amount: string;
  created_at: Date;
  updated_at: Date;
};

/* ------------------------------------------------------------------ */
/*  Mappers                                                           */
/* ------------------------------------------------------------------ */

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    orderRef: row.order_ref,
    amount: Number(row.amount),
    currency: row.currency,
    description: row.description,
    status: row.status,
    customerEmail: row.customer_email,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    orderId: row.order_id,
    txnRef: row.txn_ref,
    paymentMethod: row.payment_method,
    status: row.status,
    gatewayResponse: row.gateway_response,
    failureReason: row.failure_reason,
    amount: Number(row.amount),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/* ------------------------------------------------------------------ */
/*  Orders                                                            */
/* ------------------------------------------------------------------ */

export async function createOrder(input: {
  merchantId: number;
  orderRef: string;
  amount: number;
  currency: string;
  description?: string;
  customerEmail?: string;
  metadata?: Record<string, unknown>;
}): Promise<Order> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO orders (merchant_id, order_ref, amount, currency, description, customer_email, metadata)
     VALUES (:merchantId, :orderRef, :amount, :currency, :description, :customerEmail, :metadata)`,
    {
      merchantId: input.merchantId,
      orderRef: input.orderRef,
      amount: input.amount,
      currency: input.currency,
      description: input.description ?? null,
      customerEmail: input.customerEmail ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null
    }
  );

  return {
    id: result.insertId,
    merchantId: input.merchantId,
    orderRef: input.orderRef,
    amount: input.amount,
    currency: input.currency,
    description: input.description ?? null,
    status: 'pending',
    customerEmail: input.customerEmail ?? null,
    metadata: input.metadata ?? null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

export async function findOrderByRef(orderRef: string): Promise<Order | null> {
  const [rows] = await pool.query<OrderRow[]>(
    `SELECT * FROM orders WHERE order_ref = :orderRef`,
    { orderRef }
  );

  return rows[0] ? toOrder(rows[0]) : null;
}

export async function findOrderById(id: number): Promise<Order | null> {
  const [rows] = await pool.query<OrderRow[]>(
    `SELECT * FROM orders WHERE id = :id`,
    { id }
  );

  return rows[0] ? toOrder(rows[0]) : null;
}

export async function updateOrderStatus(id: number, status: OrderStatus): Promise<void> {
  await pool.query(
    `UPDATE orders SET status = :status WHERE id = :id`,
    { id, status }
  );
}

/* ------------------------------------------------------------------ */
/*  Transactions                                                      */
/* ------------------------------------------------------------------ */

export async function createTransaction(input: {
  orderId: number;
  txnRef: string;
  paymentMethod: Transaction['paymentMethod'];
  amount: number;
}): Promise<Transaction> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO transactions (order_id, txn_ref, payment_method, amount)
     VALUES (:orderId, :txnRef, :paymentMethod, :amount)`,
    input
  );

  return {
    id: result.insertId,
    orderId: input.orderId,
    txnRef: input.txnRef,
    paymentMethod: input.paymentMethod,
    status: 'initiated',
    gatewayResponse: null,
    failureReason: null,
    amount: input.amount,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

export async function updateTransactionStatus(
  id: number,
  status: TransactionStatus,
  gatewayResponse?: Record<string, unknown>,
  failureReason?: string
): Promise<void> {
  await pool.query(
    `UPDATE transactions
     SET status = :status,
         gateway_response = :gatewayResponse,
         failure_reason = :failureReason
     WHERE id = :id`,
    {
      id,
      status,
      gatewayResponse: gatewayResponse ? JSON.stringify(gatewayResponse) : null,
      failureReason: failureReason ?? null
    }
  );
}

export async function findTransactionsByOrderId(orderId: number): Promise<Transaction[]> {
  const [rows] = await pool.query<TransactionRow[]>(
    `SELECT * FROM transactions WHERE order_id = :orderId ORDER BY created_at DESC`,
    { orderId }
  );

  return rows.map(toTransaction);
}

/* ------------------------------------------------------------------ */
/*  Merchant order listing                                            */
/* ------------------------------------------------------------------ */

export async function findOrdersByMerchantId(
  merchantId: number,
  filters: OrderFilters
): Promise<{ orders: Order[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  if (filters.status) {
    const params = { merchantId, status: filters.status };

    const [countRows] = await pool.query<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM orders WHERE merchant_id = :merchantId AND status = :status`,
      params
    );

    const [rows] = await pool.query<OrderRow[]>(
      `SELECT * FROM orders WHERE merchant_id = :merchantId AND status = :status ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit: filters.limit, offset }
    );

    return {
      orders: rows.map(toOrder),
      total: countRows[0]?.total ?? 0
    };
  }

  const params = { merchantId };

  const [countRows] = await pool.query<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM orders WHERE merchant_id = :merchantId`,
    params
  );

  const [rows] = await pool.query<OrderRow[]>(
    `SELECT * FROM orders WHERE merchant_id = :merchantId ORDER BY created_at DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: filters.limit, offset }
  );

  return {
    orders: rows.map(toOrder),
    total: countRows[0]?.total ?? 0
  };
}

/* ------------------------------------------------------------------ */
/*  Merchant summary                                                  */
/* ------------------------------------------------------------------ */

export async function getOrderCountsByMerchant(
  merchantId: number
): Promise<{ total: number; success: number; failed: number; pending: number }> {
  const [rows] = await pool.query<(RowDataPacket & { status: OrderStatus; count: number })[]>(
    `SELECT status, COUNT(*) AS count FROM orders WHERE merchant_id = :merchantId GROUP BY status`,
    { merchantId }
  );

  const counts = { total: 0, success: 0, failed: 0, pending: 0 };

  for (const row of rows) {
    const c = Number(row.count);
    counts.total += c;
    if (row.status === 'success') counts.success = c;
    else if (row.status === 'failed') counts.failed = c;
    else counts.pending += c;
  }

  return counts;
}
