import { closePool } from '../config/database.js';
import {
  runMigrations,
  rollbackMigrations,
  getMigrationStatus,
  baselineDatabase,
  getDefaultMigrationsDir
} from '../infrastructure/migrator.js';

function parseArgs(args: string[]) {
  const command = args[0] || 'status';
  let toVersion: number | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--to=')) {
      toVersion = parseInt(arg.substring(5), 10);
    } else if (arg === '--to' && args[i + 1]) {
      toVersion = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { command, toVersion };
}

async function main() {
  const args = process.argv.slice(2);
  const { command, toVersion } = parseArgs(args);
  const migrationsDir = getDefaultMigrationsDir();

  try {
    switch (command) {
      case 'migrate': {
        console.log(`\n📦 Running database migrations from: ${migrationsDir}\n`);
        const results = await runMigrations({ migrationsDir });
        if (results.length === 0) {
          console.log('✅ Database is already up to date. No pending migrations.');
        } else {
          console.log(`✅ Successfully applied ${results.length} migration(s):`);
          for (const r of results) {
            console.log(`  - [${String(r.version).padStart(3, '0')}] ${r.name} (${r.executionTimeMs}ms) [${r.checksum.substring(0, 8)}...]`);
          }
        }
        break;
      }

      case 'rollback': {
        console.log(`\n⏪ Rolling back database migrations (target: ${toVersion !== undefined ? `to version ${toVersion}` : '1 step'})...\n`);
        const results = await rollbackMigrations({ migrationsDir, to: toVersion });
        if (results.length === 0) {
          console.log('ℹ️ No migrations were rolled back.');
        } else {
          console.log(`✅ Successfully rolled back ${results.length} migration(s):`);
          for (const r of results) {
            console.log(`  - [${String(r.version).padStart(3, '0')}] ${r.name}`);
          }
        }
        break;
      }

      case 'status': {
        console.log(`\n🔍 Checking database migration status...\n`);
        const report = await getMigrationStatus({ migrationsDir });
        
        console.log(`Directory: ${migrationsDir}`);
        console.log(`Total: ${report.migrations.length} | Applied: ${report.appliedCount} | Pending: ${report.pendingCount} | Checksum Mismatch: ${report.hasMismatch ? 'YES ⚠️' : 'NO'}\n`);

        console.log('Ver  | Name                         | Status             | Applied At                | Checksum (SHA-256)');
        console.log('-----+------------------------------+--------------------+---------------------------+-------------------');
        for (const m of report.migrations) {
          const ver = String(m.version).padStart(3, '0');
          const name = m.name.padEnd(28, ' ').substring(0, 28);
          const status = m.status.padEnd(18, ' ');
          const appliedAt = m.appliedAt ? new Date(m.appliedAt).toISOString().substring(0, 19).replace('T', ' ') : '                   ';
          const checksum = m.storedChecksum ? m.storedChecksum.substring(0, 12) + '...' : m.fileChecksum.substring(0, 12) + '...';
          console.log(`${ver}  | ${name} | ${status} | ${appliedAt.padEnd(25, ' ')} | ${checksum}`);
        }
        console.log('');

        if (report.hasMismatch) {
          console.error('⚠️ WARNING: Checksum mismatch detected on one or more applied migrations!');
          process.exitCode = 1;
        }
        break;
      }

      case 'baseline': {
        console.log(`\n📌 Baselining database migrations (001–004)...\n`);
        const results = await baselineDatabase({ migrationsDir });
        console.log(`✅ Baselined ${results.length} migration(s):`);
        for (const r of results) {
          const status = r.alreadyApplied ? 'already recorded' : 'newly registered';
          console.log(`  - [${String(r.version).padStart(3, '0')}] ${r.name} (${status}) [${r.checksum.substring(0, 8)}...]`);
        }
        break;
      }

      default: {
        console.error(`Unknown command: "${command}". Available commands: migrate, rollback, status, baseline`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(`\n❌ Migration error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
