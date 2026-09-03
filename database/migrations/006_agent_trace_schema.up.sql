-- =============================================================
-- Migration 006: Agent Reasoning Trace Schema (Up) (AI-007 / AUD-002)
-- =============================================================

CREATE TABLE IF NOT EXISTS agent_traces (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  merchant_id BIGINT UNSIGNED NOT NULL,
  case_id BIGINT UNSIGNED NOT NULL,
  trace_ref CHAR(26) NOT NULL,
  agent_type ENUM('diagnosis', 'decision', 'multi_agent') NOT NULL,
  status ENUM('success', 'failed', 'aborted', 'vetoed') NOT NULL,
  termination_reason VARCHAR(255) NULL,
  total_duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  total_input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  total_output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  correlation_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_traces_ref (trace_ref),
  KEY idx_agent_traces_merchant (merchant_id),
  KEY idx_agent_traces_case (case_id),
  KEY idx_agent_traces_correlation (correlation_id),
  KEY idx_agent_traces_created_at (created_at),
  CONSTRAINT fk_agent_traces_merchant FOREIGN KEY (merchant_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_agent_traces_case FOREIGN KEY (case_id) REFERENCES cases (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_trace_steps (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trace_id BIGINT UNSIGNED NOT NULL,
  step_number INT UNSIGNED NOT NULL,
  step_type ENUM('prompt_render', 'model_completion', 'schema_validation', 'repair_attempt', 'policy_evaluation', 'fallback_rules') NOT NULL,
  prompt_id VARCHAR(100) NULL,
  prompt_version VARCHAR(50) NULL,
  model_id VARCHAR(100) NULL,
  system_prompt TEXT NULL,
  user_prompt MEDIUMTEXT NULL,
  raw_response MEDIUMTEXT NULL,
  parsed_output JSON NULL,
  validation_status ENUM('passed', 'failed', 'repaired', 'fallback') NOT NULL DEFAULT 'passed',
  validation_errors JSON NULL,
  tool_invoked VARCHAR(100) NULL,
  tool_arguments JSON NULL,
  tool_result JSON NULL,
  duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_trace_steps_trace_step (trace_id, step_number),
  CONSTRAINT fk_trace_steps_trace FOREIGN KEY (trace_id) REFERENCES agent_traces (id) ON DELETE CASCADE
);
