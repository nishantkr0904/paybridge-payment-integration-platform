import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool } from '../../config/database.js';
import {
  discoverMigrations,
  splitSqlStatements,
  calculateChecksum,
  ensureMigrationsTable,
  getMigrationStatus,
  runMigrations,
  rollbackMigrations,
  baselineDatabase,
  getDefaultMigrationsDir
} from '../../infrastructure/migrator.js';

describe('Database Migration Engine (TASK-101 / FND-005)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paybridge-mig-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Temp dir cleanup ignored
    }
    vi.restoreAllMocks();
  });

  describe('SQL Statement Parsing & Utility Helpers', () => {
    it('splits multi-statement SQL files correctly while ignoring semicolons inside strings and comments', () => {
      const sampleSql = `
        -- Line comment with ; semicolon
        CREATE TABLE test_table (
          id INT NOT NULL,
          description VARCHAR(255) DEFAULT 'val;with;semicolons'
        );
        /* Block comment with ; semicolon */
        INSERT INTO test_table (id, description) VALUES (1, "double \\"quoted\\"; string");
        # Hash comment
        SELECT * FROM test_table WHERE description = 'another;test';
      `;

      const statements = splitSqlStatements(sampleSql);
      expect(statements.length).toBe(3);
      expect(statements[0]).toContain('CREATE TABLE test_table');
      expect(statements[0]).toContain("'val;with;semicolons'");
      expect(statements[1]).toContain('INSERT INTO test_table');
      expect(statements[1]).toContain('"double \\"quoted\\"; string"');
      expect(statements[2]).toContain("SELECT * FROM test_table WHERE description = 'another;test'");
    });

    it('calculates deterministic SHA-256 checksums', () => {
      const content1 = 'CREATE TABLE test (id INT);';
      const content2 = 'CREATE TABLE test (id INT);';
      const content3 = 'CREATE TABLE test (id BIGINT);';

      const checksum1 = calculateChecksum(content1);
      const checksum2 = calculateChecksum(content2);
      const checksum3 = calculateChecksum(content3);

      expect(checksum1).toBe(checksum2);
      expect(checksum1).toHaveLength(64);
      expect(checksum1).not.toBe(checksum3);
    });

    it('finds canonical project migrations directory', () => {
      const dir = getDefaultMigrationsDir();
      expect(typeof dir).toBe('string');
      expect(dir).toContain('database/migrations');
    });
  });

  describe('Migration Discovery & Validation', () => {
    it('discovers and orders canonical project migrations (001–004)', async () => {
      const canonicalDir = getDefaultMigrationsDir();
      const discovered = await discoverMigrations(canonicalDir);

      expect(discovered.length).toBe(4);
      expect(discovered.map((m) => m.version)).toEqual([1, 2, 3, 4]);
      expect(discovered[0].name).toBe('auth_schema');
      expect(discovered[1].name).toBe('payment_schema');
      expect(discovered[2].name).toBe('webhook_schema');
      expect(discovered[3].name).toBe('idempotency_schema');

      for (const m of discovered) {
        expect(m.upChecksum).toHaveLength(64);
        expect(m.upFile).toBe(`${String(m.version).padStart(3, '0')}_${m.name}.up.sql`);
        expect(m.downFile).toBe(`${String(m.version).padStart(3, '0')}_${m.name}.down.sql`);
      }
    });

    it('rejects invalid migration filename patterns', async () => {
      await fs.writeFile(path.join(tempDir, 'invalid_file.sql'), 'SELECT 1;');
      await expect(discoverMigrations(tempDir)).rejects.toThrow(/Invalid migration filename format/);
    });

    it('rejects duplicate migration versions', async () => {
      await fs.writeFile(path.join(tempDir, '001_first.up.sql'), 'SELECT 1;');
      await fs.writeFile(path.join(tempDir, '001_first.down.sql'), 'SELECT 1;');
      await fs.writeFile(path.join(tempDir, '001_second.up.sql'), 'SELECT 2;');
      await fs.writeFile(path.join(tempDir, '001_second.down.sql'), 'SELECT 2;');

      await expect(discoverMigrations(tempDir)).rejects.toThrow(/Duplicate migration version 1/);
    });

    it('rejects missing .down.sql pairs', async () => {
      await fs.writeFile(path.join(tempDir, '001_only_up.up.sql'), 'SELECT 1;');
      await expect(discoverMigrations(tempDir)).rejects.toThrow(/Missing matching .down.sql file/);
    });

    it('rejects missing .up.sql pairs', async () => {
      await fs.writeFile(path.join(tempDir, '001_only_down.down.sql'), 'SELECT 1;');
      await expect(discoverMigrations(tempDir)).rejects.toThrow(/Missing matching .up.sql file/);
    });

    it('rejects name mismatches between up and down pairs', async () => {
      await fs.writeFile(path.join(tempDir, '001_create_users.up.sql'), 'SELECT 1;');
      await fs.writeFile(path.join(tempDir, '001_drop_users.down.sql'), 'SELECT 1;');

      await expect(discoverMigrations(tempDir)).rejects.toThrow(/Migration name mismatch/);
    });
  });

  describe('Database Migration Lifecycle & Execution (Integration)', () => {
    const testLockName = `paybridge_test_lock_${Date.now()}`;

    // Helper to create a sandbox migration set
    async function createTestMigrations(dir: string, count = 2) {
      for (let i = 1; i <= count; i++) {
        const ver = String(i).padStart(3, '0');
        const tableName = `mig_test_tbl_${i}_${Date.now()}`;
        const upSql = `CREATE TABLE IF NOT EXISTS ${tableName} (id INT PRIMARY KEY, name VARCHAR(50));`;
        const downSql = `DROP TABLE IF EXISTS ${tableName};`;

        await fs.writeFile(path.join(dir, `${ver}_test_table_${i}.up.sql`), upSql);
        await fs.writeFile(path.join(dir, `${ver}_test_table_${i}.down.sql`), downSql);
      }
    }

    it('creates schema_migrations table and executes migration lifecycle cleanly', async () => {
      await createTestMigrations(tempDir, 2);

      // Clean test tracking state
      const conn = await pool.getConnection();
      try {
        await ensureMigrationsTable(conn);
        await conn.query('DELETE FROM schema_migrations');
      } finally {
        conn.release();
      }

      // Initial status: 2 pending
      const initialStatus = await getMigrationStatus({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });
      expect(initialStatus.appliedCount).toBe(0);
      expect(initialStatus.pendingCount).toBe(2);
      expect(initialStatus.hasMismatch).toBe(false);

      // Run migrations
      const migrateResults = await runMigrations({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });
      expect(migrateResults.length).toBe(2);
      expect(migrateResults[0].version).toBe(1);
      expect(migrateResults[1].version).toBe(2);

      // Post-migrate status: 2 applied, 0 pending
      const postStatus = await getMigrationStatus({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });
      expect(postStatus.appliedCount).toBe(2);
      expect(postStatus.pendingCount).toBe(0);
      expect(postStatus.hasMismatch).toBe(false);

      // Subsequent migrate is idempotent (0 applied)
      const repeatMigrate = await runMigrations({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });
      expect(repeatMigrate).toEqual([]);

      // Rollback 1 step
      const rollback1 = await rollbackMigrations({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName,
        step: 1
      });
      expect(rollback1.length).toBe(1);
      expect(rollback1[0].version).toBe(2);

      // Check status after 1 rollback: 1 applied, 1 pending
      const rollbackStatus = await getMigrationStatus({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });
      expect(rollbackStatus.appliedCount).toBe(1);
      expect(rollbackStatus.pendingCount).toBe(1);

      // Rollback to 0 (all remaining)
      const rollbackAll = await rollbackMigrations({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName,
        to: 0
      });
      expect(rollbackAll.length).toBe(1);
      expect(rollbackAll[0].version).toBe(1);

      const finalStatus = await getMigrationStatus({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });
      expect(finalStatus.appliedCount).toBe(0);
      expect(finalStatus.pendingCount).toBe(2);
    });

    it('detects checksum tampering on applied migrations and halts execution', async () => {
      await createTestMigrations(tempDir, 1);

      const conn = await pool.getConnection();
      try {
        await ensureMigrationsTable(conn);
        await conn.query('DELETE FROM schema_migrations');
      } finally {
        conn.release();
      }

      // Apply migration 001
      await runMigrations({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });

      // Tamper with migration file on disk
      await fs.writeFile(
        path.join(tempDir, '001_test_table_1.up.sql'),
        '-- TAMPERED SQL CONTENT\nCREATE TABLE tampered (id INT);'
      );

      // Status should detect mismatch
      const tamperedStatus = await getMigrationStatus({
        pool,
        migrationsDir: tempDir,
        lockName: testLockName
      });
      expect(tamperedStatus.hasMismatch).toBe(true);
      expect(tamperedStatus.migrations[0].status).toBe('CHECKSUM_MISMATCH');

      // Subsequent migrate must fail with hard error
      await expect(
        runMigrations({
          pool,
          migrationsDir: tempDir,
          lockName: testLockName
        })
      ).rejects.toThrow(/Checksum mismatch for migration 1/);

      // Rollback must also detect mismatch and fail
      await expect(
        rollbackMigrations({
          pool,
          migrationsDir: tempDir,
          lockName: testLockName
        })
      ).rejects.toThrow(/Checksum mismatch for migration 1/);
    });

    it('baselines existing schema and marks migrations without re-executing DDL', async () => {
      const canonicalDir = getDefaultMigrationsDir();

      const conn = await pool.getConnection();
      try {
        await ensureMigrationsTable(conn);
        await conn.query('DELETE FROM schema_migrations');
      } finally {
        conn.release();
      }

      // Baseline versions 1..4 against existing schema
      const baselineResult = await baselineDatabase({
        pool,
        migrationsDir: canonicalDir,
        lockName: testLockName,
        targetVersions: [1, 2, 3, 4]
      });

      expect(baselineResult.length).toBe(4);
      expect(baselineResult.every((r) => !r.alreadyApplied)).toBe(true);

      // Check status: all 4 are APPLIED
      const status = await getMigrationStatus({
        pool,
        migrationsDir: canonicalDir,
        lockName: testLockName
      });
      expect(status.appliedCount).toBe(4);
      expect(status.pendingCount).toBe(0);
      expect(status.hasMismatch).toBe(false);

      // Re-running baseline is idempotent
      const repeatBaseline = await baselineDatabase({
        pool,
        migrationsDir: canonicalDir,
        lockName: testLockName,
        targetVersions: [1, 2, 3, 4]
      });
      expect(repeatBaseline.every((r) => r.alreadyApplied)).toBe(true);
    });

    it('baseline fails if expected tables are missing in database', async () => {
      const mockConn = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (typeof sql === 'string' && sql.includes('GET_LOCK')) {
            return [[{ lock_acquired: 1 }]];
          }
          if (typeof sql === 'string' && sql.includes('information_schema.tables')) {
            return [[]]; // Return no tables found
          }
          return [[]];
        }),
        release: vi.fn()
      } as unknown as PoolConnection;

      const mockPool = {
        getConnection: vi.fn().mockResolvedValue(mockConn)
      } as unknown as Pool;

      await expect(
        baselineDatabase({
          pool: mockPool,
          migrationsDir: getDefaultMigrationsDir(),
          lockName: testLockName
        })
      ).rejects.toThrow(/Expected existing schema tables were not found/);
    });

    it('enforces mutual exclusion via MySQL advisory lock', async () => {
      const lockHolderConn = await pool.getConnection();
      const lockName = `mig_excl_test_${Date.now()}`;

      try {
        // Acquire advisory lock on first connection
        const [rows] = await lockHolderConn.query<RowDataPacket[]>(
          'SELECT GET_LOCK(?, 5) as lock_acquired',
          [lockName]
        );
        expect(rows[0]?.lock_acquired).toBe(1);

        // Attempting to run migrations on another connection with 1s timeout must throw lock timeout error
        await expect(
          runMigrations({
            pool,
            migrationsDir: getDefaultMigrationsDir(),
            lockName,
            lockTimeoutSeconds: 1
          })
        ).rejects.toThrow(/Could not acquire migration advisory lock/);
      } finally {
        await lockHolderConn.query('SELECT RELEASE_LOCK(?)', [lockName]);
        lockHolderConn.release();
      }
    });
  });
});
