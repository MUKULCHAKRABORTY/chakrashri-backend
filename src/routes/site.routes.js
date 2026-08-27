const express = require('express');
const db = require('../config/db');
const { requireAuth, requireCapability, CAPABILITIES: C } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { getSettings } = require('../utils/settings');
const { logger } = require('../utils/logger');

const router = express.Router();

// ---------- Public: current content version (polled by every visitor) ----------
// Deliberately tiny and unauthenticated: it's fetched on every page load, so it
// must be cheap. `Cache-Control: no-store` is essential — if this response were
// itself cached, the whole mechanism would be defeated.
//
// A short in-process cache absorbs the load without weakening that: the version
// is read from memory for a few seconds at a time, so a traffic spike does not
// turn into one database query per visitor per page view, while a cache-clear
// still reaches everyone within seconds.
let versionCache = null;
let versionCacheExpiresAt = 0;
const VERSION_CACHE_MS = parseInt(process.env.SITE_VERSION_CACHE_MS || '5000', 10);

router.get('/version', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const now = Date.now();
  if (versionCache && versionCacheExpiresAt > now) return res.json(versionCache);

  try {
    const { rows } = await db.query("SELECT value, updated_at FROM site_settings WHERE key = 'content_version'");
    versionCache = {
      version: rows.length ? rows[0].value : '1',
      updatedAt: rows.length ? rows[0].updated_at : null
    };
    versionCacheExpiresAt = now + VERSION_CACHE_MS;
    res.json(versionCache);
  } catch (err) {
    // Never fail the page over this — a missing version just means "no change".
    logger.warn('Site version lookup failed', { message: err.message });
    res.json(versionCache || { version: '1', updatedAt: null });
  }
}));

// ---------- Public: the storefront's commerce rules ----------
// HYG-03 — the free-shipping threshold and shipping charge used to be
// hardcoded in BOTH the backend pricing function and the storefront's cart
// summary, so changing one without the other silently showed the customer a
// total that did not match what they were charged. Publishing them from the
// single server-side source removes that whole class of disagreement.
router.get('/config', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    freeShippingThresholdPaise: settings.free_shipping_threshold_paise,
    shippingFlatPaise: settings.shipping_flat_paise,
    codEnabled: settings.cod_enabled,
    codMaxOrderPaise: settings.cod_max_order_paise,
    currency: 'INR'
  });
}));

// ---------- Admin: bump the version, forcing every visitor to refresh ----------
router.post('/clear-cache', requireAuth, requireCapability(C.SETTINGS_WRITE), asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `INSERT INTO site_settings (key, value, updated_at, updated_by)
     VALUES ('content_version', '2', now(), $1)
     ON CONFLICT (key) DO UPDATE
       SET value = (COALESCE(NULLIF(site_settings.value, '')::bigint, 1) + 1)::text,
           updated_at = now(),
           updated_by = $1
     RETURNING value`,
    [req.user.id]
  );

  // Drop the in-process cache immediately so the admin sees the effect at once
  // rather than up to VERSION_CACHE_MS later and wondering if it worked.
  versionCache = null;
  versionCacheExpiresAt = 0;

  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, detail)
     VALUES ($1, 'clear_site_cache', 'site_settings', $2)`,
    [req.user.id, JSON.stringify({ newVersion: rows[0].value })]
  );
  res.json({ version: rows[0].value });
}));

module.exports = router;
