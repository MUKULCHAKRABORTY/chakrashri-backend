const express = require('express');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- Public: current content version (polled by every visitor) ----------
// Deliberately tiny and unauthenticated: it's fetched on every page load, so
// it must be cheap. `Cache-Control: no-store` is essential — if this response
// were itself cached, the whole mechanism would be defeated.
router.get('/version', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const { rows } = await db.query("SELECT value, updated_at FROM site_settings WHERE key = 'content_version'");
    res.json({
      version: rows.length ? rows[0].value : '1',
      updatedAt: rows.length ? rows[0].updated_at : null
    });
  } catch (err) {
    // Never fail the page over this — a missing version just means "no change".
    res.json({ version: '1', updatedAt: null });
  }
});

// ---------- Admin: bump the version, forcing every visitor to refresh ----------
router.post('/clear-cache', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
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
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, detail)
       VALUES ($1, 'clear_site_cache', 'site_settings', $2)`,
      [req.user.id, JSON.stringify({ newVersion: rows[0].value })]
    );
    res.json({ version: rows[0].value });
  } catch (err) {
    console.error('[site] clear-cache failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not clear cache.', code: err.code || null });
  }
});

module.exports = router;
