-- =============================================================
-- Migration 005: Recovery Domain Schema (Down)
-- =============================================================

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS policies;
DROP TABLE IF EXISTS case_events;
DROP TABLE IF EXISTS cases;
