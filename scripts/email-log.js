/**
 * Answers "why did that email not arrive?" from the email_log table.
 *
 * WHY THIS EXISTS
 * Every send records a row: which template, to whom, and — crucially — a status
 * and an error. Without a way to read it, a missing email is unfalsifiable: the
 * admin console shows a restock notification moved from "waiting" to "notified",
 * the cron reports exit 0, and the customer's inbox stays empty, with nothing
 * anywhere connecting those three facts.
 *
 * READ-ONLY. Issues SELECT statements only.
 *
 * Run:
 *   npm run email:log            last 30 sends, newest first
 *   npm run email:log -- 100     last 100
 *   npm run email:log -- --failed  only the ones that did not go out
 *
 * The statuses and what each one means:
 *   sent                        handed to the SMTP server successfully
 *   failed                      SMTP rejected it or the connection broke (see `error`)
 *   skipped_not_configured      SMTP_HOST is unset on the server — nothing was attempted
 *   skipped_no_consent          marketing mail to someone with no confirmed opt-in
 *   skipped_marketing_disabled  the email_marketing_enabled switch is off
 *   suppressed                  the address is on the suppression list (bounce/complaint)
 *   pending                     claimed but never resolved — the process died mid-send
 */
require('dotenv').config();
const db = require('../src/config/db');

const args = process.argv.slice(2);
const onlyFailed = args.includes('--failed');
const limit = Math.min(500, parseInt(args.find((a) => /^\d+$/.test(a)) || '30', 10));

/** Local part masked: the domain is what matters for diagnosis (does Gmail
 *  accept it? is it a typo'd domain?), the person's identity is not. */
function maskEmail(addr) {
  const s = String(addr || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '(none)';
  const local = s.slice(0, at);
  return `${local[0]}${'*'.repeat(Math.max(2, local.length - 1))}@${s.slice(at + 1)}`;
}

/**
 * Neon's free tier suspends the compute when idle, and the first connection
 * after that wakes it — which takes longer than DB_CONNECT_TIMEOUT_MS allows,
 * so attempt one fails with a bare "Connection terminated due to connection
 * timeout" and no hint that simply trying again would work. That is a miserable
 * thing to hand somebody who is already debugging a missing email.
 *
 * One retry is enough: the failed attempt is itself what starts the wake-up.
 */
async function queryWithWake(sql, params) {
  try {
    return await db.query(sql, params);
  } catch (err) {
    if (!/timeout|ECONNRESET|terminated/i.test(err.message)) throw err;
    console.log('  (database was asleep — waking it and retrying once)');
    await new Promise((r) => setTimeout(r, 3000));
    return db.query(sql, params);
  }
}

(async () => {
  try {
    const { rows: summary } = await queryWithWake(
      `SELECT status, count(*)::int AS n
         FROM email_log
        WHERE created_at > now() - interval '7 days'
        GROUP BY status
        ORDER BY n DESC`
    );

    console.log('\nEmail delivery — last 7 days by status\n');
    if (!summary.length) {
      console.log('  (no email has been logged at all in the last 7 days)');
    } else {
      for (const r of summary) console.log(`  ${String(r.n).padStart(5)}  ${r.status}`);
    }

    const { rows } = await db.query(
      `SELECT created_at, template, recipient, status, error
         FROM email_log
        WHERE ($1::boolean IS NOT TRUE OR status <> 'sent')
        ORDER BY created_at DESC
        LIMIT $2`,
      [onlyFailed, limit]
    );

    console.log(`\n${onlyFailed ? 'Sends that did NOT go out' : 'Most recent sends'} (${rows.length})\n`);
    if (!rows.length) {
      console.log('  (nothing recorded)');
    }
    for (const r of rows) {
      const when = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19);
      console.log(`  ${when}  ${String(r.status).padEnd(26)} ${String(r.template).padEnd(24)} ${maskEmail(r.recipient)}`);
      if (r.error) console.log(`${' '.repeat(23)}└─ ${String(r.error).slice(0, 300)}`);
    }

    // The single most common cause, and the one that looks like success
    // everywhere else in the system, so it is worth calling out by name.
    const notConfigured = summary.find((s) => s.status === 'skipped_not_configured');
    if (notConfigured) {
      console.log(`\n  ⚠ ${notConfigured.n} email(s) were never attempted because SMTP_HOST is not set`);
      console.log('    on the SERVER that ran them. Check the Render environment, not your .env.\n');
    } else {
      console.log('');
    }
  } catch (err) {
    console.error('\n[email-log] Could not read email_log: ' + err.message);
    if (/timeout|terminated/i.test(err.message)) {
      console.error('\n  This is a connection problem, NOT evidence that anything is wrong with');
      console.error('  your email. A suspended Neon compute can take longer to wake than the');
      console.error('  configured timeout allows, and this already retried once. Run it again,');
      console.error('  or run `npm run test:db` to confirm the database itself is reachable.');
    }
    console.error('');
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
})();
