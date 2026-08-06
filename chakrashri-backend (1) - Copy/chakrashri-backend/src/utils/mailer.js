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

module.exports = { sendMail, sendOrderConfirmation, sendBookingConfirmation, sendPasswordResetEmail };
