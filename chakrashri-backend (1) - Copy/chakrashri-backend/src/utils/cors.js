/**
 * Normalizes an origin/URL string by stripping trailing slashes. Browser
 * Origin headers never include a trailing slash (they're always exactly
 * scheme://host[:port]), so a CLIENT_URL value with one — an easy
 * copy-paste mistake when setting an env var — would silently fail every
 * cross-origin request with no useful error beyond a generic CORS
 * rejection in the browser console. This is exactly what happened during
 * this project's own deployment.
 */
function normalizeOrigin(url) {
  return (url || '').replace(/\/+$/, '');
}

module.exports = { normalizeOrigin };
