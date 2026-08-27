/**
 * Applies all .sql files in /migrations, in filename order, and tracks which
 * ones have already run in a `_migrations` table — so this is safe to run
 * repeatedly (e.g. as part of every deploy) without re-applying a migration
 * that already succeeded.
 *
 * Run: npm run migrate
 * (equivalent to: node scripts/run-migrations.js)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS USES ITS OWN CONNECTION POOL
 * ---------------------------------------------------------------------------
 * The shared request pool carries a 15-second statement_timeout, which is
 * correct for an HTTP request and completely wrong for a migration. Migration
 * 014 builds indexes on the order tables its own header says are going to grow,
 * and 013 backfills every order's shipping address. Both finish instantly on an
 * empty database and are cancelled with SQLSTATE 57014 on a populated one — and
 * because render.yaml runs this as a preDeployCommand, that cancellation fails
 * the whole deploy.
 *
 * createMaintenancePool() is the same connection settings with the timeouts
 * lifted. Nothing else in the application may use it.
 *
 * ---------------------------------------------------------------------------
 * NON-TRANSACTIONAL MIGRATIONS
 * ---------------------------------------------------------------------------
 * A migration whose FIRST line is `-- migrate:no-transaction` is executed
 * outside BEGIN/COMMIT, one statement at a time.
 *
 * This exists for CREATE INDEX CONCURRENTLY, which Postgres refuses to run
 * inside a transaction block. The alternative — a plain CREATE INDEX — takes an
 * ACCESS EXCLUSIVE lock for the entire build, which on a live orders table
 * means every checkout blocks until it completes.
 *
 * The trade-off is real and worth stating plainly: a non-transactional
 * migration that fails partway leaves the earlier statements applied. It is
 * therefore NOT recorded in _migrations on failure, and every statement in such
 * a file must be individually idempotent (IF NOT EXISTS / IF EXISTS) so a
 * re-run is safe. 014 is written that way. Do not use this mode for anything
 * that is not naturally idempotent.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createMaintenancePool } = require('../src/config/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const NO_TRANSACTION_DIRECTIVE = '-- migrate:no-transaction';

const pool = createMaintenancePool();

/**
 * Splits SQL into statements on semicolons that are at the top level — i.e. not
 * inside a string literal, a dollar-quoted block ($$ ... $$, used by every
 * DO/FUNCTION body in these migrations) or a comment.
 *
 * Only used for no-transaction files. Transactional files are handed to
 * Postgres whole, which parses them properly; this simple splitter exists only
 * because CONCURRENTLY statements have to be issued one at a time, and 014
 * deliberately contains nothing that would defeat it.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;

  while (i < sql.length) {
    const ch = sql[i];
    const next2 = sql.slice(i, i + 2);

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i++; continue;
    }
    if (inBlockComment) {
      current += ch;
      if (next2 === '*/') { current += sql[i + 1]; i += 2; inBlockComment = false; continue; }
      i++; continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { current += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      current += ch; i++; continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"') inDouble = false;
      i++; continue;
    }

    if (next2 === '--') { inLineComment = true; current += next2; i += 2; continue; }
    if (next2 === '/*') { inBlockComment = true; current += next2; i += 2; continue; }
    if (ch === "'") { inSingle = true; current += ch; i++; continue; }
    if (ch === '"') { inDouble = true; current += ch; i++; continue; }

    const dollarMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dollarMatch) { dollarTag = dollarMatch[0]; current += dollarTag; i += dollarTag.length; continue; }

    if (ch === ';') { statements.push(current.trim()); current = ''; i++; continue; }

    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());

  // Drop anything that is only comments/whitespace once semicolons are removed.
  return statements.filter((s) => s.replace(/--[^\n]*\n?/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0);
}

/**
 * Surfaces Postgres NOTICE and WARNING messages.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: migration 013 uses RAISE WARNING to
 * report a data-integrity constraint it had to skip because existing rows
 * violate it. node-postgres delivers those on the client's `notice` event and
 * DISCARDS them if nobody listens — so the migration printed a clean "done" and
 * the warning explaining that a promised constraint is absent went nowhere.
 *
 * Found by testing against a database seeded with a deliberately inconsistent
 * legacy row: the migration reported success, the constraint was missing, and
 * nothing said so. A warning nobody sees is the same as no warning.
 */
function attachNoticeListener(client) {
  const handler = (msg) => {
    if (!msg || !msg.message) return;
    const severity = (msg.severity || '').toUpperCase();
    const indented = String(msg.message).split('\n').map((l) => '      ' + l).join('\n');
    if (severity === 'WARNING' || severity === 'ERROR') {
      console.warn(`\n    !! ${severity}:\n${indented}\n`);
    } else if (severity === 'NOTICE' && !/does not exist, skipping|already exists/i.test(msg.message)) {
      // Postgres emits routine NOTICEs for IF EXISTS / IF NOT EXISTS no-ops.
      // Those are noise; anything a migration deliberately raised is not.
      console.log(`    note: ${msg.message}`);
    }
  };
  client.on('notice', handler);
  return () => client.removeListener('notice', handler);
}

async function applyTransactional(sql, file) {
  const client = await pool.connect();
  const detach = attachNoticeListener(client);
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO public');
    await client.query(sql);
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    detach();
    client.release();
  }
}

async function applyNonTransactional(sql, file) {
  const statements = splitStatements(sql);
  console.log(`    (no-transaction mode: ${statements.length} statements)`);

  // One dedicated connection for the whole file, so notices are captured and
  // every statement runs with the same session settings.
  const client = await pool.connect();
  const detach = attachNoticeListener(client);
  try {
    for (const statement of statements) {
      const preview = statement.replace(/\s+/g, ' ').slice(0, 80);
      try {
        await client.query(statement);
      } catch (err) {
        // 42P07 duplicate_table / 42710 duplicate_object can still surface from
        // a partially applied previous run despite IF NOT EXISTS (e.g. an
        // INVALID index left by an interrupted CONCURRENTLY build). Report
        // clearly — the operator needs to know which index to drop.
        console.error(`    FAILED statement: ${preview}...\n      ${err.message}`);
        throw err;
      }
    }
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
  } finally {
    detach();
    client.release();
  }
}

async function main() {
  await pool.query(`
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
    await pool.end();
    process.exit(0);
  }

  const { rows: applied } = await pool.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  let ranCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip (already applied): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const noTransaction = sql.trimStart().startsWith(NO_TRANSACTION_DIRECTIVE);
    console.log(`  applying: ${file} ...`);
    try {
      if (noTransaction) await applyNonTransactional(sql, file);
      else await applyTransactional(sql, file);
      console.log(`  done: ${file}`);
      ranCount++;
    } catch (err) {
      console.error(`  FAILED: ${file}\n`, err.message);
      if (noTransaction) {
        console.error('  NOTE: this migration runs without a transaction, so earlier statements');
        console.error('        in it are already applied. It is written to be idempotent — fix the');
        console.error('        cause and re-run. An interrupted CONCURRENTLY build leaves an INVALID');
        console.error('        index: find it with');
        console.error("          SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;");
        console.error('        then DROP INDEX that name and re-run.');
      }
      await pool.end().catch(() => {});
      process.exit(1); // stop on first failure rather than continuing in an unknown state
    }
  }

  console.log(`\nMigrations complete. ${ranCount} applied, ${files.length - ranCount} already up to date.`);
  await pool.end().catch(() => {});
  process.exit(0);
}

// Only run when invoked directly (`node scripts/run-migrations.js`). Without
// this guard, requiring the module from a test would apply migrations as a
// side effect of the import.
if (require.main === module) {
  main().catch(async (err) => {
    console.error('Migration runner failed:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}

module.exports = { splitStatements, main };
