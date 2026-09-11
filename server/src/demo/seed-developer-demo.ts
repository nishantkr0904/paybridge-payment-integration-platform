#!/usr/bin/env node
import '../config/env.js';
import bcrypt from 'bcryptjs';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool, closePool } from '../config/database.js';

/* ------------------------------------------------------------------ */
/*  Deterministic Demo Developer Seeding (Task 1)                     */
/* ------------------------------------------------------------------ */

export interface SeedDeveloperDemoResult {
  merchantId: number;
  email: string;
  merchantName: string;
  role: string;
  endpointId: number;
  endpointUrl: string;
  deliveries: Array<{
    id: number;
    eventType: string;
    status: 'success' | 'failed' | 'pending';
    responseStatus: number | null;
  }>;
}

export async function seedDeveloperDemo(): Promise<SeedDeveloperDemoResult> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Deterministic Demo Developer User
    const demoEmail = 'developer@paybridge.test';
    const demoPassword = 'Developer123!';
    const demoMerchantName = "Arjun's Developer Store";
    const demoRole = 'merchant_developer';

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

    // Assign 'merchant_developer' role idempotently
    await conn.query(
      `INSERT IGNORE INTO user_roles (user_id, role_id)
       SELECT ?, id FROM roles WHERE name = ?`,
      [merchantId, demoRole]
    );

    // 2. Deterministic Configured Webhook Endpoint
    const demoEndpointUrl = 'https://api.merchant.example.com/webhooks/paybridge';
    const demoSecret = 'whsec_d3v310p3rd3m0s3cr3tk3y9999';

    const [existingEndpoints] = await conn.query<RowDataPacket[]>(
      `SELECT id, url FROM webhook_endpoints WHERE merchant_id = ? AND url = ?`,
      [merchantId, demoEndpointUrl]
    );

    let endpointId: number;
    if (existingEndpoints.length > 0 && existingEndpoints[0]?.id) {
      endpointId = Number(existingEndpoints[0].id);
      await conn.query(
        `UPDATE webhook_endpoints SET secret = ?, is_active = TRUE WHERE id = ?`,
        [demoSecret, endpointId]
      );
    } else {
      const [insertEndpoint] = await conn.query<ResultSetHeader>(
        `INSERT INTO webhook_endpoints (merchant_id, url, secret, is_active) VALUES (?, ?, ?, TRUE)`,
        [merchantId, demoEndpointUrl, demoSecret]
      );
      endpointId = insertEndpoint.insertId;
    }

    // 3. Three Realistic Webhook Deliveries
    const deliveryPayloads = [
      {
        eventType: 'payment.succeeded',
        status: 'success' as const,
        responseStatus: 200,
        payload: {
          id: 'evt_demo_pay_succ_001',
          type: 'payment.succeeded',
          createdAt: '2026-09-11T12:00:00.000Z',
          data: {
            orderId: 9155,
            orderRef: 'ORD_DEV_DEMO_001',
            transactionId: 10842,
            amount: 25000,
            currency: 'INR',
            status: 'success',
            paymentMethod: 'card',
            customerEmail: 'customer1@example.com'
          }
        }
      },
      {
        eventType: 'payment.failed',
        status: 'failed' as const,
        responseStatus: 500,
        payload: {
          id: 'evt_demo_pay_fail_002',
          type: 'payment.failed',
          createdAt: '2026-09-11T12:15:00.000Z',
          data: {
            orderId: 9156,
            orderRef: 'ORD_DEV_DEMO_002',
            transactionId: 10843,
            amount: 45000,
            currency: 'INR',
            status: 'failed',
            failureCode: 'INSUFFICIENT_FUNDS',
            failureMessage: 'Debit card issuer returned decline code 51 (insufficient funds)',
            customerEmail: 'customer2@example.com'
          }
        }
      },
      {
        eventType: 'recovery.started',
        status: 'success' as const,
        responseStatus: 200,
        payload: {
          id: 'evt_demo_rec_start_003',
          type: 'recovery.started',
          createdAt: '2026-09-11T12:16:00.000Z',
          data: {
            caseId: 14,
            caseRef: 'CASE_DEV_DEMO_003',
            orderRef: 'ORD_DEV_DEMO_002',
            recoverableAmount: 45000,
            currency: 'INR',
            strategy: 'OFFER_INCENTIVE',
            autonomyTier: 'T2',
            status: 'awaiting_approval'
          }
        }
      }
    ];

    const seededDeliveries: SeedDeveloperDemoResult['deliveries'] = [];

    for (const item of deliveryPayloads) {
      const [existingDeliveries] = await conn.query<RowDataPacket[]>(
        `SELECT id FROM webhook_deliveries WHERE endpoint_id = ? AND event_type = ? LIMIT 1`,
        [endpointId, item.eventType]
      );

      let deliveryId: number;
      if (existingDeliveries.length > 0 && existingDeliveries[0]?.id) {
        deliveryId = Number(existingDeliveries[0].id);
        await conn.query(
          `UPDATE webhook_deliveries SET payload = ?, status = ?, response_status = ? WHERE id = ?`,
          [JSON.stringify(item.payload), item.status, item.responseStatus, deliveryId]
        );
      } else {
        const [insertDelivery] = await conn.query<ResultSetHeader>(
          `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, status, response_status) VALUES (?, ?, ?, ?, ?)`,
          [endpointId, item.eventType, JSON.stringify(item.payload), item.status, item.responseStatus]
        );
        deliveryId = insertDelivery.insertId;
      }

      seededDeliveries.push({
        id: deliveryId,
        eventType: item.eventType,
        status: item.status,
        responseStatus: item.responseStatus
      });
    }

    await conn.commit();

    return {
      merchantId,
      email: demoEmail,
      merchantName: demoMerchantName,
      role: demoRole,
      endpointId,
      endpointUrl: demoEndpointUrl,
      deliveries: seededDeliveries
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Direct CLI execution
if (process.argv[1]?.endsWith('seed-developer-demo.ts') || process.argv[1]?.endsWith('seed-developer-demo.js')) {
  seedDeveloperDemo()
    .then((res) => {
      console.log('\n============================================================');
      console.log('🌱 PayBridge Merchant Developer Demo Seeding');
      console.log('============================================================\n');
      console.log('✅ Merchant Developer Demo Seeded Successfully:');
      console.log(`   • Merchant ID   : ${res.merchantId}`);
      console.log(`   • Email         : ${res.email}`);
      console.log(`   • Password      : Developer123!`);
      console.log(`   • Merchant Name : ${res.merchantName}`);
      console.log(`   • Assigned Role : ${res.role}`);
      console.log(`   • Endpoint ID   : ${res.endpointId} (${res.endpointUrl})`);
      console.log('\n📋 Seeded Deliveries:');
      res.deliveries.forEach((d, idx) => {
        console.log(`   ${idx + 1}. [${d.status.padEnd(7)}] ${d.eventType} (ID: ${d.id}, HTTP ${d.responseStatus})`);
      });
      console.log('\n============================================================\n');
      return closePool();
    })
    .catch((err) => {
      console.error('❌ Failed to seed developer demo:', err);
      closePool().finally(() => process.exit(1));
    });
}
