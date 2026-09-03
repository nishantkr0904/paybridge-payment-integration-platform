import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import type {
  CreateIdempotencyRecordInput,
  IdempotencyRecord,
  IdempotencyStatus
} from './idempotency.types.js';

type IdempotencyRow = RowDataPacket & {
  id: number;
  merchant_id: number;
  idempotency_key: string;
  request_path: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown | null;
  status: IdempotencyStatus;
  created_at: Date;
  updated_at: Date;
};

function toIdempotencyRecord(row: IdempotencyRow): IdempotencyRecord {
  let parsedBody = row.response_body;
  if (typeof parsedBody === 'string') {
    try {
      parsedBody = JSON.parse(parsedBody);
    } catch {
      // Keep as string if parsing fails
    }
  }

  return {
    id: row.id,
    merchantId: row.merchant_id,
    idempotencyKey: row.idempotency_key,
    requestPath: row.request_path,
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: parsedBody,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function insertIdempotencyKey(input: CreateIdempotencyRecordInput): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO idempotency_keys (merchant_id, idempotency_key, request_path, request_hash, status)
     VALUES (:merchantId, :idempotencyKey, :requestPath, :requestHash, 'processing')`,
    input
  );

  return result.affectedRows > 0;
}

export async function findIdempotencyKey(
  merchantId: number,
  idempotencyKey: string
): Promise<IdempotencyRecord | null> {
  const [rows] = await pool.query<IdempotencyRow[]>(
    `SELECT * FROM idempotency_keys WHERE merchant_id = :merchantId AND idempotency_key = :idempotencyKey`,
    { merchantId, idempotencyKey }
  );

  return rows[0] ? toIdempotencyRecord(rows[0]) : null;
}

export async function updateIdempotencyKey(
  merchantId: number,
  idempotencyKey: string,
  status: IdempotencyStatus,
  responseStatus?: number | null,
  responseBody?: unknown
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
     SET status = :status,
         response_status = :responseStatus,
         response_body = :responseBody
     WHERE merchant_id = :merchantId AND idempotency_key = :idempotencyKey`,
    {
      merchantId,
      idempotencyKey,
      status,
      responseStatus: responseStatus ?? null,
      responseBody: responseBody !== undefined ? JSON.stringify(responseBody) : null
    }
  );
}

export async function reclaimFailedIdempotencyKey(
  merchantId: number,
  idempotencyKey: string,
  requestPath: string,
  requestHash: string
): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE idempotency_keys
     SET status = 'processing',
         request_path = :requestPath,
         request_hash = :requestHash,
         response_status = NULL,
         response_body = NULL
     WHERE merchant_id = :merchantId AND idempotency_key = :idempotencyKey AND status = 'failed'`,
    {
      merchantId,
      idempotencyKey,
      requestPath,
      requestHash
    }
  );

  return result.affectedRows > 0;
}

export async function deleteIdempotencyKey(
  merchantId: number,
  idempotencyKey: string
): Promise<void> {
  await pool.query(
    `DELETE FROM idempotency_keys WHERE merchant_id = :merchantId AND idempotency_key = :idempotencyKey`,
    { merchantId, idempotencyKey }
  );
}
