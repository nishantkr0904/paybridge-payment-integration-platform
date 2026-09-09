-- =============================================================
-- Migration 007: RBAC Schema & Authorization Primitives (Down)
-- =============================================================

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;

DELETE FROM roles WHERE name IN (
  'merchant_admin',
  'merchant_operator',
  'merchant_developer',
  'finance_analyst',
  'risk_compliance_reviewer',
  'platform_operator'
);
