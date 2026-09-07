import { pool } from '../../config/database.js';
import type { WebhookEndpoint, WebhookDelivery } from './webhook.types.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export async function createWebhookEndpoint(merchantId: number, url: string, secret: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret) VALUES (?, ?, ?)`,
    [merchantId, url, secret]
  );
  return result.insertId;
}

export async function getWebhookEndpoints(merchantId: number): Promise<WebhookEndpoint[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, merchant_id as merchantId, url, secret, is_active as isActive, created_at as createdAt, updated_at as updatedAt
     FROM webhook_endpoints WHERE merchant_id = ? ORDER BY created_at DESC`,
    [merchantId]
  );
  return rows as WebhookEndpoint[];
}

export async function getWebhookDeliveries(merchantId: number, limit = 50): Promise<WebhookDelivery[]> {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT d.id, d.endpoint_id as endpointId, d.event_type as eventType, d.payload, d.status, d.response_status as responseStatus, d.created_at as createdAt
     FROM webhook_deliveries d
     JOIN webhook_endpoints e ON d.endpoint_id = e.id
     WHERE e.merchant_id = ?
     ORDER BY d.created_at DESC LIMIT ${safeLimit}`,
    [merchantId]
  );
  return rows as WebhookDelivery[];
}

export async function logWebhookDelivery(
  endpointId: number,
  eventType: string,
  payload: Record<string, unknown>,
  status: 'pending' | 'success' | 'failed',
  responseStatus: number | null
): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, status, response_status) VALUES (?, ?, ?, ?, ?)`,
    [endpointId, eventType, JSON.stringify(payload), status, responseStatus]
  );
  return result.insertId;
}

export async function updateWebhookDelivery(
  id: number,
  status: 'success' | 'failed',
  responseStatus: number | null
): Promise<void> {
  await pool.execute(
    `UPDATE webhook_deliveries SET status = ?, response_status = ? WHERE id = ?`,
    [status, responseStatus, id]
  );
}
