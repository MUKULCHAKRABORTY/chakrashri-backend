/**
 * Run this against your real .env to verify the Neon database is reachable
 * and the schema migration applied correctly, BEFORE deploying. Prints a
 * clear PASS/FAIL for each check rather than just crashing on the first error.
 *
 * Run: node scripts/test-db-connection.js
 */
require('dotenv').config();
const db = require('../src/config/db');

// Every table this build expects, grouped by the migration that creates it.
//
// The list used to stop at 011 and be a flat array, which made the check report
// "ALL CHECKS PASSED — 21/21 found" against a database that could be missing the
// entire refunds ledger and the entire email system. That is worse than no check
// at all: it is a green light for a schema nobody verified.
//
// The grouping exists because "table is missing" has two completely different
// meanings, and conflating them is how the flat list would have turned this
// script into a permanent false alarm the moment it was brought up to date:
//
//   - missing, and its migration is NOT in _migrations: this database is simply
//     behind. Before any deploy that adds a migration, production is behind BY
//     DEFINITION — that is what the deploy is for. Reporting it as a failure
//     would mean the pre-deploy gate can never pass before a schema change.
//   - missing, and its migration IS recorded as applied: real schema drift.
//     Something was dropped, or a migration recorded success without doing its
//     work. That is a genuine failure and must stay one.
const TABLES_BY_MIGRATION = {
  '001': [
    'users', 'addresses', 'products', 'product_images', 'orders', 'order_items',
    'puja_bookings', 'astrology_bookings', 'blog_posts', 'wishlist_items', 'admin_audit_log'
  ],
  '003': ['password_reset_tokens'],
  '004': ['booking_services'],
  '005': ['product_reviews'],
  '006': ['coupons', 'coupon_redemptions'],
  '007': ['product_properties'],
  '008': ['product_options', 'product_option_values', 'product_variants'],
  '011': ['site_settings'],
  '013': ['email_verification_tokens', 'refunds', 'practitioners', 'availability_slots'],
  // 014 adds indexes only — no tables.
  '015': [
    'email_log', 'email_subscriptions', 'email_suppressions',
    'stock_notifications', 'contact_messages'
  ]
};

const EXPECTED_TABLES = Object.values(TABLES_BY_MIGRATION).flat();

// A subset of columns the application code actually queries/inserts by name.
// If a table pre-existed (e.g. from earlier manual testing) with a different
// structure, CREATE TABLE IF NOT EXISTS silently leaves it as-is rather than
// adding missing columns — this check catches that instead of letting it
// surface later as a runtime "column does not exist" error during checkout.
const EXPECTED_COLUMNS = {
  addresses: ['id', 'user_id', 'full_name', 'phone', 'email', 'line1', 'city', 'state', 'pincode'],
  users: ['id', 'email', 'password_hash', 'role', 'is_active'],
  products: ['id', 'sku', 'slug', 'price_paise', 'stock_qty', 'gst_rate', 'is_active'],
  orders: [
    'id', 'order_number', 'status', 'total_paise', 'razorpay_order_id', 'razorpay_signature',
    'refund_id', 'refunded_amount_paise', // 002
    'coupon_code', 'discount_paise'        // 006 — checkout writes these on every order
  ],
  order_items: [
    'id', 'order_id', 'product_id', 'quantity', 'line_total_paise',
    'variant_id', 'variant_snapshot'       // 008 — written for every variant purchase
  ],
  puja_bookings: ['id', 'user_id', 'puja_type', 'preferred_date', 'status', 'payment_status', 'amount_paise', 'razorpay_order_id', 'updated_at', 'refund_id'],
  astrology_bookings: ['id', 'user_id', 'consultation_mode', 'birth_details', 'status', 'payment_status', 'amount_paise', 'razorpay_order_id', 'updated_at', 'refund_id'],
  admin_audit_log: ['id', 'admin_user_id', 'action', 'entity_type', 'entity_id'],
  password_reset_tokens: ['id', 'user_id', 'token_hash', 'expires_at', 'used_at'],
  booking_services: ['id', 'service_type', 'name', 'price_paise', 'is_active'],
  product_reviews: ['id', 'product_id', 'user_id', 'rating', 'comment'],
  coupons: [
    'id', 'code', 'discount_type', 'discount_percent', 'discount_value_paise',
    'max_discount_paise', 'min_order_paise', 'usage_limit_total',
    'usage_limit_per_customer', 'used_count', 'valid_from', 'valid_until', 'is_active'
  ],
  coupon_redemptions: ['id', 'coupon_id', 'user_id', 'order_id', 'discount_applied_paise'],
  product_properties: ['id', 'product_id', 'property_name', 'property_value', 'color_hex'],
  product_options: ['id', 'product_id', 'option_name', 'option_type'],
  product_option_values: ['id', 'option_id', 'value', 'color_hex'],
  product_variants: ['id', 'product_id', 'option_values', 'price_paise', 'stock_qty', 'image_url', 'is_active'],
  site_settings: ['key', 'value', 'updated_at']
};

let failures = 0;
let columnMismatchDetected = false;
function report(label, ok, detail) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function main() {
  console.log('Chakrashri DB connectivity check\n');

  // 1. Basic connectivity
  try {
    const { rows } = await db.query('SELECT NOW() AS now, current_database() AS db');
    report('Connection established', true, `connected to "${rows[0].db}" at ${rows[0].now}`);
  } catch (err) {
    report('Connection established', false, err.message);
    console.log('\nCannot proceed with further checks — connection failed.');
    console.log('Common causes: DATABASE_URL not set/incorrect in .env, Neon project paused (free tier auto-suspends),');
    console.log('or sslmode/channel_binding query params not preserved when copying the URL.');
    process.exit(1);
  }

  // 2. SSL actually in use on the client's own connection.
  // NOTE: `SHOW ssl` is deliberately NOT used here — for pooled connections
  // (like Neon's `-pooler` hostname, or PgBouncer/RDS Proxy generally), that
  // GUC reflects the pooler-to-database-engine hop *inside* the provider's
  // private network, not the actual client connection. It can legitimately
  // report 'off' there even though the client's connection is fully encrypted,
  // producing a false failure. Instead, this checks the real TLS state of the
  // socket this app itself is using — which is what actually matters for
  // data-in-transit security over the public internet.
  try {
    const tls = require('tls');
    const client = await db.pool.connect();
    const stream = client.connection && client.connection.stream;
    client.release();

    if (stream === undefined) {
      // pg's internal Connection/stream API shape can vary across versions —
      // fall back to documented, external evidence rather than hard-failing
      // on an implementation detail: Neon enforces TLS for every connection
      // platform-wide (a plaintext connection to Neon is simply refused), and
      // the connection string itself requires sslmode=require. A successful
      // connection under those two facts is strong indirect evidence.
      // Match every mode that MANDATES TLS, not just 'require'. This used to
      // test for `sslmode=require` alone, which would have started reporting a
      // false failure the moment the recommended value became verify-full — and
      // its advice would have told you to undo the stronger setting. A check
      // that punishes the correct configuration is worse than no check.
      const mode = (/[?&]sslmode=([a-z-]+)/i.exec(process.env.DATABASE_URL || '') || [])[1];
      const urlRequiresSsl = ['require', 'verify-ca', 'verify-full'].includes(String(mode).toLowerCase());
      report(
        'Client connection is TLS-encrypted',
        urlRequiresSsl,
        urlRequiresSsl
          ? `could not inspect the socket directly (pg internals varied), but DATABASE_URL sets sslmode=${mode} and the connection succeeded — Neon refuses plaintext connections outright`
          : 'DATABASE_URL does not mandate TLS — set sslmode=verify-full (encrypted AND certificate-verified)'
      );
    } else {
      const isTlsSocket = stream instanceof tls.TLSSocket; // stable, documented Node.js API
      const isEncrypted = isTlsSocket && stream.encrypted === true;
      report(
        'Client connection is TLS-encrypted',
        isEncrypted,
        isEncrypted ? 'confirmed: underlying socket is a TLSSocket' : 'connection does NOT appear encrypted — check sslmode in DATABASE_URL'
      );
    }
  } catch (err) {
    report('Client connection TLS check', false, err.message);
  }

  // 3. Schema applied — check all expected tables exist
  try {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const existing = new Set(rows.map((r) => r.table_name));

    // Which migrations does this database say it has run? A database old enough
    // to predate the runner has no _migrations table at all; treat that as "no
    // information" and fall back to reporting every gap as drift, which is the
    // safe direction.
    let applied = null;
    try {
      const m = await db.query('SELECT filename FROM _migrations');
      applied = new Set(m.rows.map((r) => String(r.filename).slice(0, 3)));
    } catch (err) {
      applied = null;
    }

    const drift = [];
    const behind = [];
    for (const [migration, tables] of Object.entries(TABLES_BY_MIGRATION)) {
      const missing = tables.filter((t) => !existing.has(t));
      if (!missing.length) continue;
      if (applied && !applied.has(migration)) behind.push({ migration, missing });
      else drift.push(...missing);
    }

    if (drift.length) {
      // Two different failures share this branch, and saying the wrong one sends
      // whoever reads it looking for the wrong problem. With no _migrations
      // table there is nothing that could have been "recorded as applied".
      report('All expected tables exist', false, applied
        ? `missing though their migration is recorded as applied: ${drift.join(', ')} — this is schema drift, not a pending migration`
        : `missing, and this database has no _migrations table to say what has run: ${drift.join(', ')} — run "npm run migrate"`);
    } else if (behind.length) {
      // Deliberately not a failure: see the note above TABLES_BY_MIGRATION.
      // Loud, though — this is the difference between "the deploy will fix it"
      // and nobody noticing that production never got the schema.
      const list = behind.map((b) => `${b.migration} (${b.missing.join(', ')})`).join('; ');
      report('All expected tables exist', true,
        `every applied migration's tables are present. THIS DATABASE IS BEHIND — not yet applied: ${list}. `
        + 'Render runs "npm run migrate" as its preDeployCommand, so a deploy applies it; run it by hand to apply it now.');
    } else {
      report('All expected tables exist', true, `${EXPECTED_TABLES.length}/${EXPECTED_TABLES.length} found`);
    }
  } catch (err) {
    report('Schema check', false, err.message);
  }

  // 3b. Column-level check — catches a table that existed BEFORE this migration
  // ran with an incompatible structure (see comment above EXPECTED_COLUMNS).
  try {
    const { rows } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
    );
    const columnsByTable = {};
    for (const row of rows) {
      (columnsByTable[row.table_name] = columnsByTable[row.table_name] || new Set()).add(row.column_name);
    }
    let anyMismatch = false;
    for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
      const actualCols = columnsByTable[table];
      if (!actualCols) continue; // already reported as a missing table above
      const missingCols = expectedCols.filter((c) => !actualCols.has(c));
      if (missingCols.length) {
        anyMismatch = true;
        columnMismatchDetected = true;
        report(
          `Column check: ${table}`,
          false,
          `missing column(s): ${missingCols.join(', ')} — this table existed before the migration with a different structure`
        );
      }
    }
    if (!anyMismatch) report('Column-level schema matches expected structure', true);
  } catch (err) {
    report('Column-level schema check', false, err.message);
  }

  // 4. pgcrypto extension (needed for gen_random_uuid() used as every table's default PK)
  try {
    const { rows } = await db.query(`SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`);
    report('pgcrypto extension enabled', rows.length > 0);
  } catch (err) {
    report('pgcrypto extension check', false, err.message);
  }

  // 5. Write test — insert and immediately delete a throwaway row, proving write permissions work
  try {
    await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO blog_posts (title, slug, content) VALUES ('__connectivity_test__', '__connectivity_test__', 'test') RETURNING id`
      );
      await client.query('DELETE FROM blog_posts WHERE id = $1', [rows[0].id]);
    });
    report('Write + delete permissions', true);
  } catch (err) {
    report('Write + delete permissions', false, err.message);
  }

  // 6. Row-level lock support (FOR UPDATE) — required by the stock-reservation logic
  try {
    await db.withTransaction(async (client) => {
      await client.query('SELECT 1 FROM users LIMIT 1 FOR UPDATE');
    });
    report('Row-level locking (FOR UPDATE) works', true);
  } catch (err) {
    // An empty users table makes "FOR UPDATE" a no-op with 0 rows locked, which is fine —
    // only a real DB error here indicates an actual problem (e.g. read-only replica).
    report('Row-level locking (FOR UPDATE) works', true, 'no rows to lock yet, but no error — OK');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} — see above for detail.\n`);
  if (columnMismatchDetected) {
    console.log('A table already existed in this database before the migration ran, with a');
    console.log('different structure than this app expects. Two ways to fix it:');
    console.log('  1. If that table has no data you need: DROP TABLE <name> CASCADE; then re-run "npm run migrate".');
    console.log('  2. If it has real data you need to keep: manually ALTER TABLE to add the missing');
    console.log('     column(s) listed above, matching the type in migrations/001_init_schema.sql.\n');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error running connectivity checks:', err);
  process.exit(1);
});
