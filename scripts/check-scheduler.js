#!/usr/bin/env node
/**
 * Answers one question: "is anything still keeping the API awake?"
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A REMINDER
 * ---------------------------------------------------------------------------
 * The storefront's whole cold-start design assumes something calls the API
 * every ten minutes — the cron-job.org schedule that hits the job trigger. That
 * one external service is now the only thing keeping Render warm, and it is
 * outside this repository: an expired account, a disabled job or a changed
 * token stops it silently. Nothing here would notice.
 *
 * The obvious fix is "check it monthly", which is a task that gets forgotten by
 * design. So this checks instead, on a schedule, and fails loudly when the
 * answer is wrong. A red workflow run and the email GitHub sends with it are
 * worth more than a line in a runbook nobody re-reads.
 *
 * ---------------------------------------------------------------------------
 * HOW IT DECIDES
 * ---------------------------------------------------------------------------
 * Latency on /api/health, which needs no credentials. A warm Render instance
 * answers in well under a second; one that has spun down takes 30-60 seconds to
 * boot. So a slow first response means nothing has called the API in at least
 * fifteen minutes, which means the schedule is not running.
 *
 * The check WAKES the instance by asking, so it must run rarely — weekly. Run
 * it every ten minutes and it would quietly become the keep-alive it is
 * supposed to be monitoring, and always report success.
 *
 * One retry, because a single cold reading can also mean the instance restarted
 * moments earlier (a deploy). If the schedule is alive it will have fired again
 * within its interval, so a second cold reading after that window is real.
 *
 * RUN: npm run health
 */
const API_BASE = (process.env.API_BASE || 'https://chakrashri-api.onrender.com').replace(/\/+$/, '');

// A warm instance answers in a few hundred ms. Anything past this had to boot.
const WARM_MS = parseInt(process.env.HEALTH_WARM_MS || '4000', 10);
// Longer than the 10-minute schedule, so a re-check always spans one full tick.
const RETRY_AFTER_MS = parseInt(process.env.HEALTH_RETRY_MS || '720000', 10);
const REQUEST_TIMEOUT_MS = 90000;

const RETRY = process.argv.includes('--retry');

async function probe() {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store', signal: controller.signal });
    return { ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function report(r) {
  console.log(`  ${API_BASE}/api/health -> ${r.ok ? 'HTTP ' + r.status : 'FAILED (' + r.error + ')'} in ${r.ms}ms`);
}

async function main() {
  console.log('\nKeep-alive check\n');
  const first = await probe();
  report(first);

  if (first.ok && first.ms <= WARM_MS) {
    console.log(`\n  WARM — something is calling the API. The schedule is doing its job.\n`);
    return;
  }

  if (!first.ok) {
    console.error('\n  THE API DID NOT ANSWER AT ALL.');
    console.error('  This is more serious than a stopped schedule — check the Render dashboard');
    console.error('  for a failed deploy or a suspended service.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  COLD (${first.ms}ms). Nothing had called the API for at least 15 minutes.`);

  if (!RETRY) {
    console.log('  Pass --retry to re-check after one full schedule interval before deciding.\n');
    process.exitCode = 1;
    return;
  }

  // A single cold reading can also mean the instance restarted moments ago —
  // a deploy does that. Waiting one full interval separates the two: if the
  // schedule is alive it will have fired by now.
  console.log(`  Waiting ${Math.round(RETRY_AFTER_MS / 60000)} minutes for one full schedule interval, then re-checking…\n`);
  await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));

  const second = await probe();
  report(second);

  if (second.ok && second.ms <= WARM_MS) {
    console.log('\n  WARM on the re-check. The first reading was almost certainly a restart, not a gap.\n');
    return;
  }

  console.error('\n  THE KEEP-ALIVE SCHEDULE IS NOT RUNNING.');
  console.error('');
  console.error('  Every visitor now pays a 30-60 second cold start on the first request,');
  console.error('  and the three background jobs are not running either — abandoned checkouts');
  console.error('  hold their stock, and a payment whose webhook was lost is never reconciled.');
  console.error('');
  console.error('  Fix it:');
  console.error('    1. cron-job.org -> is the job enabled, and is its history green?');
  console.error('    2. It should POST to ' + API_BASE + '/api/internal/jobs/run');
  console.error('       every 10 minutes, with header  X-Jobs-Token: <JOBS_TRIGGER_TOKEN>');
  console.error('    3. If the token was rotated in Render, update it there too.');
  console.error('    4. Confirm with:  npm run jobs:status');
  console.error('');
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('check-scheduler failed:', err.message);
    process.exitCode = 1;
  });
}
