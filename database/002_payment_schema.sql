-- =============================================================
-- PayBridge – Version 2: Payment Schema
-- =============================================================
-- Depends on: 001_auth_schema.sql (users table must exist)
-- =============================================================

CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  order_ref CHAR(26) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  description VARCHAR(255) NULL,
  status ENUM('pending', 'processing', 'success', 'failed') NOT NULL DEFAULT 'pending',
  customer_email VARCHAR(255) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_ref (order_ref),
  KEY idx_orders_merchant_id (merchant_id),
  KEY idx_orders_status (status),
  KEY idx_orders_created_at (created_at),
  CONSTRAINT fk_orders_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  txn_ref CHAR(26) NOT NULL,
  payment_method ENUM('card', 'upi', 'netbanking', 'wallet') NOT NULL,
  status ENUM('initiated', 'processing', 'success', 'failed') NOT NULL DEFAULT 'initiated',
  gateway_response JSON NULL,
  failure_reason VARCHAR(255) NULL,
  amount DECIMAL(12, 2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_transactions_ref (txn_ref),
  KEY idx_transactions_order_id (order_id),
  KEY idx_transactions_status (status),
  CONSTRAINT fk_transactions_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
);
