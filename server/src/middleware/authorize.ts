import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../utils/http-error.js';
import { ROLE_PERMISSIONS, type Permission, type Role } from '../types/auth.js';

/**
 * Checks whether a given set of user roles grants a specific permission.
 * Supports legacy 'merchant' role mapped to full merchant_admin permissions.
 */
export function hasPermission(
  userRoles: readonly string[] | string[] | undefined | null,
  permission: Permission
): boolean {
  if (!userRoles || !Array.isArray(userRoles)) {
    return false;
  }
  return userRoles.some((role) => {
    const roleKey = role as Role;
    const permissions = ROLE_PERMISSIONS[roleKey];
    return permissions ? permissions.includes(permission) : false;
  });
}

/**
 * Checks whether a given set of user roles satisfies the required role.
 * Considers 'merchant' and 'merchant_admin' interoperable for backward compatibility.
 */
export function hasRole(
  userRoles: readonly string[] | string[] | undefined | null,
  requiredRole: Role | Role[] | string | string[]
): boolean {
  if (!userRoles || !Array.isArray(userRoles)) {
    return false;
  }
  const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
  return allowed.some((targetRole) => {
    if (userRoles.includes(targetRole)) {
      return true;
    }
    // Backward compatibility: legacy 'merchant' satisfies 'merchant_admin' and vice-versa
    if (targetRole === 'merchant_admin' && userRoles.includes('merchant')) {
      return true;
    }
    if (targetRole === 'merchant' && userRoles.includes('merchant_admin')) {
      return true;
    }
    return false;
  });
}

/**
 * Middleware requiring the authenticated caller to have the specified permission(s).
 * - If req.user is missing -> 401 AUTH_TOKEN_MISSING
 * - If permission is missing -> 403 AUTH_FORBIDDEN
 */
export function requirePermission(permission: Permission | Permission[]): RequestHandler {
  const requiredList = Array.isArray(permission) ? permission : [permission];
  if (requiredList.length === 0) {
    throw new Error('requirePermission requires at least one permission.');
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, 'AUTH_TOKEN_MISSING', 'Authentication required.'));
      return;
    }

    const userRoles = req.user.roles || [];
    const missing = requiredList.filter((p) => !hasPermission(userRoles, p));

    if (missing.length > 0) {
      next(
        new HttpError(
          403,
          'AUTH_FORBIDDEN',
          `Forbidden: Missing required permission(s): ${missing.join(', ')}.`
        )
      );
      return;
    }

    next();
  };
}

/**
 * Middleware requiring the authenticated caller to have at least one of the specified permissions.
 * - If req.user is missing -> 401 AUTH_TOKEN_MISSING
 * - If caller has none of the permissions -> 403 AUTH_FORBIDDEN
 */
export function requireAnyPermission(permissions: Permission[]): RequestHandler {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new Error('requireAnyPermission requires at least one permission.');
  }

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, 'AUTH_TOKEN_MISSING', 'Authentication required.'));
      return;
    }

    const userRoles = req.user.roles || [];
    const satisfied = permissions.some((p) => hasPermission(userRoles, p));

    if (!satisfied) {
      next(
        new HttpError(
          403,
          'AUTH_FORBIDDEN',
          `Forbidden: Requires at least one of permissions: ${permissions.join(', ')}.`
        )
      );
      return;
    }

    next();
  };
}

/**
 * Middleware requiring the authenticated caller to possess at least one of the allowed roles.
 * - If req.user is missing -> 401 AUTH_TOKEN_MISSING
 * - If caller lacks required role -> 403 AUTH_FORBIDDEN
 */
export function requireRole(role: Role | Role[] | string | string[]): RequestHandler {
  const allowed = Array.isArray(role) ? role : [role];

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, 'AUTH_TOKEN_MISSING', 'Authentication required.'));
      return;
    }

    const userRoles = req.user.roles || [];
    if (!hasRole(userRoles, allowed)) {
      next(
        new HttpError(
          403,
          'AUTH_FORBIDDEN',
          `Forbidden: Requires one of [${allowed.join(', ')}] roles.`
        )
      );
      return;
    }

    next();
  };
}
