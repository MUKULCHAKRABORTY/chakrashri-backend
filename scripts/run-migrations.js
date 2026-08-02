/**
 * Applies all .sql files in /migrations, in filename order, and tracks which
 * ones have already run in a `_migrations` table — so this is safe to run
 * repeatedly (e.g. as part of every deploy) without re-applying a migration
 * that already succeeded.
 *
 * Run: npm run migrate
 * (equivalent to: node scripts/run-migrations.js)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are prefixed 001_, 002_, etc. so lexical sort == run order

  if (!files.length) {
    console.log('No migration files found in', MIGRATIONS_DIR);
    process.exit(0);
  }

  const { rows: applied } = await db.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  let ranCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip (already applied): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`  applying: ${file} ...`);
    try {
      await db.withTransaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      });
      console.log(`  done: ${file}`);
      ranCount++;
    } catch (err) {
      console.error(`  FAILED: ${file}\n`, err.message);
      process.exit(1); // stop on first failure rather than continuing in an unknown state
    }
  }

  console.log(`\nMigrations complete. ${ranCount} applied, ${files.length - ranCount} already up to date.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});
