import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool as defaultPool } from '../config/database.js';

export interface MigrationFile {
  version: number;
  name: string;
  upFile: string;
  downFile: string;
  upPath: string;
  downPath: string;
  upChecksum: string;
}

export interface MigrationRecord extends RowDataPacket {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
  execution_time_ms: number;
}

export type MigrationStatus = 'APPLIED' | 'PENDING' | 'CHECKSUM_MISMATCH';

export interface MigrationStatusItem {
  version: number;
  name: string;
  status: MigrationStatus;
  appliedAt: Date | null;
  storedChecksum: string | null;
  fileChecksum: string;
  executionTimeMs: number | null;
}

export interface MigrationStatusReport {
  appliedCount: number;
  pendingCount: number;
  hasMismatch: boolean;
  migrations: MigrationStatusItem[];
}

export interface MigrationResult {
  version: number;
  name: string;
  checksum: string;
  executionTimeMs: number;
}

export interface RollbackResult {
  version: number;
  name: string;
}

export interface BaselineResult {
  version: number;
  name: string;
  checksum: string;
  alreadyApplied: boolean;
}

export interface MigratorOptions {
  pool?: Pool;
  migrationsDir?: string;
  lockName?: string;
  lockTimeoutSeconds?: number;
}

export interface RollbackOptions extends MigratorOptions {
  to?: number;
  step?: number;
}

export interface BaselineOptions extends MigratorOptions {
  targetVersions?: number[];
}

const DEFAULT_LOCK_NAME = 'paybridge_migrations_lock';
const DEFAULT_LOCK_TIMEOUT = 10;

export function getDefaultMigrationsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../../../database/migrations'),
    path.resolve(currentDir, '../../database/migrations'),
    path.resolve(process.cwd(), 'database/migrations'),
    path.resolve(process.cwd(), '../database/migrations')
  ];

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function calculateChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      current += char;
      if (char === '\\') {
        if (next) {
          current += next;
          i++;
        }
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '#') {
      inLineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      inString = true;
      stringChar = char;
      current += char;
      continue;
    }

    if (char === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const remaining = current.trim();
  if (remaining.length > 0) {
    statements.push(remaining);
  }

  return statements;
}

export async function discoverMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(migrationsDir);
  } catch (error) {
    throw new Error(`Cannot read migrations directory at ${migrationsDir}: ${(error as Error).message}`, {
      cause: error
    });
  }

  const upFiles = new Map<number, { name: string; filename: string; path: string }>();
  const downFiles = new Map<number, { name: string; filename: string; path: string }>();

  const filenameRegex = /^(\d{3,})_([a-zA-Z0-9_-]+)\.(up|down)\.sql$/;

  for (const filename of entries) {
    if (filename.startsWith('.')) continue;

    const match = filename.match(filenameRegex);
    if (!match) {
      throw new Error(
        `Invalid migration filename format: "${filename}". Expected format: NNN_name.up.sql or NNN_name.down.sql`
      );
    }

    const version = parseInt(match[1], 10);
    const name = match[2];
    const type = match[3];
    const fullPath = path.join(migrationsDir, filename);

    if (type === 'up') {
      if (upFiles.has(version)) {
        throw new Error(`Duplicate migration version ${version} detected for up file: ${filename}`);
      }
      upFiles.set(version, { name, filename, path: fullPath });
    } else {
      if (downFiles.has(version)) {
        throw new Error(`Duplicate migration version ${version} detected for down file: ${filename}`);
      }
      downFiles.set(version, { name, filename, path: fullPath });
    }
  }

  const versions = Array.from(new Set([...upFiles.keys(), ...downFiles.keys()])).sort((a, b) => a - b);
  const migrations: MigrationFile[] = [];

  for (const version of versions) {
    const up = upFiles.get(version);
    const down = downFiles.get(version);

    if (!up) {
      throw new Error(`Missing matching .up.sql file for migration version ${version} (${down?.filename})`);
    }
    if (!down) {
      throw new Error(`Missing matching .down.sql file for migration version ${version} (${up.filename})`);
    }
    if (up.name !== down.name) {
      throw new Error(
        `Migration name mismatch for version ${version}: up is "${up.name}" but down is "${down.name}"`
      );
    }

    const upContent = await fs.readFile(up.path, 'utf8');
    const upChecksum = calculateChecksum(upContent);

    migrations.push({
      version,
      name: up.name,
      upFile: up.filename,
      downFile: down.filename,
      upPath: up.path,
      downPath: down.path,
      upChecksum
    });
  }

  return migrations;
}

export async function ensureMigrationsTable(connection: PoolConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execution_time_ms INT NOT NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

async function withAdvisoryLock<T>(
  pool: Pool,
  lockName: string,
  lockTimeoutSeconds: number,
  action: (connection: PoolConnection) => Promise<T>
): Promise<T> {
  const connection = await pool.getConnection();
  let lockAcquired = false;

  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      'SELECT GET_LOCK(?, ?) as lock_acquired',
      [lockName, lockTimeoutSeconds]
    );

    const isAcquired = lockRows[0]?.lock_acquired === 1;
    if (!isAcquired) {
      throw new Error(`Could not acquire migration advisory lock "${lockName}" within ${lockTimeoutSeconds}s`);
    }
    lockAcquired = true;

    return await action(connection);
  } finally {
    if (lockAcquired) {
      try {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        // Lock release cleanup error ignored
      }
    }
    connection.release();
  }
}

export async function getMigrationStatus(options?: MigratorOptions): Promise<MigrationStatusReport> {
  const pool = options?.pool || defaultPool;
  const migrationsDir = options?.migrationsDir || getDefaultMigrationsDir();
  const lockName = options?.lockName || DEFAULT_LOCK_NAME;
  const lockTimeoutSeconds = options?.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT;

  return withAdvisoryLock(pool, lockName, lockTimeoutSeconds, async (connection) => {
    await ensureMigrationsTable(connection);
    const discovered = await discoverMigrations(migrationsDir);

    const [rows] = await connection.query<MigrationRecord[]>(
      'SELECT version, name, checksum, applied_at, execution_time_ms FROM schema_migrations ORDER BY version ASC'
    );

    const appliedMap = new Map<number, MigrationRecord>();
    for (const row of rows) {
      appliedMap.set(row.version, row);
    }

    let appliedCount = 0;
    let pendingCount = 0;
    let hasMismatch = false;
    const items: MigrationStatusItem[] = [];

    for (const m of discovered) {
      const applied = appliedMap.get(m.version);
      if (applied) {
        appliedCount++;
        const mismatch = applied.checksum !== m.upChecksum;
        if (mismatch) {
          hasMismatch = true;
        }
        items.push({
          version: m.version,
          name: m.name,
          status: mismatch ? 'CHECKSUM_MISMATCH' : 'APPLIED',
          appliedAt: applied.applied_at,
          storedChecksum: applied.checksum,
          fileChecksum: m.upChecksum,
          executionTimeMs: applied.execution_time_ms
        });
      } else {
        pendingCount++;
        items.push({
          version: m.version,
          name: m.name,
          status: 'PENDING',
          appliedAt: null,
          storedChecksum: null,
          fileChecksum: m.upChecksum,
          executionTimeMs: null
        });
      }
    }

    return {
      appliedCount,
      pendingCount,
      hasMismatch,
      migrations: items
    };
  });
}

export async function runMigrations(options?: MigratorOptions): Promise<MigrationResult[]> {
  const pool = options?.pool || defaultPool;
  const migrationsDir = options?.migrationsDir || getDefaultMigrationsDir();
  const lockName = options?.lockName || DEFAULT_LOCK_NAME;
  const lockTimeoutSeconds = options?.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT;

  return withAdvisoryLock(pool, lockName, lockTimeoutSeconds, async (connection) => {
    await ensureMigrationsTable(connection);
    const discovered = await discoverMigrations(migrationsDir);

    const [rows] = await connection.query<MigrationRecord[]>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC'
    );

    const appliedMap = new Map<number, MigrationRecord>();
    for (const row of rows) {
      appliedMap.set(row.version, row);
    }

    // Verify checksums of already applied migrations
    for (const m of discovered) {
      const applied = appliedMap.get(m.version);
      if (applied && applied.checksum !== m.upChecksum) {
        throw new Error(
          `Checksum mismatch for migration ${m.version} (${m.name}). ` +
          `Database record checksum: "${applied.checksum}", disk file checksum: "${m.upChecksum}". ` +
          `Applied migrations are immutable.`
        );
      }
    }

    // Determine pending migrations
    const pending = discovered.filter((m) => !appliedMap.has(m.version));
    const results: MigrationResult[] = [];

    for (const m of pending) {
      const sqlContent = await fs.readFile(m.upPath, 'utf8');
      const statements = splitSqlStatements(sqlContent);

      const startTime = Date.now();
      for (const statement of statements) {
        try {
          await connection.query(statement);
        } catch (err) {
          throw new Error(
            `Failed executing migration ${m.version} (${m.name}) statement:\n${statement}\nError: ${(err as Error).message}`,
            { cause: err }
          );
        }
      }
      const executionTimeMs = Math.max(1, Date.now() - startTime);

      await connection.query(
        'INSERT INTO schema_migrations (version, name, checksum, execution_time_ms) VALUES (?, ?, ?, ?)',
        [m.version, m.name, m.upChecksum, executionTimeMs]
      );

      results.push({
        version: m.version,
        name: m.name,
        checksum: m.upChecksum,
        executionTimeMs
      });
    }

    return results;
  });
}

export async function rollbackMigrations(options?: RollbackOptions): Promise<RollbackResult[]> {
  const pool = options?.pool || defaultPool;
  const migrationsDir = options?.migrationsDir || getDefaultMigrationsDir();
  const lockName = options?.lockName || DEFAULT_LOCK_NAME;
  const lockTimeoutSeconds = options?.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT;
  const toVersion = options?.to;
  const step = options?.step ?? (toVersion === undefined ? 1 : undefined);

  return withAdvisoryLock(pool, lockName, lockTimeoutSeconds, async (connection) => {
    await ensureMigrationsTable(connection);
    const discovered = await discoverMigrations(migrationsDir);
    const discoveredMap = new Map<number, MigrationFile>();
    for (const m of discovered) {
      discoveredMap.set(m.version, m);
    }

    const [appliedRows] = await connection.query<MigrationRecord[]>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version DESC'
    );

    // Verify checksums of applied migrations
    for (const applied of appliedRows) {
      const m = discoveredMap.get(applied.version);
      if (m && applied.checksum !== m.upChecksum) {
        throw new Error(
          `Checksum mismatch for migration ${applied.version} (${applied.name}). ` +
          `Database record checksum: "${applied.checksum}", disk file checksum: "${m.upChecksum}". ` +
          `Applied migrations are immutable.`
        );
      }
    }

    let toRollback: MigrationRecord[] = [];
    if (toVersion !== undefined) {
      toRollback = appliedRows.filter((row) => row.version > toVersion);
    } else if (step !== undefined) {
      toRollback = appliedRows.slice(0, step);
    }

    const results: RollbackResult[] = [];

    for (const record of toRollback) {
      const m = discoveredMap.get(record.version);
      if (!m) {
        throw new Error(
          `Cannot rollback migration ${record.version} (${record.name}): migration file not found in ${migrationsDir}`
        );
      }

      const sqlContent = await fs.readFile(m.downPath, 'utf8');
      const statements = splitSqlStatements(sqlContent);

      for (const statement of statements) {
        try {
          await connection.query(statement);
        } catch (err) {
          throw new Error(
            `Failed executing rollback for migration ${m.version} (${m.name}) statement:\n${statement}\nError: ${(err as Error).message}`,
            { cause: err }
          );
        }
      }

      await connection.query('DELETE FROM schema_migrations WHERE version = ?', [record.version]);

      results.push({
        version: record.version,
        name: record.name
      });
    }

    return results;
  });
}

export async function baselineDatabase(options?: BaselineOptions): Promise<BaselineResult[]> {
  const pool = options?.pool || defaultPool;
  const migrationsDir = options?.migrationsDir || getDefaultMigrationsDir();
  const lockName = options?.lockName || DEFAULT_LOCK_NAME;
  const lockTimeoutSeconds = options?.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT;
  const targetVersions = options?.targetVersions || [1, 2, 3, 4];

  return withAdvisoryLock(pool, lockName, lockTimeoutSeconds, async (connection) => {
    await ensureMigrationsTable(connection);
    const discovered = await discoverMigrations(migrationsDir);
    const discoveredMap = new Map<number, MigrationFile>();
    for (const m of discovered) {
      discoveredMap.set(m.version, m);
    }

    // Verify baseline table existence in current database
    const [tables] = await connection.query<RowDataPacket[]>(`
      SELECT TABLE_NAME 
      FROM information_schema.tables 
      WHERE table_schema = DATABASE() 
        AND table_name IN ('users', 'orders', 'webhook_endpoints', 'idempotency_keys')
    `);

    const tableNames = new Set(tables.map((t) => t.TABLE_NAME?.toLowerCase()));
    const requiredTables = ['users', 'orders', 'webhook_endpoints', 'idempotency_keys'];
    const missingTables = requiredTables.filter((t) => !tableNames.has(t));

    if (missingTables.length > 0) {
      throw new Error(
        `Cannot baseline database: Expected existing schema tables were not found in current database: [${missingTables.join(', ')}]. ` +
        `Run "npm run db:migrate" instead for fresh installations.`
      );
    }

    const [appliedRows] = await connection.query<MigrationRecord[]>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC'
    );
    const appliedMap = new Map<number, MigrationRecord>();
    for (const row of appliedRows) {
      appliedMap.set(row.version, row);
    }

    const results: BaselineResult[] = [];

    for (const version of targetVersions) {
      const m = discoveredMap.get(version);
      if (!m) {
        throw new Error(`Cannot baseline: migration version ${version} not found in ${migrationsDir}`);
      }

      if (appliedMap.has(version)) {
        results.push({
          version: m.version,
          name: m.name,
          checksum: m.upChecksum,
          alreadyApplied: true
        });
      } else {
        await connection.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_time_ms) VALUES (?, ?, ?, 0)',
          [m.version, m.name, m.upChecksum]
        );
        results.push({
          version: m.version,
          name: m.name,
          checksum: m.upChecksum,
          alreadyApplied: false
        });
      }
    }

    return results;
  });
}
