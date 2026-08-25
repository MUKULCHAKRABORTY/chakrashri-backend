-- Chakrashri schema, migration 007
-- Arbitrary product properties (Color, Size, Material, or any admin-defined
-- name/value pair). Color gets special treatment: color_hex stores the
-- actual picked color so the storefront can render a real filled swatch
-- instead of guessing what color a name like "Maroon" or "Rudraksha Brown"
-- means.

CREATE TABLE IF NOT EXISTS product_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  property_name VARCHAR(60) NOT NULL,
  property_value VARCHAR(120) NOT NULL,
  color_hex VARCHAR(7),        -- e.g. '#C9302C' — only set when property_name is a color-type property
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_properties_product ON product_properties(product_id);

DO $$ BEGIN
  ALTER TABLE product_properties ADD CONSTRAINT chk_product_properties_color_hex
    CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
