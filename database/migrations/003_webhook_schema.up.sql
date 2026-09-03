-- =============================================================
-- Migration 003: Webhook Schema (Up)
-- =============================================================

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  url VARCHAR(2048) NOT NULL,
  secret VARCHAR(64) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_webhook_endpoints_merchant (merchant_id),
  CONSTRAINT fk_webhook_endpoints_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  endpoint_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending', 'success', 'failed') NOT NULL DEFAULT 'pending',
  response_status INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_webhook_deliveries_endpoint (endpoint_id),
  CONSTRAINT fk_webhook_deliveries_endpoint FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE CASCADE
);
