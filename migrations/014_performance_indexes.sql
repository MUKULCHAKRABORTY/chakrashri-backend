-- migrate:no-transaction
--
-- Chakrashri schema, migration 014 — PERF-01 and HYG-07.
--
-- WHY THIS FILE IS NOT TRANSACTIONAL
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Every other
-- migration runs inside BEGIN/COMMIT (which is what makes them atomic), so this
-- one carries the `-- migrate:no-transaction` directive on its first line and
-- scripts/run-migrations.js executes its statements outside a transaction.
--
-- The trade-off that buys: a plain CREATE INDEX takes an ACCESS EXCLUSIVE lock
-- on the table for the whole build, which on a live orders table means every
-- checkout blocks until it finishes. CONCURRENTLY does two passes and takes only
-- a SHARE UPDATE EXCLUSIVE lock, so the shop keeps trading while the index is
-- built. The cost is that a failed build leaves an INVALID index behind rather
-- than rolling back — recover with `DROP INDEX <name>;` and re-run.
--
-- WHY THESE INDEXES
-- With a few hundred rows Postgres sequential-scans faster than it index-scans,
-- so none of this shows in testing and stays invisible right up to the point it
-- isn't. At 1,000 orders/day the admin order list, the revenue chart and every
-- stock restore degrade simultaneously — during the first real sale, which is
-- when staff are watching the dashboard hardest.

-- ---------------------------------------------------------------------------
-- The single most important one. order_items has no index on order_id at all,
-- so EVERY order detail view, stock restore, confirmation email and expiry
-- sweep sequential-scans the entire line-item table.
-- ---------------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Analytics joins (top-products, category ranking) and review eligibility.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_items_product ON order_items(product_id);

-- Admin order list filters on status and always sorts by created_at DESC; the
-- composite serves both in one scan. The standalone created_at index serves the
-- unfiltered list and the revenue-by-day range scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- The expiry sweep and the reconciler both scan for pending orders. A partial
-- index is a fraction of the size of a full one because the interesting rows
-- are a tiny and self-limiting subset — pending orders are cleared every 30
-- minutes by design.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_pending_created
  ON orders(created_at) WHERE status = 'pending';

-- The shop grid runs a correlated subquery per product to fetch its first
-- image. sort_order is included so the ORDER BY inside that subquery is
-- satisfied by the index rather than a per-row sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_images_product
  ON product_images(product_id, sort_order);

-- Every address lookup is scoped by user_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_addresses_user ON addresses(user_id);

-- The audit log is always read newest-first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_created ON admin_audit_log(created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_entity ON admin_audit_log(entity_type, entity_id);

-- Customers reading their own bookings; staff filtering by status.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_puja_bookings_user ON puja_bookings(user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_astrology_bookings_user ON astrology_bookings(user_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_puja_bookings_status ON puja_bookings(status, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_astrology_bookings_status ON astrology_bookings(status, created_at DESC);

-- The booking expiry sweep, mirroring the orders one above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_puja_bookings_unpaid
  ON puja_bookings(created_at) WHERE payment_status = 'unpaid';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_astrology_bookings_unpaid
  ON astrology_bookings(created_at) WHERE payment_status = 'unpaid';

-- New tables from migration 013.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refunds_entity ON refunds(entity_type, entity_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refunds_status ON refunds(status) WHERE status = 'initiated';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slots_lookup
  ON availability_slots(service_type, starts_at) WHERE is_active = true;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_slots_service ON availability_slots(service_id, starts_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_verification_hash ON email_verification_tokens(token_hash);

-- Public review listing filters on approval and sorts newest-first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_reviews_public
  ON product_reviews(product_id, created_at DESC) WHERE is_approved = true;

-- ---------------------------------------------------------------------------
-- HYG-07 — product search
-- ---------------------------------------------------------------------------
-- `name ILIKE '%term%'` cannot use a B-tree index at all: the leading wildcard
-- makes it non-sargable, so every search sequential-scans the product table and
-- applies the pattern row by row. pg_trgm's GIN index makes exactly this
-- pattern indexable, and as a bonus supports fuzzy matching for the misspelled
-- Sanskrit transliterations this catalog will receive constantly
-- ("rudraksh"/"rudraksha", "shivling"/"shivlingam").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_name_trgm
  ON products USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_sku_trgm
  ON products USING gin (sku gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Redundant index cleanup
-- ---------------------------------------------------------------------------
-- A UNIQUE constraint already creates a unique B-tree index on its column, so
-- these three duplicate an existing structure exactly: they cost write
-- throughput and disk on every insert and update while never being chosen by
-- the planner over the unique index.
DROP INDEX CONCURRENTLY IF EXISTS idx_users_email;
DROP INDEX CONCURRENTLY IF EXISTS idx_products_slug;
DROP INDEX CONCURRENTLY IF EXISTS idx_coupons_code;
