import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request, Response } from 'express';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  hasPermission,
  hasRole,
  requirePermission,
  requireAnyPermission,
  requireRole
} from '../../middleware/authorize.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { HttpError } from '../../utils/http-error.js';

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
  });
});

