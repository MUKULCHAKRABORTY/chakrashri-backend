/**
 * The mailer's public surface.
 *
 * The implementation moved into ./email/ — engine.js decides whether a message
 * may go and records what happened, templates.js writes them. This file exists
 * so that move cost nothing: four route files and one test already import from
 * `utils/mailer`, and every name they use is still exported here with the same
 * signature. New code can import from either; there is one implementation
 * behind both.
 *
 * Adding an email? Write the template in ./email/templates.js and re-export it
 * below. Do not call nodemailer directly from a route — the consent check, the
 * suppression list, the dedupe key and the send log all live in the engine, and
 * a send that bypasses it bypasses all four.
 */
const engine = require('./email/engine');
const templates = require('./email/templates');

module.exports = {
  // ---- the engine -------------------------------------------------------
  sendMail: engine.sendMail,
  CATEGORY: engine.CATEGORY,
  renderShell: engine.renderShell,
  hasMarketingConsent: engine.hasMarketingConsent,
  isSuppressed: engine.isSuppressed,
  unsubscribeUrlFor: engine.unsubscribeUrlFor,
  resetTransporter: engine.resetTransporter,

  // ---- templates that existed before this change, signatures unchanged ---
  sendBookingPaymentReview: templates.sendBookingPaymentReview,
  sendBookingAbandoned: templates.sendBookingAbandoned,
  sendContactReply: templates.sendContactReply,
  sendOrderConfirmation: templates.sendOrderConfirmation,
  sendBookingConfirmation: templates.sendBookingConfirmation,
  sendPasswordResetEmail: templates.sendPasswordResetEmail,
  sendEmailVerification: templates.sendEmailVerification,
  sendOrderStatusUpdate: templates.sendOrderStatusUpdate,
  sendBookingStatusUpdate: templates.sendBookingStatusUpdate,

  // ---- new: account -----------------------------------------------------
  sendWelcome: templates.sendWelcome,
  sendPasswordChanged: templates.sendPasswordChanged,

  // ---- new: orders and money -------------------------------------------
  sendPaymentFailed: templates.sendPaymentFailed,
  sendPaymentUnderReview: templates.sendPaymentUnderReview,
  sendRefundInitiated: templates.sendRefundInitiated,
  sendOrderInvoice: templates.sendOrderInvoice,
  sendAbandonedCheckout: templates.sendAbandonedCheckout,

  // ---- new: bookings ----------------------------------------------------
  sendBookingReminder: templates.sendBookingReminder,

  // ---- new: catalog and engagement -------------------------------------
  sendBackInStock: templates.sendBackInStock,
  sendReviewApproved: templates.sendReviewApproved,

  // ---- new: subscription ------------------------------------------------
  sendSubscriptionConfirm: templates.sendSubscriptionConfirm,
  sendSubscriptionWelcome: templates.sendSubscriptionWelcome,
  sendNewsletter: templates.sendNewsletter,

  // ---- new: operational alerts to our own team -------------------------
  sendAdminNewOrder: templates.sendAdminNewOrder,
  sendAdminPaymentReview: templates.sendAdminPaymentReview,
  sendAdminLowStock: templates.sendAdminLowStock,
  sendAdminRefundIssued: templates.sendAdminRefundIssued,
  sendAdminDailyDigest: templates.sendAdminDailyDigest,
  adminRecipient: templates.adminRecipient,

  // ---- exported for tests ----------------------------------------------
  // test/security.test.js [sec-7] imports these two by name and proves the
  // escaping actually escapes by running it, rather than by reading it.
  esc: engine.esc,
  safeUrl: engine.safeUrl,
  formatRupees: engine.formatRupees
};
