import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request, Response } from 'express';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RowDataPacket } from 'mysql2/promise';
import {
  hasPermission,
  hasRole,
  requirePermission,
  requireAnyPermission,
  requireRole
} from '../../middleware/authorize.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { HttpError } from '../../utils/http-error.js';
import { ROLE_PERMISSIONS, type Permission, type Role } from '../../types/auth.js';

describe('RBAC Authorization Primitives (TASK-RBAC-PHASE-A)', () => {
  describe('hasPermission Helper', () => {
    it('grants full merchant_admin permissions to legacy merchant role', () => {
      const legacyRoles = ['merchant'];

      // Merchant admin permissions
      expect(hasPermission(legacyRoles, 'payment:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'payment:create')).toBe(true);
      expect(hasPermission(legacyRoles, 'recovery:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'recovery:approve')).toBe(true);
      expect(hasPermission(legacyRoles, 'recovery:reject')).toBe(true);
      expect(hasPermission(legacyRoles, 'recovery:close')).toBe(true);
      expect(hasPermission(legacyRoles, 'policy:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'policy:evaluate')).toBe(true);
      expect(hasPermission(legacyRoles, 'policy:update')).toBe(true);
      expect(hasPermission(legacyRoles, 'webhook:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'webhook:manage')).toBe(true);
      expect(hasPermission(legacyRoles, 'webhook:secret:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'webhook:retry')).toBe(true);
      expect(hasPermission(legacyRoles, 'audit:export')).toBe(true);
      expect(hasPermission(legacyRoles, 'explainability:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'ledger:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'analytics:read')).toBe(true);
      expect(hasPermission(legacyRoles, 'ops:shed:execute')).toBe(true);

      // Platform-only permissions are denied to legacy merchant
      expect(hasPermission(legacyRoles, 'ops:trace:read')).toBe(false);
      expect(hasPermission(legacyRoles, 'ops:trace:replay')).toBe(false);
    });

    it('enforces least privilege for merchant_operator', () => {
      const opRoles = ['merchant_operator'];

      // Allowed
      expect(hasPermission(opRoles, 'payment:read')).toBe(true);
      expect(hasPermission(opRoles, 'payment:create')).toBe(true);
      expect(hasPermission(opRoles, 'recovery:read')).toBe(true);
      expect(hasPermission(opRoles, 'recovery:approve')).toBe(true);
      expect(hasPermission(opRoles, 'recovery:reject')).toBe(true);
      expect(hasPermission(opRoles, 'recovery:close')).toBe(true);
      expect(hasPermission(opRoles, 'policy:read')).toBe(true);
      expect(hasPermission(opRoles, 'policy:evaluate')).toBe(true);
      expect(hasPermission(opRoles, 'explainability:read')).toBe(true);
      expect(hasPermission(opRoles, 'analytics:read')).toBe(true);
      expect(hasPermission(opRoles, 'ops:shed:execute')).toBe(true);

      // Forbidden
      expect(hasPermission(opRoles, 'policy:update')).toBe(false);
      expect(hasPermission(opRoles, 'webhook:manage')).toBe(false);
      expect(hasPermission(opRoles, 'webhook:secret:read')).toBe(false);
      expect(hasPermission(opRoles, 'audit:export')).toBe(false);
      expect(hasPermission(opRoles, 'ledger:read')).toBe(false);
      expect(hasPermission(opRoles, 'ops:trace:read')).toBe(false);
    });

    it('enforces least privilege for merchant_developer', () => {
      const devRoles = ['merchant_developer'];

      // Allowed
      expect(hasPermission(devRoles, 'payment:read')).toBe(true);
      expect(hasPermission(devRoles, 'payment:create')).toBe(true);
      expect(hasPermission(devRoles, 'recovery:read')).toBe(true);
      expect(hasPermission(devRoles, 'webhook:read')).toBe(true);
      expect(hasPermission(devRoles, 'webhook:manage')).toBe(true);
      expect(hasPermission(devRoles, 'webhook:secret:read')).toBe(true);
      expect(hasPermission(devRoles, 'webhook:retry')).toBe(true);

      // Forbidden
      expect(hasPermission(devRoles, 'recovery:approve')).toBe(false);
      expect(hasPermission(devRoles, 'policy:update')).toBe(false);
      expect(hasPermission(devRoles, 'audit:export')).toBe(false);
      expect(hasPermission(devRoles, 'ledger:read')).toBe(false);
      expect(hasPermission(devRoles, 'ops:trace:read')).toBe(false);
    });

    it('enforces least privilege for finance_analyst', () => {
      const finRoles = ['finance_analyst'];

      // Allowed
      expect(hasPermission(finRoles, 'payment:read')).toBe(true);
      expect(hasPermission(finRoles, 'recovery:read')).toBe(true);
      expect(hasPermission(finRoles, 'policy:read')).toBe(true);
      expect(hasPermission(finRoles, 'ledger:read')).toBe(true);
      expect(hasPermission(finRoles, 'analytics:read')).toBe(true);

      // Forbidden
      expect(hasPermission(finRoles, 'payment:create')).toBe(false);
      expect(hasPermission(finRoles, 'recovery:approve')).toBe(false);
      expect(hasPermission(finRoles, 'policy:update')).toBe(false);
      expect(hasPermission(finRoles, 'webhook:manage')).toBe(false);
      expect(hasPermission(finRoles, 'audit:export')).toBe(false);
    });

    it('enforces least privilege for risk_compliance_reviewer', () => {
      const riskRoles = ['risk_compliance_reviewer'];

      // Allowed
      expect(hasPermission(riskRoles, 'payment:read')).toBe(true);
      expect(hasPermission(riskRoles, 'recovery:read')).toBe(true);
      expect(hasPermission(riskRoles, 'policy:read')).toBe(true);
      expect(hasPermission(riskRoles, 'explainability:read')).toBe(true);
      expect(hasPermission(riskRoles, 'audit:export')).toBe(true);

      // Forbidden
      expect(hasPermission(riskRoles, 'payment:create')).toBe(false);
      expect(hasPermission(riskRoles, 'recovery:approve')).toBe(false);
      expect(hasPermission(riskRoles, 'policy:update')).toBe(false);
      expect(hasPermission(riskRoles, 'webhook:manage')).toBe(false);
      expect(hasPermission(riskRoles, 'ledger:read')).toBe(false);
    });

    it('enforces platform operations isolation for platform_operator', () => {
      const opsRoles = ['platform_operator'];

      // Allowed
      expect(hasPermission(opsRoles, 'ops:trace:read')).toBe(true);
      expect(hasPermission(opsRoles, 'ops:trace:replay')).toBe(true);
      expect(hasPermission(opsRoles, 'ops:shed:execute')).toBe(true);

      // Forbidden: platform operator cannot mutate merchant business data
      expect(hasPermission(opsRoles, 'payment:create')).toBe(false);
      expect(hasPermission(opsRoles, 'recovery:approve')).toBe(false);
      expect(hasPermission(opsRoles, 'policy:update')).toBe(false);
      expect(hasPermission(opsRoles, 'webhook:manage')).toBe(false);
    });

    it('denies access when caller has empty roles or unknown roles', () => {
      expect(hasPermission([], 'payment:read')).toBe(false);
      expect(hasPermission(['unknown_role'], 'payment:read')).toBe(false);
    });

    it('safely handles null or undefined roles without throwing', () => {
      expect(hasPermission(undefined, 'payment:read')).toBe(false);
      expect(hasPermission(null, 'payment:read')).toBe(false);
    });
  });

  describe('hasRole Helper', () => {
    it('returns true on exact role match', () => {
      expect(hasRole(['merchant_admin'], 'merchant_admin')).toBe(true);
      expect(hasRole(['platform_operator'], 'platform_operator')).toBe(true);
    });

    it('supports backward compatibility alias between merchant and merchant_admin', () => {
      // Legacy 'merchant' matches 'merchant_admin'
      expect(hasRole(['merchant'], 'merchant_admin')).toBe(true);
      // 'merchant_admin' matches 'merchant'
      expect(hasRole(['merchant_admin'], 'merchant')).toBe(true);
    });

    it('handles arrays of required roles', () => {
      expect(hasRole(['merchant_operator'], ['merchant_admin', 'merchant_operator'])).toBe(true);
      expect(hasRole(['finance_analyst'], ['merchant_admin', 'merchant_operator'])).toBe(false);
    });

    it('safely handles null or undefined roles without throwing', () => {
      expect(hasRole(undefined, 'merchant')).toBe(false);
      expect(hasRole(null, 'merchant')).toBe(false);
      expect(hasRole(undefined, ['merchant_admin', 'merchant_operator'])).toBe(false);
      expect(hasRole(null, ['merchant_admin', 'merchant_operator'])).toBe(false);
    });
  });

  describe('requirePermission Middleware', () => {
    it('returns 401 AUTH_TOKEN_MISSING when req.user is absent', () => {
      const middleware = requirePermission('payment:read');
      const req = {} as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as HttpError;
      expect(error).toBeInstanceOf(HttpError);
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('AUTH_TOKEN_MISSING');
      expect(error.message).toBe('Authentication required.');
    });

    it('calls next() without error when user has permission', () => {
      const middleware = requirePermission('recovery:approve');
      const req = {
        user: { id: 1, email: 'op@example.com', merchantName: 'Test', roles: ['merchant_operator'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('allows legacy merchant role for merchant_admin permission (backward compatibility)', () => {
      const middleware = requirePermission('policy:update');
      const req = {
        user: { id: 1, email: 'legacy@example.com', merchantName: 'Test', roles: ['merchant'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('returns 403 AUTH_FORBIDDEN when user lacks required permission', () => {
      const middleware = requirePermission('policy:update');
      const req = {
        user: { id: 2, email: 'op@example.com', merchantName: 'Test', roles: ['merchant_operator'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as HttpError;
      expect(error).toBeInstanceOf(HttpError);
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('AUTH_FORBIDDEN');
      expect(error.message).toContain('Missing required permission');
      expect(error.message).toContain('policy:update');
    });

    it('requires ALL permissions when an array is passed', () => {
      const middleware = requirePermission(['payment:read', 'policy:update']);
      const req = {
        user: { id: 3, email: 'op@example.com', merchantName: 'Test', roles: ['merchant_operator'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as HttpError;
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('AUTH_FORBIDDEN');
      expect(error.message).toContain('policy:update');
    });

    it('throws at creation time when passed an empty permission array, preventing request authorization', () => {
      expect(() => requirePermission([])).toThrow('requirePermission requires at least one permission.');
    });
  });

  describe('requireAnyPermission Middleware', () => {
    it('returns 401 AUTH_TOKEN_MISSING when req.user is absent', () => {
      const middleware = requireAnyPermission(['payment:read', 'ledger:read']);
      const req = {} as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as HttpError;
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('calls next() when at least one permission matches', () => {
      const middleware = requireAnyPermission(['policy:update', 'recovery:approve']);
      const req = {
        user: { id: 4, email: 'op@example.com', merchantName: 'Test', roles: ['merchant_operator'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('returns 403 AUTH_FORBIDDEN when none of the permissions match', () => {
      const middleware = requireAnyPermission(['policy:update', 'ops:trace:read']);
      const req = {
        user: { id: 5, email: 'op@example.com', merchantName: 'Test', roles: ['merchant_operator'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as HttpError;
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('AUTH_FORBIDDEN');
    });

    it('throws at creation time when passed an empty permission array, preventing request authorization', () => {
      expect(() => requireAnyPermission([])).toThrow('requireAnyPermission requires at least one permission.');
    });
  });

  describe('requireRole Middleware', () => {
    it('returns 401 AUTH_TOKEN_MISSING when req.user is absent', () => {
      const middleware = requireRole('merchant_admin');
      const req = {} as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as HttpError;
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('AUTH_TOKEN_MISSING');
    });

    it('allows caller with matching role', () => {
      const middleware = requireRole('merchant_developer');
      const req = {
        user: { id: 6, email: 'dev@example.com', merchantName: 'Test', roles: ['merchant_developer'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('allows legacy merchant role when merchant_admin is required', () => {
      const middleware = requireRole('merchant_admin');
      const req = {
        user: { id: 7, email: 'legacy@example.com', merchantName: 'Test', roles: ['merchant'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('allows caller with any of the allowed roles in array', () => {
      const middleware = requireRole(['merchant_admin', 'merchant_operator']);
      const req = {
        user: { id: 8, email: 'op@example.com', merchantName: 'Test', roles: ['merchant_operator'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    it('returns 403 AUTH_FORBIDDEN when caller lacks all allowed roles', () => {
      const middleware = requireRole(['merchant_admin', 'merchant_operator']);
      const req = {
        user: { id: 9, email: 'dev@example.com', merchantName: 'Test', roles: ['merchant_developer'] }
      } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as HttpError;
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('AUTH_FORBIDDEN');
      expect(error.message).toContain('Requires one of [merchant_admin, merchant_operator] roles.');
    });
  });

  describe('Express Pipeline & Error Handler Integration', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());

      // Mock auth injector to simulate authenticate middleware
      app.use((req, _res, next) => {
        const roleHeader = req.header('x-test-roles');
        if (roleHeader !== undefined) {
          req.user = {
            id: 100,
            email: 'pipeline@example.com',
            merchantName: 'Pipeline Merchant',
            roles: roleHeader ? roleHeader.split(',') : []
          };
        }
        next();
      });

      // Protected route requiring permission
      app.post('/test/policy-update', requirePermission('policy:update'), (_req, res) => {
        res.json({ success: true, action: 'policy:update' });
      });

      // Protected route requiring role
      app.get('/test/ops-only', requireRole('platform_operator'), (_req, res) => {
        res.json({ success: true, action: 'ops-only' });
      });

      app.use(errorHandler);

      server = app.listen(0);
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('returns 401 AUTH_TOKEN_MISSING when unauthenticated', async () => {
      const res = await fetch(`${baseUrl}/test/policy-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'AUTH_TOKEN_MISSING',
          message: 'Authentication required.'
        }
      });
    });

    it('returns 403 AUTH_FORBIDDEN when caller lacks permission', async () => {
      const res = await fetch(`${baseUrl}/test/policy-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-roles': 'merchant_operator'
        }
      });

      expect(res.status).toBe(403);
      const data = await res.json() as { error: { code: string; message: string } };
      expect(data.error.code).toBe('AUTH_FORBIDDEN');
      expect(data.error.message).toContain('Missing required permission(s): policy:update');
    });

    it('returns 200 OK when caller has legacy merchant role', async () => {
      const res = await fetch(`${baseUrl}/test/policy-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-test-roles': 'merchant'
        }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        success: true,
        action: 'policy:update'
      });
    });

    it('returns 403 AUTH_FORBIDDEN when caller lacks role', async () => {
      const res = await fetch(`${baseUrl}/test/ops-only`, {
        headers: {
          'x-test-roles': 'merchant_admin'
        }
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'AUTH_FORBIDDEN',
          message: 'Forbidden: Requires one of [platform_operator] roles.'
        }
      });
    });
  });

  describe('Database Schema & Repository Role Resolution', () => {
    let testMerchantId: number;
    let testOperatorId: number;

    beforeAll(async () => {
      const { runMigrations, getDefaultMigrationsDir } = await import('../../infrastructure/migrator.js');
      await runMigrations({ migrationsDir: getDefaultMigrationsDir() });
    });

    afterAll(async () => {
      const { pool } = await import('../../config/database.js');
      const conn = await pool.getConnection();
      try {
        if (testMerchantId) {
          await conn.query('DELETE FROM users WHERE id = ?', [testMerchantId]);
        }
        if (testOperatorId) {
          await conn.query('DELETE FROM users WHERE id = ?', [testOperatorId]);
        }
      } finally {
        conn.release();
      }

      const { runMigrations, getDefaultMigrationsDir } = await import('../../infrastructure/migrator.js');
      await runMigrations({ migrationsDir: getDefaultMigrationsDir() });
    });

    describe('Database & Runtime RBAC Parity Verification (ARCH-1)', () => {
      it('verifies 100% bidirectional role parity between DB roles table and runtime ROLE_PERMISSIONS', async () => {
        const { pool } = await import('../../config/database.js');
        const conn = await pool.getConnection();
        try {
          const [roleRows] = await conn.query<RowDataPacket[]>('SELECT name FROM roles ORDER BY name ASC');
          const dbRoleNames = roleRows.map((r) => r.name as string);
          const runtimeRoleNames = Object.keys(ROLE_PERMISSIONS);

          // The test must fail if:
          // a. a DB role exists that is missing from ROLE_PERMISSIONS
          const missingInRuntime = dbRoleNames.filter((r) => !(r in ROLE_PERMISSIONS));
          expect(missingInRuntime).toEqual([]);

          // b. a ROLE_PERMISSIONS role is missing from the DB
          const missingInDb = runtimeRoleNames.filter((r) => !dbRoleNames.includes(r));
          expect(missingInDb).toEqual([]);

          // Bidirectional set and count equality
          expect(new Set(dbRoleNames)).toEqual(new Set(runtimeRoleNames));
          expect(dbRoleNames).toHaveLength(runtimeRoleNames.length);
        } finally {
          conn.release();
        }
      });

      it('verifies 100% bidirectional permission parity between DB permissions table and canonical runtime permissions', async () => {
        const { pool } = await import('../../config/database.js');
        const conn = await pool.getConnection();
        try {
          const [permRows] = await conn.query<RowDataPacket[]>('SELECT name FROM permissions ORDER BY name ASC');
          const dbPermissionNames = permRows.map((r) => r.name as string);

          // Canonical runtime permission definition derived from ROLE_PERMISSIONS without duplicate hand-written lists
          const canonicalRuntimePermissions = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];

          // The test must fail for missing or unexpected permissions:
          const missingInRuntime = dbPermissionNames.filter(
            (p) => !canonicalRuntimePermissions.includes(p as Permission)
          );
          expect(missingInRuntime).toEqual([]);

          const missingInDb = canonicalRuntimePermissions.filter(
            (p) => !dbPermissionNames.includes(p)
          );
          expect(missingInDb).toEqual([]);

          // Bidirectional set and count equality
          expect(new Set(dbPermissionNames)).toEqual(new Set(canonicalRuntimePermissions));
          expect(dbPermissionNames).toHaveLength(canonicalRuntimePermissions.length);
        } finally {
          conn.release();
        }
      });

      it('verifies 100% bidirectional role-permission mapping parity across all 7 roles', async () => {
        const { findPermissionsByRole } = await import('../../modules/auth/auth.repository.js');

        const allRoles: Role[] = [
          'merchant',
          'merchant_admin',
          'merchant_operator',
          'merchant_developer',
          'finance_analyst',
          'risk_compliance_reviewer',
          'platform_operator'
        ];

        // Verify allRoles strictly covers all 7 keys in ROLE_PERMISSIONS
        expect(new Set(allRoles)).toEqual(new Set(Object.keys(ROLE_PERMISSIONS)));
        expect(allRoles).toHaveLength(Object.keys(ROLE_PERMISSIONS).length);

        for (const role of allRoles) {
          const dbPermissions = await findPermissionsByRole(role);
          const expectedPermissions = ROLE_PERMISSIONS[role];

          // Verify exact counts match
          expect(dbPermissions.length).toBe(expectedPermissions.length);

          // Verify identical membership bidirectionally
          expect(new Set(dbPermissions)).toEqual(new Set(expectedPermissions));

          // Verify no unexpected or missing permissions for this role
          const extraInDb = dbPermissions.filter(
            (p) => !expectedPermissions.includes(p as Permission)
          );
          expect(extraInDb).toEqual([]);

          const missingInDb = expectedPermissions.filter(
            (p) => !dbPermissions.includes(p)
          );
          expect(missingInDb).toEqual([]);
        }
      });
    });

    it('creates merchant user with default legacy merchant role', async () => {
      const { createMerchantUser, findUserById } = await import('../../modules/auth/auth.repository.js');
      const email = `auth_test_default_${Date.now()}@example.com`;

      const user = await createMerchantUser({
        email,
        passwordHash: 'hashed_pw',
        merchantName: 'Default Merchant'
      });

      testMerchantId = user.id;
      expect(user.roles).toEqual(['merchant']);

      const found = await findUserById(user.id);
      expect(found).not.toBeNull();
      expect(found?.roles).toEqual(['merchant']);
    });

    it('creates user with explicit role and resolves multiple roles via repository', async () => {
      const { createMerchantUser, assignUserRole, findUserRoles, findPermissionsByRole } = await import(
        '../../modules/auth/auth.repository.js'
      );
      const email = `auth_test_op_${Date.now()}@example.com`;

      const user = await createMerchantUser({
        email,
        passwordHash: 'hashed_pw',
        merchantName: 'Op Merchant',
        role: 'merchant_operator'
      });

      testOperatorId = user.id;
      expect(user.roles).toEqual(['merchant_operator']);

      const initialRoles = await findUserRoles(user.id);
      expect(initialRoles).toEqual(['merchant_operator']);

      // Assign second role
      await assignUserRole(user.id, 'finance_analyst');
      const updatedRoles = await findUserRoles(user.id);
      expect(updatedRoles).toContain('merchant_operator');
      expect(updatedRoles).toContain('finance_analyst');

      // Verify database permissions seeded for merchant_operator
      const opPermissions = await findPermissionsByRole('merchant_operator');
      expect(opPermissions).toContain('recovery:approve');
      expect(opPermissions).toContain('analytics:read');
      expect(opPermissions).not.toContain('policy:update');

      // Verify database permissions seeded for platform_operator
      const platformPermissions = await findPermissionsByRole('platform_operator');
      expect(platformPermissions).toEqual(
        expect.arrayContaining(['ops:trace:read', 'ops:trace:replay', 'ops:shed:execute'])
      );
      expect(platformPermissions).not.toContain('payment:create');
    });

    it('fails explicitly with HttpError (ROLE_NOT_FOUND) when createMerchantUser is called with nonexistent role and rolls back user creation (P1-2)', async () => {
      const { createMerchantUser, findUserByEmail } = await import(
        '../../modules/auth/auth.repository.js'
      );
      const email = `auth_test_nonexistent_role_${Date.now()}@example.com`;

      await expect(
        createMerchantUser({
          email,
          passwordHash: 'hashed_pw',
          merchantName: 'Invalid Role Merchant',
          role: 'nonexistent_role'
        })
      ).rejects.toThrow(HttpError);

      await expect(
        createMerchantUser({
          email,
          passwordHash: 'hashed_pw',
          merchantName: 'Invalid Role Merchant',
          role: 'nonexistent_role'
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'ROLE_NOT_FOUND'
      });

      // Assert user was NOT created in database (rolled back)
      const found = await findUserByEmail(email);
      expect(found).toBeNull();
    });

    it('fails explicitly with HttpError (ROLE_NOT_FOUND) when assignUserRole is called with nonexistent role (P1-2)', async () => {
      const { createMerchantUser, assignUserRole, findUserRoles } = await import(
        '../../modules/auth/auth.repository.js'
      );
      const email = `auth_test_assign_invalid_${Date.now()}@example.com`;
      const user = await createMerchantUser({
        email,
        passwordHash: 'hashed_pw',
        merchantName: 'Assign Test Merchant',
        role: 'merchant'
      });

      try {
        await expect(
          assignUserRole(user.id, 'completely_bogus_role')
        ).rejects.toThrow(HttpError);

        await expect(
          assignUserRole(user.id, 'completely_bogus_role')
        ).rejects.toMatchObject({
          statusCode: 404,
          code: 'ROLE_NOT_FOUND'
        });

        // Assert user roles remain unchanged
        const roles = await findUserRoles(user.id);
        expect(roles).toEqual(['merchant']);
      } finally {
        const { pool } = await import('../../config/database.js');
        await pool.query('DELETE FROM users WHERE id = ?', [user.id]);
      }
    });

    it('preserves duplicate-assignment idempotency and distinguishes already-assigned role from nonexistent role (P1-2)', async () => {
      const { createMerchantUser, assignUserRole, findUserRoles } = await import(
        '../../modules/auth/auth.repository.js'
      );
      const email = `auth_test_dup_role_${Date.now()}@example.com`;
      const user = await createMerchantUser({
        email,
        passwordHash: 'hashed_pw',
        merchantName: 'Dup Role Merchant',
        role: 'merchant_operator'
      });

      try {
        // First assignment of finance_analyst
        await assignUserRole(user.id, 'finance_analyst');
        let roles = await findUserRoles(user.id);
        expect(roles).toContain('merchant_operator');
        expect(roles).toContain('finance_analyst');

        // Duplicate assignment of finance_analyst should NOT throw (preserves duplicate-assignment behavior)
        await expect(assignUserRole(user.id, 'finance_analyst')).resolves.not.toThrow();

        // Roles should still have each role once
        roles = await findUserRoles(user.id);
        expect(roles.filter((r) => r === 'finance_analyst')).toHaveLength(1);
      } finally {
        const { pool } = await import('../../config/database.js');
        await pool.query('DELETE FROM users WHERE id = ?', [user.id]);
      }
    });

    it('safely reassigns user_roles to fallback merchant role when rolling back migration 007 and allows clean reapplication (P1-1)', async () => {
      const {
        runMigrations,
        rollbackMigrations,
        getMigrationStatus,
        getDefaultMigrationsDir
      } = await import('../../infrastructure/migrator.js');
      const {
        createMerchantUser,
        assignUserRole,
        findUserRoles,
        findPermissionsByRole
      } = await import('../../modules/auth/auth.repository.js');
      const { pool } = await import('../../config/database.js');

      const migrationsDir = getDefaultMigrationsDir();

      // Ensure all migrations up to 007 are applied
      await runMigrations({ migrationsDir });

      // Create test users with various role configurations:
      // 1. User with only a new RBAC role ('merchant_operator')
      const userOnlyOp = await createMerchantUser({
        email: `rollback_test_op_${Date.now()}@example.com`,
        passwordHash: 'hash1',
        merchantName: 'Rollback Op Merchant',
        role: 'merchant_operator'
      });

      // 2. User with legacy 'merchant' AND a new RBAC role ('merchant_developer')
      const userMixed = await createMerchantUser({
        email: `rollback_test_mixed_${Date.now()}@example.com`,
        passwordHash: 'hash2',
        merchantName: 'Rollback Mixed Merchant',
        role: 'merchant'
      });
      await assignUserRole(userMixed.id, 'merchant_developer');

      // 3. User with multiple new RBAC roles ('finance_analyst' and 'risk_compliance_reviewer')
      const userMulti = await createMerchantUser({
        email: `rollback_test_multi_${Date.now()}@example.com`,
        passwordHash: 'hash3',
        merchantName: 'Rollback Multi Merchant',
        role: 'finance_analyst'
      });
      await assignUserRole(userMulti.id, 'risk_compliance_reviewer');

      const conn = await pool.getConnection();
      try {
        // Verify initial roles before rollback
        expect(await findUserRoles(userOnlyOp.id)).toEqual(['merchant_operator']);
        expect(await findUserRoles(userMixed.id)).toEqual(
          expect.arrayContaining(['merchant', 'merchant_developer'])
        );
        expect(await findUserRoles(userMulti.id)).toEqual(
          expect.arrayContaining(['finance_analyst', 'risk_compliance_reviewer'])
        );

        // Execute rollback of migration 007 (to version 6)
        const rollbackResult = await rollbackMigrations({ migrationsDir, to: 6 });
        expect(rollbackResult.some((r) => r.version === 7)).toBe(true);

        // Verify status shows migration 007 as PENDING
        const statusAfterRollback = await getMigrationStatus({ migrationsDir });
        const mig7Status = statusAfterRollback.migrations.find((m) => m.version === 7);
        expect(mig7Status?.status).toBe('PENDING');

        // Verify permissions and role_permissions tables are dropped
        const [tables] = await conn.query<RowDataPacket[]>(`
          SELECT TABLE_NAME
          FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN ('permissions', 'role_permissions')
        `);
        expect(tables.length).toBe(0);

        // Verify the 6 new roles were removed from roles table
        const [roles] = await conn.query<RowDataPacket[]>(`
          SELECT name FROM roles WHERE name IN (
            'merchant_admin', 'merchant_operator', 'merchant_developer',
            'finance_analyst', 'risk_compliance_reviewer', 'platform_operator'
          )
        `);
        expect(roles.length).toBe(0);

        // Verify the legacy 'merchant' role is still present
        const [legacyRole] = await conn.query<RowDataPacket[]>(`
          SELECT name FROM roles WHERE name = 'merchant'
        `);
        expect(legacyRole.length).toBe(1);

        // CRITICAL P1-1 ASSERTION:
        // Verify user_roles were preserved by reassigning to fallback 'merchant' role
        // No user should be left with empty roles!
        const opRolesAfterRollback = await findUserRoles(userOnlyOp.id);
        expect(opRolesAfterRollback).toEqual(['merchant']);

        const mixedRolesAfterRollback = await findUserRoles(userMixed.id);
        expect(mixedRolesAfterRollback).toEqual(['merchant']);

        const multiRolesAfterRollback = await findUserRoles(userMulti.id);
        expect(multiRolesAfterRollback).toEqual(['merchant']);

        // Reapply migration 007
        const reapplyResult = await runMigrations({ migrationsDir });
        expect(reapplyResult.some((r) => r.version === 7)).toBe(true);

        // Verify status after reapplication is clean
        const finalStatus = await getMigrationStatus({ migrationsDir });
        expect(finalStatus.pendingCount).toBe(0);
        expect(finalStatus.hasMismatch).toBe(false);

        // Verify tables and seeded permissions exist again
        const reapplyOpPermissions = await findPermissionsByRole('merchant_operator');
        expect(reapplyOpPermissions).toContain('recovery:approve');

        // Verify users still retain their valid fallback role and can have new roles assigned again
        expect(await findUserRoles(userOnlyOp.id)).toEqual(['merchant']);
        await assignUserRole(userOnlyOp.id, 'merchant_operator');
        expect(await findUserRoles(userOnlyOp.id)).toEqual(
          expect.arrayContaining(['merchant', 'merchant_operator'])
        );
      } finally {
        // Ensure migration 007 is reapplied even if an assertion failed
        await runMigrations({ migrationsDir });

        // Cleanup test users
        try {
          await conn.query('DELETE FROM users WHERE id IN (?, ?, ?)', [
            userOnlyOp.id,
            userMixed.id,
            userMulti.id
          ]);
        } catch {
          // ignore cleanup error
        }
        conn.release();
      }
    });
  });
});

