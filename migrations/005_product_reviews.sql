-- Chakrashri schema, migration 005
-- Product reviews, restricted to verified purchases: a customer can only
-- review a product they actually received (order status = 'delivered'),
-- not merely added to cart or paid for but not yet fulfilled. One review
-- per customer per product, enforced by the UNIQUE constraint below.

CREATE TABLE IF NOT EXISTS product_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  rating INT NOT NULL,
  comment TEXT,
  reviewer_name_snapshot VARCHAR(120), -- frozen at review time, so a later name change doesn't rewrite history
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_product_reviews_product ON product_reviews(product_id);

DO $$ BEGIN
  ALTER TABLE product_reviews ADD CONSTRAINT chk_product_reviews_rating
    CHECK (rating >= 1 AND rating <= 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
