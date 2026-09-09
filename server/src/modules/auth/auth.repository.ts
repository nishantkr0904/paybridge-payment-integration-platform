import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../../config/database.js';
import type { AuthUser, Role } from '../../types/auth.js';

type UserRow = RowDataPacket & {
  id: number;
  email: string;
  password_hash: string;
  merchant_name: string;
  roles: string | null;
};

export async function findUserByEmail(email: string): Promise<(AuthUser & { passwordHash: string }) | null> {
  const [rows] = await pool.query<UserRow[]>(
    `SELECT u.id, u.email, u.password_hash, u.merchant_name, GROUP_CONCAT(r.name) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.email = :email AND u.status = 'active'
     GROUP BY u.id`,
    { email }
  );

  const user = rows[0];
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    passwordHash: user.password_hash,
    merchantName: user.merchant_name,
    roles: user.roles ? user.roles.split(',') : []
  };
}

export async function findUserById(id: number): Promise<AuthUser | null> {
  const [rows] = await pool.query<UserRow[]>(
    `SELECT u.id, u.email, u.password_hash, u.merchant_name, GROUP_CONCAT(r.name) AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = :id AND u.status = 'active'
     GROUP BY u.id`,
    { id }
  );

  const user = rows[0];
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    merchantName: user.merchant_name,
    roles: user.roles ? user.roles.split(',') : []
  };
}

export async function createMerchantUser(input: {
  email: string;
  passwordHash: string;
  merchantName: string;
  role?: Role;
}): Promise<AuthUser> {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [result] = await connection.query<ResultSetHeader>(
      `INSERT INTO users (email, password_hash, merchant_name)
       VALUES (:email, :passwordHash, :merchantName)`,
      input
    );

    const roleName = input.role || 'merchant';
    await connection.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT :userId, id FROM roles WHERE name = :roleName`,
      { userId: result.insertId, roleName }
    );

    await connection.commit();

    return {
      id: result.insertId,
      email: input.email,
      merchantName: input.merchantName,
      roles: [roleName]
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function assignUserRole(userId: number, roleName: string): Promise<void> {
  await pool.query(
    `INSERT IGNORE INTO user_roles (user_id, role_id)
     SELECT :userId, id FROM roles WHERE name = :roleName`,
    { userId, roleName }
  );
}

export async function findUserRoles(userId: number): Promise<string[]> {
  const [rows] = await pool.query<(RowDataPacket & { name: string })[]>(
    `SELECT r.name
     FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = :userId`,
    { userId }
  );

  return rows.map((r) => r.name);
}

export async function findPermissionsByRole(roleName: string): Promise<string[]> {
  const [rows] = await pool.query<(RowDataPacket & { name: string })[]>(
    `SELECT p.name
     FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN roles r ON r.id = rp.role_id
     WHERE r.name = :roleName`,
    { roleName }
  );

  return rows.map((r) => r.name);
}

export async function storeRefreshToken(input: {
  userId: number;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES (:userId, :tokenHash, :expiresAt)`,
    input
  );
}

export async function findActiveRefreshToken(tokenHash: string): Promise<{ userId: number } | null> {
  const [rows] = await pool.query<(RowDataPacket & { user_id: number })[]>(
    `SELECT user_id
     FROM refresh_tokens
     WHERE token_hash = :tokenHash
       AND revoked_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    { tokenHash }
  );

  return rows[0] ? { userId: rows[0].user_id } : null;
}

export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE token_hash = :tokenHash`,
    { tokenHash }
  );
}
