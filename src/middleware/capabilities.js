/**
 * Capability-based authorization — closes AUTH-02.
 *
 * THE PROBLEM
 * admin.routes.js gated its entire surface with one line:
 *   router.use(requireAuth, requireRole('admin','staff'))
 * which meant a `staff` account could issue real Razorpay refunds, export the
 * full customer list with emails and phone numbers, and read the audit log
 * recording its own actions. The `role` column exists and is CHECK-constrained
 * to three values, so separation was clearly intended — it just was not
 * enforced anywhere.
 *
 * THE MODEL
 * Routes declare the capability they need, not the roles allowed. Roles map to
 * capabilities in exactly one place, below. Adding a role later (say
 * 'fulfilment' for a warehouse partner) is then a data change here rather than
 * a grep across twelve route files, and — more importantly — a new route
 * cannot accidentally inherit authority it was never meant to have, because it
 * has to name what it needs.
 *
 * WHAT DELIBERATELY STAYS SHARED
 * Staff keep everything needed to actually run the shop day to day: reading and
 * fulfilling orders, managing the catalog, handling bookings. What they lose is
 * the ability to move money, read bulk customer PII, read the audit trail, and
 * manage other accounts. That split follows the money and the personal data,
 * which is the line an auditor will draw too.
 */

const CAPABILITIES = Object.freeze({
  // --- Catalog -------------------------------------------------------------
  CATALOG_READ: 'catalog:read',
  CATALOG_WRITE: 'catalog:write',
  CATALOG_DELETE: 'catalog:delete',

  // --- Orders --------------------------------------------------------------
  ORDERS_READ: 'orders:read',
  ORDERS_FULFIL: 'orders:fulfil',     // processing / shipped / delivered, tracking numbers
  ORDERS_CANCEL: 'orders:cancel',     // cancel an order with no captured payment
  ORDERS_REFUND: 'orders:refund',     // real money leaves the merchant account

  // --- Bookings ------------------------------------------------------------
  BOOKINGS_READ: 'bookings:read',
  BOOKINGS_WRITE: 'bookings:write',
  BOOKINGS_REFUND: 'bookings:refund',
  BOOKINGS_READ_SENSITIVE: 'bookings:read_sensitive', // birth_details (DPDP)

  // --- Commerce config -----------------------------------------------------
  COUPONS_READ: 'coupons:read',
  COUPONS_WRITE: 'coupons:write',
  SETTINGS_WRITE: 'settings:write',

  // --- Customers & governance ---------------------------------------------
  CUSTOMERS_READ: 'customers:read',   // bulk PII export surface
  REVIEWS_MODERATE: 'reviews:moderate',
  AUDIT_READ: 'audit:read',
  ANALYTICS_READ: 'analytics:read'
});

const C = CAPABILITIES;

const STAFF_CAPABILITIES = [
  C.CATALOG_READ, C.CATALOG_WRITE,
  C.ORDERS_READ, C.ORDERS_FULFIL, C.ORDERS_CANCEL,
  C.BOOKINGS_READ, C.BOOKINGS_WRITE, C.BOOKINGS_READ_SENSITIVE,
  C.COUPONS_READ,
  C.ANALYTICS_READ
];

// Admin gets every capability. Spelled as "all of them" rather than a copied
// list so a newly added capability is never silently withheld from admins —
// the failure mode of a stale list is an admin locked out of a feature.
const ROLE_CAPABILITIES = Object.freeze({
  admin: Object.freeze(Object.values(C)),
  staff: Object.freeze(STAFF_CAPABILITIES),
  customer: Object.freeze([])
});

function capabilitiesForRole(role) {
  return ROLE_CAPABILITIES[role] || ROLE_CAPABILITIES.customer;
}

function roleHasCapability(role, capability) {
  return capabilitiesForRole(role).includes(capability);
}

/**
 * Route guard. Use AFTER requireAuth.
 *
 *   router.post('/orders/:id/refund', requireAuth, requireCapability(C.ORDERS_REFUND), handler)
 *
 * Passing several capabilities requires ALL of them, which is the safe default:
 * a route that both reads PII and moves money should need both grants.
 */
function requireCapability(...required) {
  if (!required.length) throw new Error('requireCapability called with no capability');
  return function capabilityGuard(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const granted = capabilitiesForRole(req.user.role);
    const missing = required.filter((cap) => !granted.includes(cap));
    if (missing.length) {
      return res.status(403).json({
        error: 'You do not have permission to perform this action.',
        // Naming the capability is safe (it is not a secret) and turns an
        // opaque 403 into something the client can act on — the admin UI uses
        // it to hide controls the signed-in user cannot use.
        requiredCapability: missing[0]
      });
    }
    return next();
  };
}

module.exports = {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  capabilitiesForRole,
  roleHasCapability,
  requireCapability
};
