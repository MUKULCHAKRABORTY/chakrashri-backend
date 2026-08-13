const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null; // not configured yet — see .env.example
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporter;
}

/**
 * Sends an email. Every call site treats a failure here as non-fatal — a
 * customer's order must still succeed even if, say, the SMTP provider is
 * briefly down. The error is logged (so it's visible in Render's logs and
 * not silently swallowed) rather than thrown.
 */
async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[mailer] SMTP not configured — skipped email "${subject}" to ${to}`);
    return { sent: false, reason: 'smtp_not_configured' };
  }
  try {
    await t.sendMail({ from: process.env.FROM_EMAIL || process.env.SMTP_USER, to, subject, html });
    return { sent: true };
  } catch (err) {
    console.error(`[mailer] Failed to send "${subject}" to ${to}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

function formatRupees(paise) {
  return `₹${(paise / 100).toFixed(2)}`;
}

async function sendOrderConfirmation(order, items) {
  const rows = items
    .map((i) => `<tr><td>${i.product_name_snapshot}</td><td>${i.quantity}</td><td>${formatRupees(i.line_total_paise)}</td></tr>`)
    .join('');
  return sendMail({
    to: order.customer_email,
    subject: `Order confirmed — ${order.order_number}`,
    html: `
      <h2>Thank you for your order, ${order.customer_name || ''}!</h2>
      <p>Order <strong>${order.order_number}</strong> is confirmed.</p>
      <table border="1" cellpadding="6" style="border-collapse:collapse">
        <tr><th>Item</th><th>Qty</th><th>Total</th></tr>
        ${rows}
      </table>
      <p><strong>Order total: ${formatRupees(order.total_paise)}</strong></p>
      <p>We'll email you again once your order ships.</p>
    `
  });
}

async function sendBookingConfirmation({ email, name, type, preferredDate, preferredTimeSlot }) {
  return sendMail({
    to: email,
    subject: `${type} booking received`,
    html: `
      <h2>Hi ${name},</h2>
      <p>We've received your ${type} booking request for <strong>${preferredDate}</strong>
      at <strong>${preferredTimeSlot}</strong>.</p>
      <p>Our team will confirm the exact details with you shortly.</p>
    `
  });
}

async function sendPasswordResetEmail({ email, resetUrl }) {
  return sendMail({
    to: email,
    subject: 'Reset your Chakrashri password',
    html: `
      <h2>Password reset requested</h2>
      <p>Click the link below to set a new password. This link expires in 30 minutes.</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `
  });
}

const ORDER_STATUS_COPY = {
  processing: { subject: 'Your order is being prepared', line: 'Your order is now being prepared for shipment.' },
  shipped: { subject: 'Your order has shipped', line: 'Good news — your order is on its way.' },
  delivered: { subject: 'Your order has been delivered', line: 'Your order has been marked as delivered. We hope you love it!' },
  cancelled: { subject: 'Your order was cancelled', line: 'Your order has been cancelled.' },
  refunded: { subject: 'Your order was refunded', line: 'Your order has been refunded. The amount should reflect in your original payment method within 5-7 business days.' }
};

/**
 * Sent on every order status transition (processing/shipped/delivered/
 * cancelled/refunded) — previously the only order-related email was the
 * initial confirmation, so a customer had no way to know their order had
 * shipped, been delivered, or been refunded except by checking the site.
 * When the new status is 'delivered', this also asks for a review with a
 * direct link to each purchased product's page — reviews are gated to
 * delivered orders (see products.routes.js), so this is the natural moment
 * to actually invite one.
 */
async function sendOrderStatusUpdate(order, items) {
  const copy = ORDER_STATUS_COPY[order.status];
  if (!copy) return { sent: false, reason: 'unknown_status' };

  const trackingLine = order.status === 'shipped' && order.tracking_number
    ? `<p>Tracking number: <strong>${order.tracking_number}</strong>${order.courier_name ? ` (${order.courier_name})` : ''}</p>`
    : '';

  let reviewSection = '';
  if (order.status === 'delivered' && items && items.length) {
    const clientUrl = (process.env.CLIENT_URL || '').replace(/\/+$/, '');
    const links = items
      .map((i) => {
        const url = i.slug ? `${clientUrl}/#product/${i.slug}` : null;
        return url
          ? `<li><a href="${url}">${i.product_name_snapshot}</a></li>`
          : `<li>${i.product_name_snapshot}</li>`;
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
      <h2>Hi ${order.customer_name || ''},</h2>
      <p>${copy.line}</p>
      <p>Order: <strong>${order.order_number}</strong></p>
      ${trackingLine}
      ${reviewSection}
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
      <h2>Hi ${name || ''},</h2>
      <p>${copy.line}</p>
      <p>${type} scheduled for <strong>${preferredDate}</strong> at <strong>${preferredTimeSlot}</strong>.</p>
    `
  });
}

module.exports = {
  sendMail,
  sendOrderConfirmation,
  sendBookingConfirmation,
  sendPasswordResetEmail,
  sendOrderStatusUpdate,
  sendBookingStatusUpdate
};
