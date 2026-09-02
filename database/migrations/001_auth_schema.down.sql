-- =============================================================
-- Migration 001: Auth Schema (Down)
-- =============================================================

DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS roles;
