-- =============================================================
-- Migration 004: Idempotency Schema (Up)
-- =============================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_path VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status INT NULL,
  response_body JSON NULL,
  status ENUM('processing', 'completed', 'failed') NOT NULL DEFAULT 'processing',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_idempotency_merchant_key (merchant_id, idempotency_key),
  KEY idx_idempotency_merchant_id (merchant_id),
  KEY idx_idempotency_created_at (created_at),
  CONSTRAINT fk_idempotency_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE CASCADE
);
