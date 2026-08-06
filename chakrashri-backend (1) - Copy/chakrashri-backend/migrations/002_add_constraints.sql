-- Chakrashri schema, migration 002
-- Adds: (1) refund tracking columns needed by the admin refund fix, and
-- (2) CHECK constraints as a database-level backstop. Application code
-- already validates these (see products.routes.js, payments.routes.js),
-- but a schema-level constraint means that even a bug in application logic,
-- a direct SQL script, or a future developer who doesn't know the
-- application rules still cannot write invalid data — e.g. negative stock,
-- a negative price, or a status value the application doesn't recognize.
-- At 1000 orders/day, this is the difference between "a bug corrupts one
-- row" and "a bug corrupts the whole table before anyone notices."

-- ---------- Refund tracking (used by the admin refund endpoint) ----------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_id VARCHAR(80);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount_paise BIGINT;

-- ---------- Products ----------
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT chk_products_price_positive CHECK (price_paise > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT chk_products_mrp_positive CHECK (mrp_paise > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT chk_products_stock_nonnegative CHECK (stock_qty >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT chk_products_gst_rate_range CHECK (gst_rate >= 0 AND gst_rate <= 28);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Orders ----------
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT chk_orders_status_valid CHECK (
    status IN ('pending','paid','processing','shipped','delivered','cancelled','refunded','payment_failed')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT chk_orders_totals_nonnegative CHECK (
    subtotal_paise >= 0 AND shipping_paise >= 0 AND gst_paise >= 0 AND total_paise >= 0
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT chk_orders_payment_method_valid CHECK (payment_method IN ('razorpay','cod'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Order items ----------
DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Users ----------
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_role_valid CHECK (role IN ('customer','staff','admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Bookings ----------
DO $$ BEGIN
  ALTER TABLE puja_bookings ADD CONSTRAINT chk_puja_status_valid CHECK (
    status IN ('requested','confirmed','completed','cancelled')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE astrology_bookings ADD CONSTRAINT chk_astrology_status_valid CHECK (
    status IN ('requested','confirmed','completed','cancelled')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE astrology_bookings ADD CONSTRAINT chk_astrology_mode_valid CHECK (
    consultation_mode IN ('call','video','chat')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
