-- =============================================================
-- Migration 007: RBAC Schema & Authorization Primitives (Up)
-- =============================================================

CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  description VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_permissions_name (name)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id),
  KEY idx_role_permissions_permission_id (permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
);

INSERT INTO roles (name, description) VALUES
  ('merchant_admin', 'Merchant administrator with full tenant authority'),
  ('merchant_operator', 'Merchant operations and recovery case management'),
  ('merchant_developer', 'Merchant technical developer for webhooks and integration'),
  ('finance_analyst', 'Financial analyst for recovery ledger and revenue reconciliation'),
  ('risk_compliance_reviewer', 'Risk and compliance officer for audit logs and explainability'),
  ('platform_operator', 'Platform operations engineer for infrastructure telemetry and traces')
ON DUPLICATE KEY UPDATE description = VALUES(description);

INSERT INTO permissions (name, description) VALUES
  ('payment:read', 'View orders and payment transaction details'),
  ('payment:create', 'Create orders and initiate payments'),
  ('recovery:read', 'View recovery cases, queue, traces, and metrics'),
  ('recovery:approve', 'Approve recovery case actions'),
  ('recovery:reject', 'Reject recovery case actions'),
  ('recovery:close', 'Close recovery cases manually'),
  ('policy:read', 'View recovery policies and rules'),
  ('policy:evaluate', 'Evaluate policies against test inputs'),
  ('policy:update', 'Create, update, or toggle recovery policies'),
  ('webhook:read', 'View webhook endpoints and delivery logs'),
  ('webhook:manage', 'Register, update, or remove webhook endpoints'),
  ('webhook:secret:read', 'View webhook signing secrets'),
  ('webhook:retry', 'Manually retry webhook deliveries'),
  ('audit:export', 'Export audit logs and compliance packages'),
  ('explainability:read', 'View AI agent reasoning and explainability summaries'),
  ('ledger:read', 'View recovery financial ledger and revenue recovery metrics'),
  ('analytics:read', 'View recovery performance and business analytics'),
  ('ops:trace:read', 'View unredacted reasoning traces across tenants'),
  ('ops:trace:replay', 'Trigger reasoning trace replays'),
  ('ops:shed:execute', 'Execute emergency load shedding')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- 1. merchant_admin and legacy 'merchant' role (backward compatibility mapping)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name IN ('merchant_admin', 'merchant')
  AND p.name IN (
    'payment:read', 'payment:create',
    'recovery:read', 'recovery:approve', 'recovery:reject', 'recovery:close',
    'policy:read', 'policy:evaluate', 'policy:update',
    'webhook:read', 'webhook:manage', 'webhook:secret:read', 'webhook:retry',
    'audit:export', 'explainability:read', 'ledger:read', 'analytics:read',
    'ops:shed:execute'
  );

-- 2. merchant_operator
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'merchant_operator'
  AND p.name IN (
    'payment:read', 'payment:create',
    'recovery:read', 'recovery:approve', 'recovery:reject', 'recovery:close',
    'policy:read', 'policy:evaluate',
    'explainability:read', 'analytics:read',
    'ops:shed:execute'
  );

-- 3. merchant_developer
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'merchant_developer'
  AND p.name IN (
    'payment:read', 'payment:create',
    'recovery:read',
    'webhook:read', 'webhook:manage', 'webhook:secret:read', 'webhook:retry'
  );

-- 4. finance_analyst
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'finance_analyst'
  AND p.name IN (
    'payment:read',
    'recovery:read',
    'policy:read',
    'ledger:read',
    'analytics:read'
  );

-- 5. risk_compliance_reviewer
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'risk_compliance_reviewer'
  AND p.name IN (
    'payment:read',
    'recovery:read',
    'policy:read',
    'explainability:read',
    'audit:export'
  );

-- 6. platform_operator
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'platform_operator'
  AND p.name IN (
    'ops:trace:read',
    'ops:trace:replay',
    'ops:shed:execute'
  );
