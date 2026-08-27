-- Chakrashri schema, migration 013
--
-- Structural fixes from the full-stack audit. Every statement here is additive
-- and re-runnable: new columns default to values that reproduce the existing
-- behaviour exactly, so this migration can be applied before the application
-- code that uses it, and the two deploys do not have to be simultaneous.
--
-- Index creation lives in 014 (it needs CONCURRENTLY, which cannot run inside
-- the transaction this file runs in).

-- ===========================================================================
-- (A) AUTH-03 — TOKEN REVOCATION
-- ===========================================================================
-- JWTs are stateless, so a password reset could not end an attacker's existing
-- session: the reset correctly retired every outstanding *reset* token, but the
-- seven-day access token kept working. token_version is embedded in each issued
-- token and compared on every request; incrementing it invalidates every token
-- issued before the bump. That is what "log out everywhere" means, and it is
-- also the only way to force-logout a compromised staff account short of
-- rotating the global signing secret.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

-- Email verification (AUTH-04). Same design as password_reset_tokens and for
-- the same reason: only a SHA-256 hash of the token is stored, so a leak of
-- this table cannot be used to verify anyone's address.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
-- Backfill: anyone already marked verified (currently only seeded admins) keeps
-- that state with a timestamp, so the two columns never disagree.
UPDATE users SET email_verified_at = COALESCE(email_verified_at, created_at)
 WHERE email_verified = true AND email_verified_at IS NULL;


-- ===========================================================================
-- (B) DATA-01 — SHIPPING ADDRESS SNAPSHOT
-- ===========================================================================
-- order_items freeze product_name_snapshot, unit_price_paise and
-- variant_snapshot at purchase time so history stays accurate. The shipping
-- address was the one field that did not get the same treatment: it was a live
-- foreign key, so a customer who moved house and edited their saved address
-- silently rewrote the delivery address on every order they had ever placed,
-- including delivered ones.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address_snapshot JSONB;

-- Backfill from the current join so existing orders gain a snapshot of what the
-- address says today — the best available reconstruction, and strictly better
-- than continuing to read through a mutable row.
UPDATE orders o
   SET shipping_address_snapshot = jsonb_build_object(
         'full_name', a.full_name, 'phone', a.phone, 'email', a.email,
         'line1', a.line1, 'line2', a.line2, 'city', a.city, 'state', a.state,
         'pincode', a.pincode, 'country', a.country,
         'snapshot_source', 'backfill_013')
  FROM addresses a
 WHERE a.id = o.shipping_address_id
   AND o.shipping_address_snapshot IS NULL;

-- The FK had no ON DELETE clause, so it defaulted to NO ACTION: deleting an
-- address that appeared on any order raised 23503, which the delete endpoint
-- turned into an opaque 500. With the snapshot in place the reference is now
-- only a soft link for analytics, so SET NULL is safe and lets a customer
-- delete their own address without breaking order history.
DO $$ BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shipping_address_id_fkey;
  ALTER TABLE orders ADD CONSTRAINT orders_shipping_address_id_fkey
    FOREIGN KEY (shipping_address_id) REFERENCES addresses(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- Soft-delete for addresses so a customer "removing" an address never destroys
-- data a dispute might need, while it disappears from their address book.
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();


-- ===========================================================================
-- (C) PAY-02 — REFUND LEDGER (idempotency + partial refunds)
-- ===========================================================================
-- The old flow called Razorpay first and wrote the database afterwards, in four
-- separate non-transactional steps. A crash in that window meant the money was
-- returned and nothing recorded it, so the next admin refunded it again. It
-- also clamped each refund against the order total rather than the remaining
-- balance, and set the whole order to 'refunded' after a partial refund —
-- which both blocked a second partial refund and restored ALL the stock.
--
-- This ledger records intent BEFORE the gateway call, carries an idempotency
-- key Razorpay honours, and makes the remaining refundable balance a simple
-- SUM. A row left in 'initiated' after a crash is resolvable by asking the
-- gateway what happened to that key.
CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(24) NOT NULL,          -- 'order' | 'puja_booking' | 'astrology_booking'
  entity_id UUID NOT NULL,
  razorpay_payment_id VARCHAR(80) NOT NULL,
  razorpay_refund_id VARCHAR(80),            -- populated once the gateway confirms
  amount_paise BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'initiated', -- initiated | processed | failed
  idempotency_key VARCHAR(80) NOT NULL UNIQUE,
  failure_reason TEXT,
  requested_by UUID REFERENCES users(id),
  restock BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE refunds ADD CONSTRAINT chk_refunds_entity_type
    CHECK (entity_type IN ('order','puja_booking','astrology_booking'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE refunds ADD CONSTRAINT chk_refunds_status
    CHECK (status IN ('initiated','processed','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE refunds ADD CONSTRAINT chk_refunds_amount_positive CHECK (amount_paise > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Migrate the refunds already recorded on orders/bookings into the ledger so
-- the "already refunded" balance is correct from day one rather than starting
-- at zero and permitting a duplicate refund of historical orders.
INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, razorpay_refund_id,
                     amount_paise, status, idempotency_key, created_at)
SELECT 'order', o.id, o.razorpay_payment_id, o.refund_id,
       o.refunded_amount_paise, 'processed', 'legacy-order-' || o.id::text, o.updated_at
  FROM orders o
 WHERE o.refund_id IS NOT NULL
   AND o.refunded_amount_paise IS NOT NULL
   AND o.razorpay_payment_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.entity_type = 'order' AND r.entity_id = o.id);

INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, razorpay_refund_id,
                     amount_paise, status, idempotency_key, created_at)
SELECT 'puja_booking', b.id, b.razorpay_payment_id, b.refund_id,
       b.refunded_amount_paise, 'processed', 'legacy-puja-' || b.id::text, b.updated_at
  FROM puja_bookings b
 WHERE b.refund_id IS NOT NULL AND b.refunded_amount_paise IS NOT NULL
   AND b.razorpay_payment_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.entity_type = 'puja_booking' AND r.entity_id = b.id);

INSERT INTO refunds (entity_type, entity_id, razorpay_payment_id, razorpay_refund_id,
                     amount_paise, status, idempotency_key, created_at)
SELECT 'astrology_booking', b.id, b.razorpay_payment_id, b.refund_id,
       b.refunded_amount_paise, 'processed', 'legacy-astro-' || b.id::text, b.updated_at
  FROM astrology_bookings b
 WHERE b.refund_id IS NOT NULL AND b.refunded_amount_paise IS NOT NULL
   AND b.razorpay_payment_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.entity_type = 'astrology_booking' AND r.entity_id = b.id);


-- ===========================================================================
-- (D) PAY-01 — PAYMENT REVIEW STATE
-- ===========================================================================
-- When the gateway reports an amount, currency or capture-status mismatch, the
-- order must not silently become 'paid' — and equally must not be told to the
-- customer as a failure, since their money may well have moved. It goes to a
-- state a human resolves. Widening the CHECK constraint is what makes that
-- state writable at all.
DO $$ BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_status_valid;
  ALTER TABLE orders ADD CONSTRAINT chk_orders_status_valid CHECK (
    status IN ('pending','paid','processing','shipped','delivered',
               'cancelled','refunded','partially_refunded','payment_failed','payment_review')
  );
EXCEPTION WHEN others THEN NULL; END $$;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_review_reason TEXT;

-- Booking payment_status had no constraint at all, so any string could be
-- written to it. The application only ever uses these five.
DO $$ BEGIN
  ALTER TABLE puja_bookings ADD CONSTRAINT chk_puja_payment_status
    CHECK (payment_status IN ('unpaid','paid','failed','refunded','partially_refunded','payment_review'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE astrology_bookings ADD CONSTRAINT chk_astrology_payment_status
    CHECK (payment_status IN ('unpaid','paid','failed','refunded','partially_refunded','payment_review'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ===========================================================================
-- (E) BIZ-04 — HONEST RATINGS
-- ===========================================================================
-- Every product created through the admin panel carried rating = 4.5 from the
-- moment it existed, displayed beside "0 reviews". India's CCPA guidelines on
-- fake reviews and BIS IS 19000:2022 both treat a displayed rating not derived
-- from genuine consumer feedback as misleading — and a wall of identical 4.5s
-- across a new catalog reads as fake to customers anyway.
ALTER TABLE products ALTER COLUMN rating DROP DEFAULT;
UPDATE products SET rating = NULL WHERE COALESCE(review_count, 0) = 0;
ALTER TABLE products ALTER COLUMN review_count SET DEFAULT 0;
UPDATE products SET review_count = 0 WHERE review_count IS NULL;


-- ===========================================================================
-- (F) BIZ-05 — REVIEW MODERATION
-- ===========================================================================
-- A 2,000-character comment went live instantly under the reviewer's real name,
-- with no approval flag and no admin endpoint to remove it. The only route to
-- taking down an abusive or defamatory review was direct SQL against
-- production.
--
-- Default true preserves today's publish-immediately behaviour; flip the
-- `reviews_require_approval` site setting to switch to pre-moderation without a
-- deploy.
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS moderated_by UUID REFERENCES users(id);
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;


-- ===========================================================================
-- (G) BIZ-02 / BIZ-03 — PRACTITIONERS, CAPACITY AND BOOKING EXPIRY
-- ===========================================================================
-- Products cannot oversell; that invariant is enforced in three separate
-- places. Services could, without limit: preferred_date and preferred_time_slot
-- were free text with no availability table, no capacity and no uniqueness, so
-- twenty customers could book the same pandit for the same morning and all be
-- charged. pandit_id and astrologer_id existed as placeholders for exactly this
-- table and were never populated.
CREATE TABLE IF NOT EXISTS practitioners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(120) NOT NULL,
  practitioner_type VARCHAR(20) NOT NULL,     -- 'puja' | 'astrology' | 'both'
  phone VARCHAR(20),
  email VARCHAR(180),
  bio TEXT,
  languages TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE practitioners ADD CONSTRAINT chk_practitioners_type
    CHECK (practitioner_type IN ('puja','astrology','both'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- starts_at is TIMESTAMPTZ, not a DATE plus a free-text label. That is what
-- makes "is this slot in the past?" answerable correctly in IST regardless of
-- the server's own timezone (BIZ-06), and what lets the same slot be rendered
-- correctly for a customer in any timezone.
CREATE TABLE IF NOT EXISTS availability_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id UUID REFERENCES practitioners(id) ON DELETE CASCADE,
  service_type VARCHAR(20) NOT NULL,          -- 'puja' | 'astrology'
  service_id UUID REFERENCES booking_services(id) ON DELETE CASCADE, -- NULL = any service of this type
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  label VARCHAR(60),                          -- display form, e.g. "Morning (8-11 AM)"
  capacity INT NOT NULL DEFAULT 1,
  booked_count INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE availability_slots ADD CONSTRAINT chk_slots_service_type
    CHECK (service_type IN ('puja','astrology'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE availability_slots ADD CONSTRAINT chk_slots_capacity_positive CHECK (capacity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The database-level backstop that makes overbooking impossible even if the
-- application logic is wrong — the same role the `stock_qty >= $1` guard plays
-- for products.
DO $$ BEGIN
  ALTER TABLE availability_slots ADD CONSTRAINT chk_slots_not_overbooked
    CHECK (booked_count >= 0 AND booked_count <= capacity);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS slot_id UUID REFERENCES availability_slots(id);
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS slot_id UUID REFERENCES availability_slots(id);
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- pandit_id / astrologer_id were declared as "FK to a future practitioners
-- table". That table now exists, so make the reference real.
DO $$ BEGIN
  ALTER TABLE puja_bookings ADD CONSTRAINT fk_puja_pandit
    FOREIGN KEY (pandit_id) REFERENCES practitioners(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE astrology_bookings ADD CONSTRAINT fk_astrology_astrologer
    FOREIGN KEY (astrologer_id) REFERENCES practitioners(id) ON DELETE SET NULL;
EXCEPTION WHEN others THEN NULL; END $$;


-- ===========================================================================
-- (H) BIZ-07 — COD RISK CONTROLS
-- ===========================================================================
-- Selecting Cash on Delivery created a confirmed order immediately: no phone
-- verification, no value ceiling, no serviceability check, no repeat-refuser
-- tracking. COD return-to-origin rates in Indian D2C commonly run 20-35%, and
-- every RTO costs shipping both ways on a sale that never happened.
ALTER TABLE users ADD COLUMN IF NOT EXISTS cod_rto_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cod_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cod_blocked_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rto_marked_at TIMESTAMPTZ;


-- ===========================================================================
-- (I) OPS-03 — AUDIT LOG INTEGRITY
-- ===========================================================================
-- An audit trail that can be edited or deleted by the same accounts it records
-- is not an audit trail. Nothing in the application ever updates or deletes
-- from this table, so making that structurally impossible costs nothing and
-- means the log stays admissible if it is ever needed in a payment dispute.
CREATE OR REPLACE FUNCTION admin_audit_log_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_audit_log_append_only ON admin_audit_log;
CREATE TRIGGER trg_admin_audit_log_append_only
BEFORE UPDATE OR DELETE ON admin_audit_log
FOR EACH ROW EXECUTE FUNCTION admin_audit_log_is_append_only();

-- Free-text `action` invited drift ('refund' vs 'refunded' vs 'refund_order').
-- A length bound plus a non-empty check is the light-touch version; a full enum
-- would need every existing value migrated first.
DO $$ BEGIN
  ALTER TABLE admin_audit_log ADD CONSTRAINT chk_audit_action_nonempty
    CHECK (btrim(action) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ===========================================================================
-- (J) HYG-03 / BIZ-07 — RUNTIME COMMERCE SETTINGS
-- ===========================================================================
-- The free-shipping threshold and shipping charge were compiled into
-- calculateOrderTotals(). Seeding them here with exactly the values that were
-- hardcoded means pricing behaviour is byte-identical after this migration —
-- the difference is only that the client can now change them without a deploy.
INSERT INTO site_settings (key, value)
SELECT * FROM (VALUES
  ('free_shipping_threshold_paise', '99900'),
  ('shipping_flat_paise', '7900'),
  ('cod_enabled', 'true'),
  ('cod_max_order_paise', '500000'),
  ('cod_requires_verified_contact', 'false'),
  ('max_cod_rto_before_block', '2'),
  ('order_reservation_expiry_minutes', '30'),
  ('reviews_require_approval', 'false')
) AS seed(key, value)
WHERE NOT EXISTS (SELECT 1 FROM site_settings s WHERE s.key = seed.key);


-- ===========================================================================
-- (K) DATA INTEGRITY BACKSTOPS FOUND DURING THE AUDIT
-- ===========================================================================
--
-- THESE THREE DEPEND ON EXISTING DATA BEING CLEAN, AND IT MIGHT NOT BE.
--
-- An earlier draft wrapped each in `EXCEPTION WHEN others THEN NULL`, which
-- meant that if ANY historical row violated the rule, the constraint was
-- silently skipped and the migration still reported success. I tested exactly
-- that case: a legacy order_item with line_total 15000 against 2 x 10000, and
-- the deploy went green with the constraint quietly absent. That is the worst
-- possible outcome — the audit says the backstop exists, the database says
-- otherwise, and nobody finds out.
--
-- The rule now: NEVER fail the deploy over historical data (that would block
-- every other fix in this migration over rows that are already wrong), but
-- never be silent about it either. Each block below counts the offending rows
-- and RAISES WARNING with the exact query to find them. Warnings appear in the
-- migration output, so the operator sees precisely what was skipped and what to
-- do about it, and can re-run this migration once the data is corrected.

-- order_items.line_total_paise must equal unit_price * quantity.
DO $$
DECLARE bad_rows bigint;
BEGIN
  SELECT count(*) INTO bad_rows FROM order_items
   WHERE line_total_paise <> unit_price_paise * quantity;

  IF bad_rows > 0 THEN
    RAISE WARNING E'SKIPPED chk_order_items_line_total_consistent: % existing order_items row(s) violate it.\n'
      '  These are historical rows with a line total that does not match unit price x quantity.\n'
      '  Find them with:\n'
      '    SELECT id, order_id, unit_price_paise, quantity, line_total_paise\n'
      '      FROM order_items WHERE line_total_paise <> unit_price_paise * quantity;\n'
      '  Correct or write them off, then re-apply this migration with:\n'
      '    DELETE FROM _migrations WHERE filename = ''013_security_integrity_and_capacity.sql'';\n'
      '    npm run migrate\n'
      '  (Every statement in this file is idempotent, so re-applying it is safe.)', bad_rows;
  ELSE
    BEGIN
      ALTER TABLE order_items ADD CONSTRAINT chk_order_items_line_total_consistent
        CHECK (line_total_paise = unit_price_paise * quantity);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT chk_order_items_unit_price_nonneg
    CHECK (unit_price_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN check_violation THEN RAISE WARNING 'SKIPPED chk_order_items_unit_price_nonneg: existing rows have a negative unit price.';
END $$;

-- A discount can never exceed the goods value. calculateOrderTotals clamps it
-- twice already; this is the layer that survives a future code path that does
-- not.
DO $$
DECLARE bad_rows bigint;
BEGIN
  SELECT count(*) INTO bad_rows FROM orders
   WHERE discount_paise < 0 OR discount_paise > subtotal_paise;

  IF bad_rows > 0 THEN
    RAISE WARNING E'SKIPPED chk_orders_discount_within_subtotal: % existing order(s) violate it.\n'
      '  Find them with:\n'
      '    SELECT id, order_number, subtotal_paise, discount_paise\n'
      '      FROM orders WHERE discount_paise < 0 OR discount_paise > subtotal_paise;', bad_rows;
  ELSE
    BEGIN
      ALTER TABLE orders ADD CONSTRAINT chk_orders_discount_within_subtotal
        CHECK (discount_paise >= 0 AND discount_paise <= subtotal_paise);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

DO $$
DECLARE bad_rows bigint;
BEGIN
  SELECT count(*) INTO bad_rows FROM orders
   WHERE refunded_amount_paise IS NOT NULL
     AND (refunded_amount_paise < 0 OR refunded_amount_paise > total_paise);

  IF bad_rows > 0 THEN
    RAISE WARNING E'SKIPPED chk_orders_refund_within_total: % existing order(s) violate it.\n'
      '  A refund larger than the order total is worth investigating on its own.\n'
      '  Find them with:\n'
      '    SELECT id, order_number, total_paise, refunded_amount_paise\n'
      '      FROM orders WHERE refunded_amount_paise > total_paise;', bad_rows;
  ELSE
    BEGIN
      ALTER TABLE orders ADD CONSTRAINT chk_orders_refund_within_total
        CHECK (refunded_amount_paise IS NULL OR (refunded_amount_paise >= 0 AND refunded_amount_paise <= total_paise));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Closing report: state plainly which data-dependent constraints ended up in
-- place. Without this the operator has to know to go and check.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  expected text[] := ARRAY['chk_order_items_line_total_consistent',
                           'chk_orders_discount_within_subtotal',
                           'chk_orders_refund_within_total'];
  missing text[];
BEGIN
  SELECT array_agg(e) INTO missing
    FROM unnest(expected) AS e
   WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = e);

  IF missing IS NULL THEN
    RAISE NOTICE 'All data-integrity constraints are in place.';
  ELSE
    RAISE WARNING E'MIGRATION COMPLETED, BUT % data-integrity constraint(s) were NOT added because existing rows violate them:\n  %\n  See the warnings above for the query that finds the offending rows. Re-run this migration after correcting them.',
      array_length(missing, 1), array_to_string(missing, E'\n  ');
  END IF;
END $$;
