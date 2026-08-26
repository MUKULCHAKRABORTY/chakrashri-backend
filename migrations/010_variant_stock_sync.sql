-- Chakrashri schema, migration 010
-- VARIANT STOCK ARCHITECTURE
--
-- Rule: for a product that has variants, its total stock IS the sum of its
-- active variants' stock. Nothing else is a valid source of truth.
--
-- This is enforced with a database TRIGGER rather than application code, on
-- purpose. Application-level recomputation only holds if every code path
-- remembers to do it — a future endpoint, a manual SQL fix, or an admin bulk
-- edit could silently desync it, and a desynced stock number is exactly the
-- kind of bug that oversells and costs the seller money. A trigger makes the
-- invariant impossible to violate from any direction.

CREATE OR REPLACE FUNCTION sync_product_stock_from_variants() RETURNS TRIGGER AS $$
DECLARE
  target_product UUID;
BEGIN
  -- On DELETE, NEW is null; on INSERT, OLD is null.
  target_product := COALESCE(NEW.product_id, OLD.product_id);

  UPDATE products p
  SET stock_qty = COALESCE((
        SELECT SUM(v.stock_qty)
        FROM product_variants v
        WHERE v.product_id = target_product AND v.is_active = true
      ), 0),
      updated_at = now()
  WHERE p.id = target_product
    -- Only take over the stock number for products that actually have
    -- variants. If the last variant is removed, the product keeps whatever
    -- the sum was (0) and the admin can manage it directly again.
    AND EXISTS (SELECT 1 FROM product_variants v2 WHERE v2.product_id = target_product);

  RETURN NULL; -- AFTER trigger; return value is ignored
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_product_stock ON product_variants;
CREATE TRIGGER trg_sync_product_stock
AFTER INSERT OR UPDATE OR DELETE ON product_variants
FOR EACH ROW EXECUTE FUNCTION sync_product_stock_from_variants();

-- Backfill: bring every existing product with variants into line immediately,
-- so the invariant holds for data created before this migration ran.
UPDATE products p
SET stock_qty = COALESCE((
      SELECT SUM(v.stock_qty)
      FROM product_variants v
      WHERE v.product_id = p.id AND v.is_active = true
    ), 0)
WHERE EXISTS (SELECT 1 FROM product_variants v2 WHERE v2.product_id = p.id);
