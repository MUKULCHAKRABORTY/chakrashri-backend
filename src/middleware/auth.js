const jwt = require('jsonwebtoken');

/**
 * Verifies the JWT sent in the Authorization: Bearer <token> header
 * and attaches the decoded payload to req.user.
 * This replaces the old front-end-only "hardcoded password" admin gate —
 * every protected route now checks a server-issued, signed token.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

/**
 * Restricts a route to specific roles, e.g. requireRole('admin').
 * Use AFTER requireAuth.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
