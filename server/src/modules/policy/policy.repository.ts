import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import type { AutonomyTier, CreatePolicyInput, Policy } from './policy.types.js';

/* ------------------------------------------------------------------ */
/*  Row types & Mappers                                               */
/* ------------------------------------------------------------------ */

type PolicyRow = RowDataPacket & {
  id: number;
  merchant_id: number;
  autonomy_tier: AutonomyTier;
  max_retries: number;
  max_contacts_per_customer_per_week: number;
  daily_budget_minor_units: string | number;
  max_incentive_percent: string | number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
  is_active: number | boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
};

function toPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    autonomyTier: row.autonomy_tier,
    maxRetries: Number(row.max_retries),
    maxContactsPerCustomerPerWeek: Number(row.max_contacts_per_customer_per_week),
    dailyBudgetMinorUnits: Number(row.daily_budget_minor_units),
    maxIncentivePercent: Number(row.max_incentive_percent),
    quietHoursStart: row.quiet_hours_start,
    quietHoursEnd: row.quiet_hours_end,
    timezone: row.timezone,
    isActive: Boolean(row.is_active),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/* ------------------------------------------------------------------ */
/*  Repository Operations (Strictly Tenant-Scoped)                    */
/* ------------------------------------------------------------------ */

/**
 * Finds the currently active policy for a merchant.
 */
export async function findActivePolicyByMerchantId(merchantId: number): Promise<Policy | null> {
  const [rows] = await pool.query<PolicyRow[]>(
    `SELECT * FROM policies WHERE merchant_id = :merchantId AND is_active = TRUE ORDER BY version DESC LIMIT 1`,
    { merchantId }
  );

  return rows[0] ? toPolicy(rows[0]) : null;
}

/**
 * Finds a specific policy by internal ID, scoped strictly to the merchant.
 */
export async function findPolicyById(id: number, merchantId: number): Promise<Policy | null> {
  const [rows] = await pool.query<PolicyRow[]>(
    `SELECT * FROM policies WHERE id = :id AND merchant_id = :merchantId`,
    { id, merchantId }
  );

  return rows[0] ? toPolicy(rows[0]) : null;
}

/**
 * Finds a specific policy by version number, scoped strictly to the merchant.
 */
export async function findPolicyByVersion(version: number, merchantId: number): Promise<Policy | null> {
  const [rows] = await pool.query<PolicyRow[]>(
    `SELECT * FROM policies WHERE version = :version AND merchant_id = :merchantId`,
    { version, merchantId }
  );

  return rows[0] ? toPolicy(rows[0]) : null;
}

/**
 * Lists all policy versions for a merchant ordered by version descending.
 */
export async function findPoliciesByMerchantId(merchantId: number): Promise<Policy[]> {
  const [rows] = await pool.query<PolicyRow[]>(
    `SELECT * FROM policies WHERE merchant_id = :merchantId ORDER BY version DESC`,
    { merchantId }
  );

  return rows.map(toPolicy);
}

/**
 * Creates a new policy (or new version) for a merchant in an atomic transaction.
 * If isActive is true, atomically deactivates any existing active policies for this merchant.
 */
export async function createPolicy(merchantId: number, input: CreatePolicyInput): Promise<Policy> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Lock the parent user record to serialize operations for this merchant without index gap locks
    await conn.query(`SELECT id FROM users WHERE id = ? FOR UPDATE`, [merchantId]);

    // Determine the next sequential version number for this merchant
    const [versionRows] = await conn.query<(RowDataPacket & { next_version: number })[]>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM policies WHERE merchant_id = ?`,
      [merchantId]
    );
    const nextVersion = versionRows[0]?.next_version ?? 1;

    const isActive = input.isActive !== undefined ? input.isActive : true;

    // If this policy is active, deactivate existing active policies for the merchant
    if (isActive) {
      await conn.query(
        `UPDATE policies SET is_active = FALSE WHERE merchant_id = ? AND is_active = TRUE`,
        [merchantId]
      );
    }

    const autonomyTier = input.autonomyTier || 'T1';
    const maxRetries = input.maxRetries !== undefined ? input.maxRetries : 3;
    const maxContacts = input.maxContactsPerCustomerPerWeek !== undefined ? input.maxContactsPerCustomerPerWeek : 3;
    const dailyBudget = input.dailyBudgetMinorUnits !== undefined ? input.dailyBudgetMinorUnits : 0;
    const maxIncentive = input.maxIncentivePercent !== undefined ? input.maxIncentivePercent : 0.0;
    const quietHoursStart = input.quietHoursStart ?? null;
    const quietHoursEnd = input.quietHoursEnd ?? null;
    const timezone = input.timezone || 'UTC';

    const [insertResult] = await conn.query<ResultSetHeader>(
      `INSERT INTO policies (
        merchant_id, autonomy_tier, max_retries, max_contacts_per_customer_per_week,
        daily_budget_minor_units, max_incentive_percent, quiet_hours_start, quiet_hours_end,
        timezone, is_active, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchantId,
        autonomyTier,
        maxRetries,
        maxContacts,
        dailyBudget,
        maxIncentive,
        quietHoursStart,
        quietHoursEnd,
        timezone,
        isActive,
        nextVersion
      ]
    );

    const [rows] = await conn.query<PolicyRow[]>(
      `SELECT * FROM policies WHERE id = ? AND merchant_id = ?`,
      [insertResult.insertId, merchantId]
    );

    await conn.commit();

    if (!rows[0]) {
      throw new Error('Failed to retrieve created policy');
    }

    return toPolicy(rows[0]);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Activates a specific policy version for a merchant.
 * Atomically deactivates any other active policies for this merchant.
 */
export async function activatePolicy(id: number, merchantId: number): Promise<Policy | null> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Lock the parent user record to serialize operations for this merchant
    await conn.query(`SELECT id FROM users WHERE id = ? FOR UPDATE`, [merchantId]);

    const [targetRows] = await conn.query<PolicyRow[]>(
      `SELECT * FROM policies WHERE id = ? AND merchant_id = ?`,
      [id, merchantId]
    );

    if (!targetRows[0]) {
      await conn.rollback();
      return null;
    }

    // Deactivate existing active policies for this merchant
    await conn.query(
      `UPDATE policies SET is_active = FALSE WHERE merchant_id = ? AND is_active = TRUE`,
      [merchantId]
    );

    // Activate the target policy
    await conn.query(
      `UPDATE policies SET is_active = TRUE WHERE id = ? AND merchant_id = ?`,
      [id, merchantId]
    );

    const [updatedRows] = await conn.query<PolicyRow[]>(
      `SELECT * FROM policies WHERE id = ? AND merchant_id = ?`,
      [id, merchantId]
    );

    await conn.commit();

    return updatedRows[0] ? toPolicy(updatedRows[0]) : null;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Deactivates a specific policy version for a merchant.
 */
export async function deactivatePolicy(id: number, merchantId: number): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE policies SET is_active = FALSE WHERE id = :id AND merchant_id = :merchantId`,
    { id, merchantId }
  );

  return result.affectedRows > 0;
}
