#!/usr/bin/env node
/**
 * The pre-deploy gate: `npm run verify` with nothing allowed to skip.
 *
 * WHY THIS EXISTS
 * Two suites can remove themselves from the run: test:browser when the Chromium
 * binary was never downloaded, and test:db-integration when no throwaway
 * database is configured. Both of those skips are correct on a developer laptop
 * — a missing optional download must never be able to stop the checks that CAN
 * run — and both are wrong immediately before a deploy, where "green" needs to
 * mean everything actually ran.
 *
 * This happened for real. A `npm run verify` reported success while the browser
 * test had crashed the chain and the 29 database integration tests had silently
 * skipped: the run looked like a full pass and had verified neither the DOM
 * behaviour nor a single database invariant. Hence one command whose green
 * cannot mean that.
 *
 * WHY A SCRIPT AND NOT AN INLINE ENV ASSIGNMENT
 * `FOO=bar npm run verify` is a POSIX shell construct. On Windows cmd.exe and
 * PowerShell it is a syntax error, and this project is developed on Windows.
 * cross-env would solve it too; a dozen lines of Node solves it without adding a
 * dependency to the build path.
 *
 * Run: npm run verify:full
 */
const { spawn } = require('child_process');

const REQUIRED = {
  // A skipped browser test becomes a failure.
  REQUIRE_BROWSER_TESTS: 'true',
  // A skipped database integration run becomes a failure.
  REQUIRE_DB_TESTS: 'true'
};

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
if (!hasTestDb) {
  // Fail here rather than three minutes into the run. The whole point of this
  // command is that it cannot be satisfied without a database, so saying so up
  // front is kinder than saying it after the offline suite has finished.
  console.error('\n[verify:full] Cannot run: no TEST_DATABASE_URL is set.\n');
  console.error('  The database integration tests CREATE AND DELETE rows, so they need a');
  console.error('  disposable database — never your production one. Any of these works:');
  console.error('');
  console.error('    - a Neon branch of your project (instant, free, isolated)');
  console.error('    - a second Neon database named e.g. chakrashri_test');
  console.error('    - a local Postgres: postgresql://postgres@localhost:5432/chakrashri_test');
  console.error('');
  console.error('  Put it in .env as TEST_DATABASE_URL, apply the migrations to it once');
  console.error('  (TEST_DATABASE_URL is not read by `npm run migrate` — point DATABASE_URL');
  console.error('  at the throwaway database for that one command), then re-run this.\n');
  console.error('  To run everything else without the database tests: npm run verify\n');
  process.exit(1);
}

const env = { ...process.env, ...REQUIRED };

console.log('\n[verify:full] Running the full gate. Nothing may skip:');
console.log('              REQUIRE_BROWSER_TESTS=true  REQUIRE_DB_TESTS=true');
console.log('              database: ' + describe(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) + '\n');

// shell:true because npm is npm.cmd on Windows. The command is a fixed literal
// with no interpolated input, so there is nothing here for a shell to misread.
const child = spawn('npm run verify', { stdio: 'inherit', shell: true, env });

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`\n[verify:full] Terminated by signal ${signal}.\n`);
    process.exit(1);
  }
  if (code === 0) {
    console.log('\n[verify:full] PASSED — every suite ran, none skipped.\n');
  } else {
    console.error(`\n[verify:full] FAILED (exit ${code}). Do not deploy this.\n`);
  }
  process.exit(code === null ? 1 : code);
});

child.on('error', (err) => {
  console.error('\n[verify:full] Could not start npm: ' + err.message + '\n');
  process.exit(1);
});

/** Host and database name only — never the credentials, which must not be logged. */
function describe(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.hostname + u.pathname;
  } catch {
    return '(configured)';
  }
}
