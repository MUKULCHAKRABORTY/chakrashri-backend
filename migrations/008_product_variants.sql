-- Chakrashri schema, migration 008
-- Product VARIANTS — distinct from product_properties (migration 007, purely
-- informational display attributes like "Material: Brass"). A variant is a
-- specific PURCHASABLE combination (e.g. "Red / Medium") with its own SKU,
-- price, stock, and image — selecting one actually changes what the
-- customer is buying, which is why this needs real inventory tracking, not
-- just a label.
--
-- Model: a product has one or more OPTIONS (e.g. "Color", "Size"). Each
-- option has one or more VALUES (e.g. Color -> Red, Blue). A VARIANT is a
-- specific combination of one value per option, stored as JSONB on the
-- variant row itself rather than a separate junction table — this is a
-- deliberate, common simplification (avoids a 4th table + extra joins for
-- every read) that real systems use, while keeping the same guarantees:
-- independent stock/price/image per combination, and a frozen snapshot on
-- each order so historical orders stay accurate even if a variant is later
-- edited or removed.

CREATE TABLE IF NOT EXISTS product_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  option_name VARCHAR(60) NOT NULL,          -- e.g. "Color", "Size"
  option_type VARCHAR(20) NOT NULL DEFAULT 'text', -- 'text' | 'color' — 'color' drives the swatch UI
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE(product_id, option_name)
);

DO $$ BEGIN
  ALTER TABLE product_options ADD CONSTRAINT chk_product_options_type
    CHECK (option_type IN ('text','color'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS product_option_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  option_id UUID NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  value VARCHAR(80) NOT NULL,                -- e.g. "Red"
  color_hex VARCHAR(7),                      -- populated when the parent option's type = 'color'
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE(option_id, value)
);

DO $$ BEGIN
  ALTER TABLE product_option_values ADD CONSTRAINT chk_product_option_values_color_hex
    CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku VARCHAR(60),
  -- e.g. [{"option":"Color","value":"Red","colorHex":"#C9302C"},{"option":"Size","value":"Medium"}]
  option_values JSONB NOT NULL,
  price_paise BIGINT,                        -- NULL = inherit the product's base price_paise
  stock_qty INT NOT NULL DEFAULT 0,
  image_url TEXT,                            -- shown when this specific variant is selected
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);

DO $$ BEGIN
  ALTER TABLE product_variants ADD CONSTRAINT chk_product_variants_stock_nonneg
    CHECK (stock_qty >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE product_variants ADD CONSTRAINT chk_product_variants_price_positive
    CHECK (price_paise IS NULL OR price_paise > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- order_items needs to know WHICH variant (if any) was purchased, and a
-- frozen snapshot of its option values at purchase time — same principle as
-- product_name_snapshot: an order must remain historically accurate even if
-- the variant is edited or deleted afterward.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_snapshot JSONB;
