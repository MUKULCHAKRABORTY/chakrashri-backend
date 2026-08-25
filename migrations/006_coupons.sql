-- Chakrashri schema, migration 006
-- Coupon system. Designed around one hard rule: a coupon's validity and
-- discount amount are NEVER trusted from the client — every field here
-- exists so the server can independently re-derive the discount at the
-- moment an order is actually created, inside the same transaction as
-- stock reservation, with the coupon row itself locked (SELECT ... FOR
-- UPDATE) so two concurrent checkouts can't both slip past a usage limit.

CREATE TABLE IF NOT EXISTS coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) UNIQUE NOT NULL,              -- always stored/matched uppercase
  description TEXT,
  discount_type VARCHAR(20) NOT NULL,            -- 'percentage' | 'fixed'
  discount_percent NUMERIC(5,2),                 -- e.g. 10.00 for 10% — used when discount_type = 'percentage'
  discount_value_paise BIGINT,                   -- flat amount off, in paise — used when discount_type = 'fixed'
  max_discount_paise BIGINT,                     -- optional cap for percentage coupons (e.g. "10% off up to ₹500")
  min_order_paise BIGINT NOT NULL DEFAULT 0,     -- minimum cart subtotal required to use this coupon
  usage_limit_total INT,                         -- NULL = unlimited total redemptions
  usage_limit_per_customer INT NOT NULL DEFAULT 1,
  used_count INT NOT NULL DEFAULT 0,             -- denormalized counter, only ever changed inside a locked transaction
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,                       -- NULL = no expiry
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);

DO $$ BEGIN
  ALTER TABLE coupons ADD CONSTRAINT chk_coupons_discount_type
    CHECK (discount_type IN ('percentage','fixed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE coupons ADD CONSTRAINT chk_coupons_percent_range
    CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE coupons ADD CONSTRAINT chk_coupons_fixed_positive
    CHECK (discount_value_paise IS NULL OR discount_value_paise > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- A coupon must define exactly the discount fields matching its own type —
  -- prevents a 'fixed' coupon accidentally carrying a leftover percent value
  -- (or vice versa) from ever being ambiguous about which one applies.
  ALTER TABLE coupons ADD CONSTRAINT chk_coupons_type_fields_match
    CHECK (
      (discount_type = 'percentage' AND discount_percent IS NOT NULL AND discount_value_paise IS NULL)
      OR
      (discount_type = 'fixed' AND discount_value_paise IS NOT NULL AND discount_percent IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every redemption, one row per successful use — this is the audit trail
-- that both the per-customer usage limit and the total usage limit are
-- actually counted from (used_count on `coupons` is a fast denormalized
-- cache of COUNT(*) here, kept in sync inside the same transaction).
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id UUID NOT NULL REFERENCES coupons(id),
  user_id UUID NOT NULL REFERENCES users(id),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  discount_applied_paise BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(user_id, coupon_id);

-- Record what coupon (if any) an order actually used, and how much it
-- discounted — needed for both customer-facing order display and for
-- reconciling revenue/reporting later.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(40);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_paise BIGINT NOT NULL DEFAULT 0;
