-- Chakrashri schema, migration 011
-- Site settings — currently holds the content version used for cache busting.
--
-- How the cache-clear works: the admin bumps `content_version`, every visitor's
-- browser notices the number changed on its next page load, clears its caches
-- and reloads once. This is a single shared counter rather than per-resource
-- cache headers, because the storefront is one static HTML file served by
-- Netlify — the practical problem is "a visitor is holding a stale copy of
-- index.html or stale product JSON", and a version handshake solves exactly
-- that without needing CDN purge APIs or build hooks.

CREATE TABLE IF NOT EXISTS site_settings (
  key VARCHAR(60) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id)
);

INSERT INTO site_settings (key, value)
SELECT 'content_version', '1'
WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE key = 'content_version');
