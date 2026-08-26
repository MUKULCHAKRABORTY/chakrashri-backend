-- Chakrashri schema, migration 012
--
-- (A) TRIGGER FIX — #19
-- The original trigger only recalculated when the product still had at least
-- one variant row. That meant a HARD delete of the last variant left
-- products.stock_qty frozen at its final summed value instead of dropping to
-- 0 — stale stock that could be sold, i.e. a real oversell risk. The rule is
-- now unconditional: if a product has ANY variant rows it is variant-managed;
-- if it has none, its stock is explicitly reset to 0 rather than left stale,
-- and the admin sets it directly from then on.

CREATE OR REPLACE FUNCTION sync_product_stock_from_variants() RETURNS TRIGGER AS $$
DECLARE
  target_product UUID;
  variant_total  INT;
  any_variants   BOOLEAN;
BEGIN
  target_product := COALESCE(NEW.product_id, OLD.product_id);

  SELECT COALESCE(SUM(v.stock_qty) FILTER (WHERE v.is_active = true), 0),
         COUNT(*) > 0
    INTO variant_total, any_variants
    FROM product_variants v
   WHERE v.product_id = target_product;

  -- any_variants = false means the last variant row was just deleted. Setting
  -- stock to 0 (rather than leaving the old sum) is the safe direction: it can
  -- never cause an oversell, and the admin can immediately set a real number.
  UPDATE products
     SET stock_qty = CASE WHEN any_variants THEN variant_total ELSE 0 END,
         updated_at = now()
   WHERE id = target_product;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_product_stock ON product_variants;
CREATE TRIGGER trg_sync_product_stock
AFTER INSERT OR UPDATE OR DELETE ON product_variants
FOR EACH ROW EXECUTE FUNCTION sync_product_stock_from_variants();

-- Re-run the backfill so anything that drifted under the old trigger is
-- corrected immediately.
UPDATE products p
   SET stock_qty = COALESCE((
         SELECT SUM(v.stock_qty) FROM product_variants v
          WHERE v.product_id = p.id AND v.is_active = true), 0)
 WHERE EXISTS (SELECT 1 FROM product_variants v2 WHERE v2.product_id = p.id);


-- (B) CATEGORY / BADGE NORMALISATION — #21
-- Categories and badges were free-text, so "Malas", "malas" and " MALAS "
-- became three separate filter entries for what is obviously one category.
-- Everything is now stored lowercase and trimmed, with internal whitespace
-- collapsed; the UI title-cases it for display. This statement merges any
-- existing duplicates that were created before the rule existed.

UPDATE products
   SET category = lower(btrim(regexp_replace(category, '\s+', ' ', 'g')))
 WHERE category IS NOT NULL
   AND category <> lower(btrim(regexp_replace(category, '\s+', ' ', 'g')));

UPDATE products
   SET badge = lower(btrim(regexp_replace(badge, '\s+', ' ', 'g')))
 WHERE badge IS NOT NULL AND badge <> ''
   AND badge <> lower(btrim(regexp_replace(badge, '\s+', ' ', 'g')));

-- An empty-string badge and a NULL badge are the same thing to a human but
-- sort and filter differently — collapse them to NULL.
UPDATE products SET badge = NULL WHERE badge IS NOT NULL AND btrim(badge) = '';
