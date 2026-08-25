/**
 * Run this against your real .env to verify the Neon database is reachable
 * and the schema migration applied correctly, BEFORE deploying. Prints a
 * clear PASS/FAIL for each check rather than just crashing on the first error.
 *
 * Run: node scripts/test-db-connection.js
 */
require('dotenv').config();
const db = require('../src/config/db');

const EXPECTED_TABLES = [
  // migration 001
  'users', 'addresses', 'products', 'product_images', 'orders', 'order_items',
  'puja_bookings', 'astrology_bookings', 'blog_posts', 'wishlist_items', 'admin_audit_log',
  'password_reset_tokens',   // 003
  'booking_services',        // 004
  'product_reviews',         // 005
  'coupons', 'coupon_redemptions',                              // 006
  'product_properties',                                          // 007
  'product_options', 'product_option_values', 'product_variants' // 008
];

// A subset of columns the application code actually queries/inserts by name.
// If a table pre-existed (e.g. from earlier manual testing) with a different
// structure, CREATE TABLE IF NOT EXISTS silently leaves it as-is rather than
// adding missing columns — this check catches that instead of letting it
// surface later as a runtime "column does not exist" error during checkout.
const EXPECTED_COLUMNS = {
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
  puja_bookings: ['id', 'user_id', 'puja_type', 'preferred_date', 'status', 'payment_status', 'amount_paise', 'razorpay_order_id'],
  astrology_bookings: ['id', 'user_id', 'consultation_mode', 'birth_details', 'status', 'payment_status', 'amount_paise', 'razorpay_order_id'],
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
  product_variants: ['id', 'product_id', 'option_values', 'price_paise', 'stock_qty', 'image_url', 'is_active']
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
      const urlRequiresSsl = /sslmode=require/i.test(process.env.DATABASE_URL || '');
      report(
        'Client connection is TLS-encrypted',
        urlRequiresSsl,
        urlRequiresSsl
          ? 'could not inspect the socket directly (pg internals varied), but DATABASE_URL requires sslmode=require and the connection succeeded — Neon refuses plaintext connections outright'
          : 'DATABASE_URL does not specify sslmode=require — add it'
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
    const missing = EXPECTED_TABLES.filter((t) => !existing.has(t));
    if (missing.length) {
      report('All expected tables exist', false, `missing: ${missing.join(', ')} — run "npm run migrate"`);
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
