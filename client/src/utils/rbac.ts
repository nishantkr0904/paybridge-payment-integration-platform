/**
 * Client-side Role-Based Access Control (RBAC) definitions and helpers.
 *
 * Reconciled directly with backend authoritative definitions in server/src/types/auth.ts
 * and server/src/middleware/authorize.ts.
 *
 * NOTE: UI authorization is strictly a presentation and interaction boundary.
 * Authoritative security enforcement is guaranteed by the backend API guards.
 */

export type Role =
  | 'merchant' // legacy compatibility role mapped to merchant_admin permissions
  | 'merchant_admin'
  | 'merchant_operator'
  | 'merchant_developer'
  | 'finance_analyst'
  | 'risk_compliance_reviewer'
  | 'platform_operator';

export type Permission =
  | 'payment:read'
  | 'payment:create'
  | 'recovery:read'
  | 'recovery:approve'
  | 'recovery:reject'
  | 'recovery:close'
  | 'policy:read'
  | 'policy:evaluate'
  | 'policy:update'
  | 'webhook:read'
  | 'webhook:manage'
  | 'webhook:secret:read'
  | 'webhook:retry'
  | 'audit:export'
  | 'explainability:read'
  | 'ledger:read'
  | 'analytics:read'
  | 'ops:trace:read'
  | 'ops:trace:replay'
  | 'ops:shed:execute';

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Legacy role mapped 1:1 to merchant_admin permissions for backward compatibility
  merchant: [
    'payment:read',
    'payment:create',
    'recovery:read',
    'recovery:approve',
    'recovery:reject',
    'recovery:close',
    'policy:read',
    'policy:evaluate',
    'policy:update',
    'webhook:read',
    'webhook:manage',
    'webhook:secret:read',
    'webhook:retry',
    'audit:export',
    'explainability:read',
    'ledger:read',
    'analytics:read',
    'ops:shed:execute'
  ],
  merchant_admin: [
    'payment:read',
    'payment:create',
    'recovery:read',
    'recovery:approve',
    'recovery:reject',
    'recovery:close',
    'policy:read',
    'policy:evaluate',
    'policy:update',
    'webhook:read',
    'webhook:manage',
    'webhook:secret:read',
    'webhook:retry',
    'audit:export',
    'explainability:read',
    'ledger:read',
    'analytics:read',
    'ops:shed:execute'
  ],
  merchant_operator: [
    'payment:read',
    'payment:create',
    'recovery:read',
    'recovery:approve',
    'recovery:reject',
    'recovery:close',
    'policy:read',
    'policy:evaluate',
    'explainability:read',
    'analytics:read',
    'ops:shed:execute'
  ],
  merchant_developer: [
    'payment:read',
    'payment:create',
    'recovery:read',
    'webhook:read',
    'webhook:manage',
    'webhook:secret:read',
    'webhook:retry'
  ],
  finance_analyst: [
    'payment:read',
    'recovery:read',
    'policy:read',
    'ledger:read',
    'analytics:read'
  ],
  risk_compliance_reviewer: [
    'payment:read',
    'recovery:read',
    'policy:read',
    'explainability:read',
    'audit:export'
  ],
  platform_operator: [
    'ops:trace:read',
    'ops:trace:replay',
    'ops:shed:execute'
  ]
};

/**
 * Checks whether a given list of user roles grants a specific permission.
 * Matches backend `hasPermission` from server/src/middleware/authorize.ts.
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
 * Checks whether user roles grant any of the specified permissions.
 */
export function hasAnyPermission(
  userRoles: readonly string[] | string[] | undefined | null,
  permissions: Permission[]
): boolean {
  return permissions.some((p) => hasPermission(userRoles, p));
}
