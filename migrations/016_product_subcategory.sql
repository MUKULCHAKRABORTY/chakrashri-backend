-- Chakrashri schema, migration 016
-- SUBCATEGORIES.
--
-- Model, and why this one:
--   Categories in this system are not rows in a table. They are free-form,
--   normalised text on the product (`products.category`), and every menu is
--   DERIVED by aggregating the products that use them (see
--   /api/products/meta/top-categories). A category springs into existence the
--   moment a product uses it and disappears when none do.
--
--   Subcategories follow exactly the same law, because a second law would be a
--   second thing to keep in step — and this file already carries the scars of
--   rules implemented twice. So: one more normalised text column, nullable,
--   normalised through the SAME utils/text.js normaliseTerm() the category
--   already uses, displayed through the same displayTerm().
--
--   The alternative — a `categories` table with parent_id — is what a very
--   large catalog eventually needs, and it buys two things this does not: a
--   subcategory that exists with no products in it, and per-subcategory
--   metadata (description, hero image, sort order). Neither is needed yet, and
--   adopting it now would mean backfilling live rows, building tree CRUD, and
--   rewiring every read path at once. When either of those is genuinely wanted,
--   promote this column to a table; the display layer already speaks the
--   "category/subcategory" path, so that migration is additive rather than a
--   rewrite.
--
-- NULLABLE on purpose. Every existing product has no subcategory and must keep
-- behaving exactly as it does today: unfiltered, unbroken, shown under its
-- category alone. A subcategory is a refinement, never a requirement.

ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory VARCHAR(80);

-- A subcategory is only ever meaningful UNDER a category, and every query that
-- reads one filters by category first ("show me the subcategories of books",
-- "show me books/scripture"). A composite index in that order serves both, and
-- also serves a category-only lookup as a prefix — so this does not duplicate
-- idx_products_category, it complements it.
CREATE INDEX IF NOT EXISTS idx_products_category_subcategory
  ON products(category, subcategory);

-- Normalised the same way the application normalises it, so a row written by a
-- script or by hand cannot enter in a shape the application would never
-- produce. normaliseTerm() lowercases, collapses whitespace and trims; an empty
-- result becomes NULL rather than ''.
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT chk_products_subcategory_normalised
    CHECK (
      subcategory IS NULL
      OR (subcategory = lower(subcategory)
          AND subcategory = btrim(subcategory)
          AND subcategory <> '')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Any pre-existing blank written before the constraint existed becomes NULL,
-- so "no subcategory" has exactly one representation rather than two.
UPDATE products SET subcategory = NULL WHERE subcategory IS NOT NULL AND btrim(subcategory) = '';
