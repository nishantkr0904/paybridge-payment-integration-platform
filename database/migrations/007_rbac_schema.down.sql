-- =============================================================
-- Migration 007: RBAC Schema & Authorization Primitives (Down)
-- =============================================================

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;

-- Reassign any user_roles rows referencing the RBAC roles to the legacy 'merchant' role
-- before deleting the roles to prevent CASCADE deletion from stripping user memberships.
INSERT IGNORE INTO user_roles (user_id, role_id)
SELECT DISTINCT ur.user_id, r_fallback.id
FROM user_roles ur
JOIN roles r_old ON ur.role_id = r_old.id
JOIN roles r_fallback ON r_fallback.name = 'merchant'
WHERE r_old.name IN (
  'merchant_admin',
  'merchant_operator',
  'merchant_developer',
  'finance_analyst',
  'risk_compliance_reviewer',
  'platform_operator'
);

DELETE FROM roles WHERE name IN (
  'merchant_admin',
  'merchant_operator',
  'merchant_developer',
  'finance_analyst',
  'risk_compliance_reviewer',
  'platform_operator'
);
