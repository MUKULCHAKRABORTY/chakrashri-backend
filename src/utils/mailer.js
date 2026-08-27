const nodemailer = require('nodemailer');
const { logger } = require('./logger');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null; // not configured yet — see .env.example
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    // Without these, a hung SMTP connection holds the Node socket open
    // indefinitely. Every caller treats mail as fire-and-forget, so a hang does
    // not block a response — but it does leak a socket per stuck send.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
  return transporter;
}

/**
 * HTML-escapes a value before it goes into an email body.
 *
 * WHY THIS IS NEEDED: every template below interpolated values straight into
 * HTML — `${order.customer_name}`, `${i.product_name_snapshot}`,
 * `${contact_name}`. Those come from public-facing forms. A customer who sets
 * their name to `<a href="http://phish.example">Click here</a>` gets that
 * rendered as real markup by every HTML mail client. The storefront and admin
 * console both escape rigorously (escapeHtml/esc); email was the one output
 * surface that did not, and it is the surface that leaves the building.
 */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes a URL for use in an href. Rejects anything that is not http(s) —
 * `javascript:` and `data:` URLs execute in some mail clients, and every URL in
 * these templates is built from CLIENT_URL, so a non-http value means a
 * misconfiguration rather than a legitimate case.
 */
function safeUrl(url) {
  const raw = String(url || '');
  if (!/^https?:\/\//i.test(raw)) return null;
  return esc(raw);
}

/**
 * Sends an email. Every call site treats a failure here as non-fatal — a
 * customer's order must still succeed even if, say, the SMTP provider is
 * briefly down. The error is logged (so it's visible in the logs and not
 * silently swallowed) rather than thrown.
 */
async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    logger.warn('SMTP not configured — email skipped', { subject });
    return { sent: false, reason: 'smtp_not_configured' };
  }
  try {
    await t.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject, html });
    logger.info('Email sent', { subject });
    return { sent: true };
  } catch (err) {
    // The recipient address is deliberately not logged — it is personal data,
    // and the subject plus the request id is enough to trace a failure.
    logger.error('Email delivery failed', err, { subject });
    return { sent: false, reason: err.message };
  }
}

function formatRupees(paise) {
  return `₹${(Number(paise) / 100).toFixed(2)}`;
}

const SHELL_STYLE = 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1a17;line-height:1.6;max-width:600px;';

async function sendOrderConfirmation(order, items) {
  const rows = items
    .map((i) => `<tr><td style="padding:6px 10px;border:1px solid #e5e0d8;">${esc(i.product_name_snapshot)}</td><td style="padding:6px 10px;border:1px solid #e5e0d8;">${esc(i.quantity)}</td><td style="padding:6px 10px;border:1px solid #e5e0d8;">${esc(formatRupees(i.line_total_paise))}</td></tr>`)
    .join('');
  return sendMail({
    to: order.customer_email,
    subject: `Order confirmed — ${order.order_number}`,
    html: `
      <div style="${SHELL_STYLE}">
        <h2>Thank you for your order, ${esc(order.customer_name || '')}!</h2>
        <p>Order <strong>${esc(order.order_number)}</strong> is confirmed.</p>
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr><th style="padding:6px 10px;border:1px solid #e5e0d8;text-align:left;">Item</th><th style="padding:6px 10px;border:1px solid #e5e0d8;text-align:left;">Qty</th><th style="padding:6px 10px;border:1px solid #e5e0d8;text-align:left;">Total</th></tr>
          ${rows}
        </table>
        <p><strong>Order total: ${esc(formatRupees(order.total_paise))}</strong></p>
        <p>We'll email you again once your order ships.</p>
      </div>
    `
  });
}

async function sendBookingConfirmation({ email, name, type, preferredDate, preferredTimeSlot }) {
  return sendMail({
    to: email,
    subject: `${type} booking received`,
    html: `
      <div style="${SHELL_STYLE}">
        <h2>Hi ${esc(name)},</h2>
        <p>We've received your ${esc(type)} booking request for <strong>${esc(preferredDate)}</strong>
        at <strong>${esc(preferredTimeSlot)}</strong>.</p>
        <p>Our team will confirm the exact details with you shortly.</p>
      </div>
    `
  });
}

async function sendPasswordResetEmail({ email, resetUrl }) {
  const href = safeUrl(resetUrl);
  if (!href) {
    logger.error('Password reset URL is not a valid http(s) URL — check CLIENT_URL', null, { });
    return { sent: false, reason: 'invalid_client_url' };
  }
  return sendMail({
    to: email,
    subject: 'Reset your Chakrashri password',
    html: `
      <div style="${SHELL_STYLE}">
        <h2>Password reset requested</h2>
        <p>Click the link below to set a new password. This link expires in 30 minutes.</p>
        <p><a href="${href}">${href}</a></p>
        <p>Resetting your password will also sign you out on every device.</p>
        <p>If you didn't request this, you can safely ignore this email — your password will not change.</p>
      </div>
    `
  });
}

/** AUTH-04 — the verification email the original code left as a TODO. */
async function sendEmailVerification({ email, name, verifyUrl }) {
  const href = safeUrl(verifyUrl);
  if (!href) {
    logger.error('Verification URL is not a valid http(s) URL — check CLIENT_URL');
    return { sent: false, reason: 'invalid_client_url' };
  }
  return sendMail({
    to: email,
    subject: 'Confirm your email address',
    html: `
      <div style="${SHELL_STYLE}">
        <h2>Welcome${name ? `, ${esc(name)}` : ''}</h2>
        <p>Please confirm your email address so we can send you order updates and keep your account secure.</p>
        <p><a href="${href}" style="display:inline-block;background:#b4451f;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Confirm my email</a></p>
        <p style="font-size:13px;color:#6b625a;">Or paste this link into your browser: ${href}</p>
        <p style="font-size:13px;color:#6b625a;">This link expires in 24 hours.</p>
      </div>
    `
  });
}

const ORDER_STATUS_COPY = {
  processing: { subject: 'Your order is being prepared', line: 'Your order is now being prepared for shipment.' },
  shipped: { subject: 'Your order has shipped', line: 'Good news — your order is on its way.' },
  delivered: { subject: 'Your order has been delivered', line: 'Your order has been marked as delivered. We hope you love it!' },
  cancelled: { subject: 'Your order was cancelled', line: 'Your order has been cancelled.' },
  refunded: { subject: 'Your order was refunded', line: 'Your order has been refunded. The amount should reflect in your original payment method within 5-7 business days.' },
  partially_refunded: { subject: 'A refund has been issued on your order', line: 'A partial refund has been issued on your order. The amount should reflect in your original payment method within 5-7 business days.' }
};

/**
 * Sent on every order status transition — previously the only order-related
 * email was the initial confirmation, so a customer had no way to know their
 * order had shipped, been delivered, or been refunded except by checking the
 * site. When the new status is 'delivered', this also asks for a review with a
 * direct link to each purchased product's page — reviews are gated to delivered
 * orders (see products.routes.js), so this is the natural moment to invite one.
 */
async function sendOrderStatusUpdate(order, items) {
  const copy = ORDER_STATUS_COPY[order.status];
  if (!copy) return { sent: false, reason: 'unknown_status' };

  const trackingLine = order.status === 'shipped' && order.tracking_number
    ? `<p>Tracking number: <strong>${esc(order.tracking_number)}</strong>${order.courier_name ? ` (${esc(order.courier_name)})` : ''}</p>`
    : '';

  let reviewSection = '';
  if (order.status === 'delivered' && items && items.length) {
    const clientUrl = (process.env.CLIENT_URL || '').replace(/\/+$/, '');
    const links = items
      .map((i) => {
        // SEO-01 changed product URLs from `/#product/slug` to `/product/slug`.
        // Emails outlive deploys, so these have to match what the storefront
        // actually serves or every review link in a customer's inbox 404s.
        const href = i.slug ? safeUrl(`${clientUrl}/product/${encodeURIComponent(i.slug)}`) : null;
        return href
          ? `<li><a href="${href}">${esc(i.product_name_snapshot)}</a></li>`
          : `<li>${esc(i.product_name_snapshot)}</li>`;
      })
      .join('');
    reviewSection = `
      <p>We'd love to hear what you think — your review helps other customers, and only takes a moment:</p>
      <ul>${links}</ul>
    `;
  }

  return sendMail({
    to: order.customer_email,
    subject: `${copy.subject} — ${order.order_number}`,
    html: `
      <div style="${SHELL_STYLE}">
        <h2>Hi ${esc(order.customer_name || '')},</h2>
        <p>${copy.line}</p>
        <p>Order: <strong>${esc(order.order_number)}</strong></p>
        ${trackingLine}
        ${reviewSection}
      </div>
    `
  });
}

const BOOKING_STATUS_COPY = {
  confirmed: { subject: 'booking confirmed', line: 'Your booking has been confirmed.' },
  completed: { subject: 'booking completed', line: 'Your booking has been marked as completed. Thank you for choosing Chakrashri.' },
  cancelled: { subject: 'booking cancelled', line: 'Your booking has been cancelled.' }
};

async function sendBookingStatusUpdate({ email, name, type, status, preferredDate, preferredTimeSlot }) {
  const copy = BOOKING_STATUS_COPY[status];
  if (!copy) return { sent: false, reason: 'unknown_status' };
  return sendMail({
    to: email,
    subject: `Your ${type} ${copy.subject}`,
    html: `
      <div style="${SHELL_STYLE}">
        <h2>Hi ${esc(name || '')},</h2>
        <p>${copy.line}</p>
        <p>${esc(type)} scheduled for <strong>${esc(preferredDate)}</strong> at <strong>${esc(preferredTimeSlot)}</strong>.</p>
      </div>
    `
  });
}

module.exports = {
  sendMail,
  sendOrderConfirmation,
  sendBookingConfirmation,
  sendPasswordResetEmail,
  sendEmailVerification,
  sendOrderStatusUpdate,
  sendBookingStatusUpdate,
  // exported for tests
  esc,
  safeUrl
};
