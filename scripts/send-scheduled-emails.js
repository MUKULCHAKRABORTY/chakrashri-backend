#!/usr/bin/env node
/**
 * The emails that are not triggered by a request.
 *
 * Four jobs, one process, run on a single schedule (every 15 minutes is right;
 * see render.yaml). They are in one file because they share the "is it due
 * yet?" problem and the same failure discipline, and because four Render cron
 * services cost four times as much as one for work that takes seconds.
 *
 *   1. Back-in-stock  — tell the people who asked, once, when stock returns.
 *   2. Booking reminders — the day before a puja or consultation.
 *   3. Abandoned checkout — one recovery email, before the sweep cancels it.
 *   4. Daily digest — what happened yesterday, once each morning.
 *
 * IDEMPOTENCE IS THE WHOLE DESIGN. A cron that runs every fifteen minutes will
 * see the same due row ninety-six times a day, so "have I already sent this?"
 * cannot be a matter of timing. Every job here answers it from committed state:
 * a notified_at stamp, a recovery_email_sent_at column, or a dedupe key on the
 * email itself. Run this script twice in a row and the second run sends
 * nothing — that is the acceptance test, and it is in test/db-integration.
 *
 * Exit code is 0 when the run completed, 1 when a job threw. A cron that fails
 * silently is not a cron.
 *
 * Run: node scripts/send-scheduled-emails.js [job]
 *      job = stock | reminders | abandoned | bookingsAbandoned | digest   (default: all)
 */
require('dotenv').config();

const db = require('../src/config/db');
const { logger } = require('../src/utils/logger');
const {
  sendBackInStock, sendBookingReminder, sendAbandonedCheckout, sendAdminDailyDigest,
  sendBookingAbandoned
} = require('../src/utils/mailer');
// Which send outcomes are final versus worth retrying. Defined next to sendMail
// so the vocabulary has one owner — see the comment on it in email/engine.js.
const { TERMINAL_SKIP_REASONS } = require('../src/utils/email/engine');
const { loadOrderForEmail } = require('../src/utils/orderEmails');

const BATCH = parseInt(process.env.SCHEDULED_EMAIL_BATCH || '200', 10);

async function setting(key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM site_settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : fallback;
  } catch (err) { return fallback; }
}

// ---------------------------------------------------------------------------
// 1. Back in stock
// ---------------------------------------------------------------------------
/**
 * Claims each waitlist row BEFORE sending, by stamping notified_at inside the
 * same UPDATE that selects it. Two overlapping cron runs therefore cannot both
 * claim the same row, and a crash after the claim loses one email rather than
 * sending a hundred people the same message twice.
 *
 * Erring towards "might not send" over "might send twice" is deliberate here:
 * the customer asked for exactly one email about exactly one product.
 */
async function runBackInStock() {
  const { rows } = await db.query(
    `WITH claimed AS (
       SELECT sn.id
         FROM stock_notifications sn
         JOIN products p ON p.id = sn.product_id
         LEFT JOIN product_variants v ON v.id = sn.variant_id
        WHERE sn.notified_at IS NULL
          AND p.is_active = true
          AND CASE WHEN sn.variant_id IS NULL
                   THEN p.stock_qty > 0
                   ELSE v.stock_qty > 0 AND v.is_active = true END
        ORDER BY sn.created_at
        LIMIT $1
        FOR UPDATE OF sn SKIP LOCKED
     )
     UPDATE stock_notifications sn
        SET notified_at = now()
       FROM claimed c, products p
      WHERE sn.id = c.id AND p.id = sn.product_id
      RETURNING sn.id, sn.email, sn.variant_id, p.name AS product_name, p.slug`,
    [BATCH]
  );

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    let variantLabel = null;
    if (row.variant_id) {
      try {
        const { rows: v } = await db.query('SELECT sku FROM product_variants WHERE id = $1', [row.variant_id]);
        variantLabel = v.length ? v[0].sku : null;
      } catch (err) { /* label is cosmetic */ }
    }
    const res = await sendBackInStock({
      email: row.email,
      productName: row.product_name,
      productSlug: row.slug,
      variantLabel,
      notificationId: row.id
    });
    if (res.sent) { sent++; continue; }

    // The UPDATE above claims the row BEFORE the send, which is what stops two
    // concurrent runs mailing the same person twice. The cost is that a failed
    // send would otherwise stay marked as notified forever: the admin console
    // shows it delivered, this job exits 0, and a customer who explicitly asked
    // to be told about this product is never told. Releasing the claim on a
    // retryable failure is what makes the claim-then-send pattern safe.
    //
    // A duplicate re-send is a far smaller harm than a promise silently dropped,
    // so anything not in TERMINAL_SKIP_REASONS is retried on the next run.
    //
    // THE RETRY IS DELIBERATELY UNBOUNDED, and that is a judgement call worth
    // knowing about. An address that fails permanently would be retried every
    // ten minutes forever, growing email_log and holding this job's exit code at
    // 1 — and a job that is always red is a job nobody reads.
    //
    // It is left unbounded because the realistic failures here are all transient
    // and self-healing: a provider outage, a network blip, or the daily sending
    // quota, each of which SHOULD keep retrying until it clears. Permanent
    // failures are rare by construction — the capture endpoint validates the
    // address with isEmail(), and a relay like Brevo accepts a valid-but-dead
    // mailbox at SMTP time and bounces it asynchronously, so this code sees a
    // success rather than an error.
    //
    // Revisit if `npm run email:log -- --failed` ever shows the same recipient
    // and template failing repeatedly over days. The fix then is a retry cap
    // counted from email_log, not removing the retry.
    if (TERMINAL_SKIP_REASONS.has(res.reason)) continue;

    failed++;
    try {
      await db.query('UPDATE stock_notifications SET notified_at = NULL WHERE id = $1', [row.id]);
      logger.warn('Back-in-stock send failed; claim released for retry', {
        notificationId: row.id, reason: res.reason
      });
    } catch (err) {
      // If the release itself fails the notification IS stranded. Say so
      // explicitly — this is the one case where a customer silently loses out.
      logger.error('Back-in-stock send failed AND the claim could not be released — this notification is now stranded', err, {
        notificationId: row.id, reason: res.reason
      });
    }
  }
  return { considered: rows.length, sent, failed };
}

// ---------------------------------------------------------------------------
// 2. Booking reminders
// ---------------------------------------------------------------------------
/**
 * A puja or consultation is an appointment with a practitioner who has blocked
 * out real time. A no-show costs the business a slot it could have sold and
 * costs the customer the fee.
 *
 * Dates are compared in IST, not the server's UTC clock — the same BIZ-06 bug
 * that once accepted yesterday's bookings would otherwise send tomorrow's
 * reminder a day early for anyone booked before 05:30.
 */
async function runBookingReminders() {
  const hours = parseInt(await setting('booking_reminder_hours_before', '24'), 10);
  let sent = 0;
  // No claim to release here: this job selects by date rather than marking rows,
  // and sendMail's dedupeKey is what prevents a second reminder. So a failure
  // only needs counting — the next run will pick the booking up again by itself.
  let failed = 0;

  for (const [table, label] of [['puja_bookings', 'puja'], ['astrology_bookings', 'astrology consultation']]) {
    const { rows } = await db.query(
      `SELECT b.id, b.contact_name, b.preferred_date, b.preferred_time_slot,
              COALESCE(u.email, b.contact_email) AS email
         FROM ${table} b
         LEFT JOIN users u ON u.id = b.user_id
        WHERE b.status = 'confirmed'
          AND b.preferred_date = ((now() AT TIME ZONE 'Asia/Kolkata')::date + ($1 || ' hours')::interval)::date
        LIMIT $2`,
      [String(hours), BATCH]
    ).catch(async (err) => {
      // Older schemas have no contact_email column on bookings; fall back to
      // the account address rather than failing the whole job.
      if (!/contact_email/.test(err.message)) throw err;
      return db.query(
        `SELECT b.id, b.contact_name, b.preferred_date, b.preferred_time_slot, u.email
           FROM ${table} b JOIN users u ON u.id = b.user_id
          WHERE b.status = 'confirmed'
            AND b.preferred_date = ((now() AT TIME ZONE 'Asia/Kolkata')::date + ($1 || ' hours')::interval)::date
          LIMIT $2`,
        [String(hours), BATCH]
      );
    });

    for (const b of rows) {
      if (!b.email) continue;
      const res = await sendBookingReminder({
        email: b.email,
        name: b.contact_name,
        type: label,
        preferredDate: b.preferred_date,
        preferredTimeSlot: b.preferred_time_slot,
        bookingId: b.id
      });
      if (res.sent) sent++;
      else if (!TERMINAL_SKIP_REASONS.has(res.reason)) failed++;
    }
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// 3. Abandoned checkout
// ---------------------------------------------------------------------------
/**
 * One email per abandoned order, sent in the window between "they have clearly
 * stopped" and "the sweep is about to cancel this and return the stock".
 *
 * The recovery_email_sent_at stamp is claimed before sending for the same
 * reason as the waitlist: this job sees the same pending order every fifteen
 * minutes until the sweep clears it.
 *
 * Marketing category, so it honours opt-out and carries an unsubscribe link.
 * Someone who never asked to hear from us does not receive this at all.
 */
async function runAbandonedCheckout() {
  const after = parseInt(await setting('abandoned_cart_email_after_minutes', '20'), 10);
  const { rows } = await db.query(
    `UPDATE orders o
        SET recovery_email_sent_at = now()
      WHERE o.id IN (
        SELECT id FROM orders
         WHERE status = 'pending'
           AND recovery_email_sent_at IS NULL
           AND created_at < now() - ($1 || ' minutes')::interval
           AND user_id IS NOT NULL
         ORDER BY created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING o.id`,
    [String(after), BATCH]
  );

  let sent = 0;
  let failed = 0;
  for (const { id } of rows) {
    const forEmail = await loadOrderForEmail(id);
    if (!forEmail) continue;
    const res = await sendAbandonedCheckout(forEmail.order, forEmail.items);
    if (res.sent) { sent++; continue; }
    if (TERMINAL_SKIP_REASONS.has(res.reason)) continue;

    // Same claim-then-send trade as the back-in-stock job above: the marker is
    // written before the send so the ten-minutely sweep cannot mail the same
    // order repeatedly. Releasing it on a retryable failure is what stops a
    // transient SMTP error from permanently consuming the single recovery email
    // this order will ever get.
    failed++;
    try {
      await db.query('UPDATE orders SET recovery_email_sent_at = NULL WHERE id = $1', [id]);
      logger.warn('Abandoned-checkout send failed; marker cleared for retry', { orderId: id, reason: res.reason });
    } catch (err) {
      logger.error('Abandoned-checkout send failed AND the marker could not be cleared — no recovery email will be sent for this order', err, {
        orderId: id, reason: res.reason
      });
    }
  }
  return { claimed: rows.length, sent, failed };
}

// ---------------------------------------------------------------------------
// 4. Abandoned booking
// ---------------------------------------------------------------------------
/**
 * One email per unpaid booking, for BOTH booking types.
 *
 * A booking row is created before it is paid for, so closing the tab at the
 * payment step leaves it sitting there unconfirmed. The order path has had a
 * recovery email for a while; the booking path — the more expensive purchase of
 * the two — had nothing.
 *
 * Claim-then-send, exactly as the two jobs above do it. This runs every fifteen
 * minutes and would otherwise see the same unpaid booking on every tick; the
 * stamp is written inside the same UPDATE that selects the row, under FOR
 * UPDATE SKIP LOCKED, and cleared again if the send fails for a retryable
 * reason so a transient SMTP error does not permanently consume the single
 * email this booking will ever get.
 *
 * Both tables are handled by the same code path. Two near-identical loops is
 * how puja and astrology quietly stop behaving the same way.
 */
async function runAbandonedBookings() {
  const after = parseInt(await setting('abandoned_cart_email_after_minutes', '20'), 10);
  let claimed = 0;
  let sent = 0;
  let failed = 0;

  for (const [table, typeLabel] of [['puja_bookings', 'puja'], ['astrology_bookings', 'astrology']]) {
    // Table name comes from this literal pair, never from input.
    const { rows } = await db.query(
      `UPDATE ${table} b
          SET recovery_email_sent_at = now()
        WHERE b.id IN (
          SELECT id FROM ${table}
           WHERE payment_status = 'unpaid'
             AND recovery_email_sent_at IS NULL
             AND created_at < now() - ($1 || ' minutes')::interval
             AND user_id IS NOT NULL
           ORDER BY created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING b.id, b.contact_name, b.preferred_date, b.amount_paise, b.user_id`,
      [String(after), BATCH]
    );
    claimed += rows.length;

    for (const b of rows) {
      // The booking tables hold a contact name and phone but no email, so the
      // address is the account's.
      const { rows: userRows } = await db.query('SELECT email, name FROM users WHERE id = $1', [b.user_id]);
      if (!userRows.length) continue;

      const res = await sendBookingAbandoned({
        email: userRows[0].email,
        name: b.contact_name || userRows[0].name,
        type: typeLabel,
        bookingId: b.id,
        preferredDate: b.preferred_date,
        amountPaise: Number(b.amount_paise)
      });
      if (res && res.sent) { sent++; continue; }
      if (res && TERMINAL_SKIP_REASONS.has(res.reason)) continue;

      failed++;
      try {
        await db.query(`UPDATE ${table} SET recovery_email_sent_at = NULL WHERE id = $1`, [b.id]);
        logger.warn('Abandoned-booking send failed; marker cleared for retry', { bookingId: b.id, table, reason: res && res.reason });
      } catch (err) {
        logger.error('Abandoned-booking send failed AND the marker could not be cleared — no recovery email will be sent for this booking', err, {
          bookingId: b.id, table, reason: res && res.reason
        });
      }
    }
  }
  return { claimed, sent, failed };
}

// ---------------------------------------------------------------------------
// 5. Daily digest
// ---------------------------------------------------------------------------
/**
 * One email a day covering yesterday. The dedupe key is the date, so this runs
 * on every fifteen-minute tick and sends exactly once — no separate schedule to
 * keep in step, and no missed day if a run fails at 06:00 and succeeds at 06:15.
 *
 * DIGEST_HOUR_IST decides when: before that hour, yesterday's numbers are not
 * final enough to be worth reading.
 */
async function runDailyDigest() {
  const hourIst = parseInt(process.env.DIGEST_HOUR_IST || '8', 10);
  const nowIst = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  if (nowIst.getUTCHours() < hourIst) return { skipped: 'too_early' };

  const q = async (sql, params) => {
    try { const { rows } = await db.query(sql, params || []); return rows[0]; }
    catch (err) { return {}; }
  };

  const day = "(now() AT TIME ZONE 'Asia/Kolkata')::date - 1";
  const orders = await q(
    `SELECT count(*)::int AS n, COALESCE(SUM(total_paise),0)::bigint AS revenue
       FROM orders
      WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}
        AND status NOT IN ('payment_failed','cancelled')`);
  const customers = await q(
    `SELECT count(*)::int AS n FROM users
      WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${day} AND role = 'customer'`);
  const bookings = await q(
    `SELECT (SELECT count(*) FROM puja_bookings WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${day})
          + (SELECT count(*) FROM astrology_bookings WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${day}) AS n`);
  const review = await q("SELECT count(*)::int AS n FROM orders WHERE status = 'payment_review'");
  const messages = await q("SELECT count(*)::int AS n FROM contact_messages WHERE status = 'new'");
  const pending = await q('SELECT count(*)::int AS n FROM product_reviews WHERE is_approved IS NOT TRUE');
  const lowStockThreshold = parseInt(await setting('low_stock_alert_threshold', '5'), 10);
  const low = await q('SELECT count(*)::int AS n FROM products WHERE is_active = true AND stock_qty <= $1', [lowStockThreshold]);
  const failed = await q("SELECT count(*)::int AS n FROM email_log WHERE status = 'failed' AND created_at > now() - interval '24 hours'");

  const res = await sendAdminDailyDigest({
    orders: Number(orders.n || 0),
    revenuePaise: Number(orders.revenue || 0),
    newCustomers: Number(customers.n || 0),
    bookings: Number(bookings.n || 0),
    paymentReview: Number(review.n || 0),
    unreadMessages: Number(messages.n || 0),
    pendingReviews: Number(pending.n || 0),
    lowStock: Number(low.n || 0),
    failedEmails: Number(failed.n || 0)
  });
  return {
    sent: res.sent === true,
    duplicate: res.duplicate === true,
    failed: (res.sent !== true && !TERMINAL_SKIP_REASONS.has(res.reason)) ? 1 : 0
  };
}

// ---------------------------------------------------------------------------
const JOBS = {
  stock: runBackInStock,
  reminders: runBookingReminders,
  abandoned: runAbandonedCheckout,
  bookingsAbandoned: runAbandonedBookings,
  digest: runDailyDigest
};

async function main() {
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(JOBS);
  if (only && !JOBS[only]) {
    console.error(`Unknown job "${only}". Valid: ${Object.keys(JOBS).join(', ')}`);
    process.exit(2);
  }

  // `crashed` counts jobs that threw; `sendFailures` counts individual emails
  // that did not go out for a retryable reason. Both must affect the exit code.
  //
  // Previously only a thrown job counted, so every send could fail and this
  // still exited 0 — the cron showed green, the admin console showed the
  // notifications delivered, and nobody learned that no mail had left the
  // building. A non-zero exit is the only signal a scheduler can act on, so it
  // has to mean "mail did not go out", not merely "the script reached the end".
  //
  // Deliberate skips (duplicate, suppressed, no consent, marketing off) are NOT
  // failures — see TERMINAL_SKIP_REASONS in email/engine.js. Counting those
  // would make the job permanently red and train everyone to ignore it.
  let crashed = 0;
  let sendFailures = 0;
  const summary = {};
  for (const name of names) {
    try {
      const result = await JOBS[name]();
      summary[name] = result;
      sendFailures += Number((result && result.failed) || 0);
    } catch (err) {
      crashed++;
      summary[name] = { error: err.message };
      logger.error(`Scheduled email job "${name}" failed`, err);
    }
  }
  const failures = crashed + sendFailures;
  if (sendFailures) {
    logger.error('Scheduled email run: some emails did not go out', null, {
      sendFailures, hint: 'Run `npm run email:log -- --failed` for the SMTP error behind each one.'
    });
  }
  logger.info('Scheduled email run complete', { summary });
  // Printed as well as logged: a cron log is the only place anyone looks after
  // the fact, and a structured line is easier to grep than a formatted one.
  console.log(JSON.stringify({ ok: failures === 0, summary }, null, 2));

  try { await db.pool.end(); } catch (err) { /* closing is best effort */ }
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Scheduled email run crashed', err);
    process.exit(1);
  });
}

/* Exported FROM the registry, never hand-listed beside it.

   runAbandonedBookings had ALREADY been missed here. It ran correctly in
   production, because main() iterates JOBS — but nothing could import it, so
   the one job added this cycle was the one job no test could reach. A list
   maintained next to the thing it describes is a list that drifts from it.

   Both naming conventions are derived: the registry keys (stock, reminders,
   abandoned, bookingsAbandoned, digest) and the function names
   (runBackInStock, ...), which db-integration.test.js imports. Adding a job to
   JOBS now exports it under both, automatically. */
module.exports = Object.assign(
  { JOBS },
  JOBS,
  Object.fromEntries(Object.values(JOBS).map((fn) => [fn.name, fn]))
);
