-- =============================================================
-- Migration 005: Recovery Domain Schema (Up)
-- =============================================================

-- Table 1: cases (Core recovery case aggregate)
CREATE TABLE IF NOT EXISTS cases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  case_ref CHAR(26) NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  transaction_id BIGINT UNSIGNED NULL,
  status ENUM(
    'detected',
    'diagnosing',
    'scoring',
    'deciding',
    'awaiting_approval',
    'executing',
    'awaiting_outcome',
    'recovered',
    'unrecovered',
    'suppressed',
    'expired',
    'failed'
  ) NOT NULL DEFAULT 'detected',
  recoverable_amount BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  originating_signal VARCHAR(50) NOT NULL,
  failure_category VARCHAR(100) NULL,
  correlation_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cases_ref (case_ref),
  KEY idx_cases_merchant_status (merchant_id, status),
  KEY idx_cases_order_id (order_id),
  KEY idx_cases_transaction_id (transaction_id),
  KEY idx_cases_correlation_id (correlation_id),
  KEY idx_cases_created_at (created_at),
  CONSTRAINT fk_cases_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_cases_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_cases_transaction FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE SET NULL
);

-- Table 2: case_events (Append-only state transitions and lifecycle event store)
CREATE TABLE IF NOT EXISTS case_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id BIGINT UNSIGNED NOT NULL,
  merchant_id BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(50) NULL,
  to_status VARCHAR(50) NOT NULL,
  actor_type ENUM('system', 'agent', 'operator', 'merchant') NOT NULL,
  actor_id VARCHAR(255) NULL,
  reason VARCHAR(500) NULL,
  payload JSON NULL,
  correlation_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_case_events_case_id (case_id),
  KEY idx_case_events_merchant_id (merchant_id),
  KEY idx_case_events_correlation_id (correlation_id),
  KEY idx_case_events_created_at (created_at),
  CONSTRAINT fk_case_events_case FOREIGN KEY (case_id) REFERENCES cases (id) ON DELETE CASCADE,
  CONSTRAINT fk_case_events_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Table 3: policies (Per-merchant recovery governance and autonomy configuration)
CREATE TABLE IF NOT EXISTS policies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  autonomy_tier ENUM('T0', 'T1', 'T2', 'T3', 'T4') NOT NULL DEFAULT 'T1',
  max_retries INT NOT NULL DEFAULT 3,
  max_contacts_per_customer_per_week INT NOT NULL DEFAULT 3,
  daily_budget_minor_units BIGINT NOT NULL DEFAULT 0,
  max_incentive_percent DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
  quiet_hours_start TIME NULL,
  quiet_hours_end TIME NULL,
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_policies_merchant_version (merchant_id, version),
  KEY idx_policies_merchant_active (merchant_id, is_active),
  CONSTRAINT fk_policies_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Table 4: audit_logs (Immutable platform and operator audit trail)
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NULL,
  actor_type ENUM('system', 'agent', 'operator', 'merchant') NOT NULL,
  actor_id VARCHAR(255) NULL,
  event_type VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(255) NOT NULL,
  payload_before JSON NULL,
  payload_after JSON NULL,
  ip_address VARCHAR(45) NULL,
  correlation_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_logs_merchant_id (merchant_id),
  KEY idx_audit_logs_resource (resource_type, resource_id),
  KEY idx_audit_logs_correlation_id (correlation_id),
  KEY idx_audit_logs_created_at (created_at),
  CONSTRAINT fk_audit_logs_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE SET NULL
);
