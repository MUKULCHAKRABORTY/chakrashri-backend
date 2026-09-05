/**
 * Every message the system can send.
 *
 * A template's only job is to produce a subject and a body and name its own
 * dedupe key. It never touches nodemailer, never checks consent, and never
 * decides whether it is allowed to send — the engine owns all of that, so a
 * template cannot accidentally mail somebody who opted out.
 *
 * DEDUPE KEYS: `<event>:<entity id>`. Anything that describes a state a thing
 * reaches exactly once gets one. Anything the customer can deliberately ask for
 * again — a password reset, a resent verification link, a booking reminder for
 * a rescheduled slot — deliberately gets none, because blocking a repeat would
 * be the bug.
 */
const {
  CATEGORY, BRAND, sendMail, renderShell, button, itemsTable, totalsRow,
  esc, safeUrl, formatRupees, clientUrl, unsubscribeUrlFor
} = require('./engine');
const { logger } = require('../logger');

const p = (text) => `<p style="margin:0 0 12px;">${text}</p>`;
const muted = (text) => `<p style="margin:0 0 12px;font-size:13px;color:${BRAND.soft};">${text}</p>`;

/** Where the admin alerts go. Falls back to FROM_EMAIL so alerts are never silently addressed to nobody. */
async function adminRecipient() {
  try {
    // eslint-disable-next-line global-require
    const db = require('../../config/db');
    const { rows } = await db.query("SELECT value FROM site_settings WHERE key = 'admin_alert_email'");
    const configured = rows.length ? String(rows[0].value || '').trim() : '';
    if (configured) return configured;
  } catch (err) { /* fall through */ }
  return String(process.env.ADMIN_ALERT_EMAIL || process.env.FROM_EMAIL || '').trim();
}

async function adminAlertsEnabled() {
  try {
    // eslint-disable-next-line global-require
    const db = require('../../config/db');
    const { rows } = await db.query("SELECT value FROM site_settings WHERE key = 'email_admin_alerts_enabled'");
    return !rows.length || String(rows[0].value) !== 'false';
  } catch (err) { return true; }
}

/** Every admin alert routes through here so the on/off switch and the address are in one place. */
async function sendAdmin({ subject, heading, body, template, dedupeKey, preheader }) {
  if (!(await adminAlertsEnabled())) return { sent: false, reason: 'admin_alerts_disabled' };
  const to = await adminRecipient();
  if (!to) {
    logger.warn('Admin alert has nowhere to go — set admin_alert_email in settings', { template });
    return { sent: false, reason: 'no_admin_recipient' };
  }
  return sendMail({
    to, subject, template, dedupeKey,
    category: CATEGORY.OPERATIONAL,
    html: renderShell({ heading, body, preheader })
  });
}

// ===========================================================================
// ACCOUNT
// ===========================================================================

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
    template: 'email_verification',
    // No dedupe key: "resend verification" exists precisely so this can repeat.
    html: renderShell({
      heading: `Welcome${name ? `, ${esc(name)}` : ''}`,
      preheader: 'One click to confirm your address and secure your account.',
      body: p('Please confirm your email address so we can send you order updates and keep your account secure.')
        + button(verifyUrl, 'Confirm my email')
        + muted(`Or paste this link into your browser: ${href}`)
        + muted('This link expires in 24 hours. If you did not create an account, you can ignore this email.')
    })
  });
}

async function sendWelcome({ email, name, userId }) {
  const shopUrl = `${clientUrl()}/shop`;
  return sendMail({
    to: email, userId,
    subject: `Welcome to ${BRAND.name}`,
    template: 'account_welcome',
    dedupeKey: userId ? `welcome:${userId}` : null,
    html: renderShell({
      heading: `Your account is ready${name ? `, ${esc(name)}` : ''}`,
      preheader: 'Your email is confirmed — here is what you can do now.',
      body: p('Your email address is confirmed, so your account is fully active.')
        + p('From your account you can track every order, keep delivery addresses ready for a faster checkout, view your puja and consultation bookings, and leave a review once something has been delivered.')
        + button(shopUrl, 'Browse the collection')
        + muted('Questions about an order or a booking? Reply to this email and a person will read it.')
    })
  });
}

async function sendPasswordResetEmail({ email, resetUrl }) {
  const href = safeUrl(resetUrl);
  if (!href) {
    logger.error('Password reset URL is not a valid http(s) URL — check CLIENT_URL', null, {});
    return { sent: false, reason: 'invalid_client_url' };
  }
  return sendMail({
    to: email,
    subject: `Reset your ${BRAND.name} password`,
    template: 'password_reset',
    // No dedupe key — asking again is the whole point of a reset link.
    html: renderShell({
      heading: 'Password reset requested',
      preheader: 'A link to set a new password. Expires in 30 minutes.',
      body: p('Use the button below to set a new password. This link expires in 30 minutes.')
        + button(resetUrl, 'Set a new password')
        + muted(`Or paste this link into your browser: ${href}`)
        + p('Resetting your password also signs you out on every device.')
        + muted('If you did not request this, you can safely ignore this email — your password will not change.')
    })
  });
}

/**
 * The other half of a password reset, and the one most systems forget.
 *
 * If an attacker resets a password, the victim's only warning is this email. It
 * is the difference between finding out immediately and finding out when the
 * account is already gone, so it sends on every password change — including the
 * ones the customer made themselves, where it is merely reassuring.
 */
async function sendPasswordChanged({ email, name, userId, when }) {
  return sendMail({
    to: email, userId,
    subject: 'Your password was changed',
    template: 'password_changed',
    html: renderShell({
      heading: 'Your password was changed',
      preheader: 'If this was not you, act now.',
      body: p(`Hi ${esc(name || 'there')}, the password on your ${esc(BRAND.name)} account was changed${when ? ` on ${esc(when)}` : ''}.`)
        + p('Every device that was signed in has been signed out. You will need to sign in again with the new password.')
        + p('<strong>If you did not do this</strong>, reset your password immediately and contact us — someone else may have access to your email account.')
        + button(`${clientUrl()}/account`, 'Go to my account')
    })
  });
}

// ===========================================================================
// ORDERS
// ===========================================================================

/** The money block, shared by the confirmation and the invoice. */
function orderTotals(order) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0 14px;">
    ${totalsRow('Subtotal', formatRupees(order.subtotal_paise))}
    ${Number(order.discount_paise) > 0 ? totalsRow('Discount', `− ${formatRupees(order.discount_paise)}`) : ''}
    ${totalsRow('Shipping', Number(order.shipping_paise) === 0 ? 'Free' : formatRupees(order.shipping_paise))}
    ${totalsRow('GST', formatRupees(order.gst_paise))}
    ${totalsRow('Total paid', formatRupees(order.total_paise), true)}
  </table>`;
}

function orderLink(order) {
  return order && order.id ? `${clientUrl()}/account/orders/${encodeURIComponent(order.id)}` : `${clientUrl()}/account`;
}

async function sendOrderConfirmation(order, items) {
  return sendMail({
    to: order.customer_email,
    userId: order.user_id,
    subject: `Order confirmed — ${order.order_number}`,
    template: 'order_confirmation',
    // The single most important dedupe key in the system: browser verify,
    // webhook and reconciler can all reach this for the same order.
    dedupeKey: `order_confirmation:${order.id || order.order_number}`,
    html: renderShell({
      heading: `Thank you for your order, ${esc(order.customer_name || '')}`,
      preheader: `Order ${order.order_number} is confirmed.`,
      body: p(`Order <strong>${esc(order.order_number)}</strong> is confirmed and we have started preparing it.`)
        + itemsTable(items)
        + orderTotals(order)
        + (order.payment_method === 'cod'
          ? p('<strong>Payment method:</strong> Cash on delivery. Please keep the exact amount ready.')
          : '')
        + button(orderLink(order), 'Track this order')
        + muted('We will email you again the moment it ships.')
    })
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
 * Sent on every order status transition. When the new status is 'delivered'
 * this also asks for a review with a direct link to each purchased product —
 * reviews are gated to delivered orders, so this is the natural moment to ask.
 */
async function sendOrderStatusUpdate(order, items) {
  const copy = ORDER_STATUS_COPY[order.status];
  if (!copy) return { sent: false, reason: 'unknown_status' };

  const trackingLine = order.status === 'shipped' && order.tracking_number
    ? p(`Tracking number: <strong>${esc(order.tracking_number)}</strong>${order.courier_name ? ` (${esc(order.courier_name)})` : ''}`)
    : '';

  let reviewSection = '';
  if (order.status === 'delivered' && items && items.length) {
    const links = items.map((i) => {
      // SEO-01 changed product URLs from `/#product/slug` to `/product/slug`.
      // Emails outlive deploys, so these have to match what the storefront
      // actually serves or every review link in a customer's inbox 404s.
      const href = i.slug ? safeUrl(`${clientUrl()}/product/${encodeURIComponent(i.slug)}`) : null;
      return href
        ? `<li style="margin:4px 0;"><a href="${href}" style="color:${BRAND.accent};">${esc(i.product_name_snapshot)}</a></li>`
        : `<li style="margin:4px 0;">${esc(i.product_name_snapshot)}</li>`;
    }).join('');
    reviewSection = p("We'd love to hear what you think — your review helps other customers, and only takes a moment:")
      + `<ul style="margin:0 0 12px;padding-left:20px;">${links}</ul>`;
  }

  return sendMail({
    to: order.customer_email,
    userId: order.user_id,
    subject: `${copy.subject} — ${order.order_number}`,
    template: `order_${order.status}`,
    // One email per status per order. An admin who fat-fingers shipped →
    // processing → shipped must not re-notify the customer.
    dedupeKey: `order_status:${order.id || order.order_number}:${order.status}`,
    html: renderShell({
      heading: `Hi ${esc(order.customer_name || '')},`,
      preheader: copy.subject,
      body: p(copy.line)
        + p(`Order: <strong>${esc(order.order_number)}</strong>`)
        + trackingLine
        + reviewSection
        + button(orderLink(order), 'View order')
    })
  });
}

/**
 * PAY-01's customer-facing half. A payment that fails is the moment a customer
 * decides whether to try again or give up, and silence reliably produces the
 * second outcome.
 */
async function sendPaymentFailed(order) {
  return sendMail({
    to: order.customer_email,
    userId: order.user_id,
    subject: `Payment could not be completed — ${order.order_number}`,
    template: 'order_payment_failed',
    dedupeKey: `payment_failed:${order.id || order.order_number}`,
    html: renderShell({
      heading: 'Your payment did not go through',
      preheader: 'Nothing was charged. Your items are still available.',
      body: p(`Hi ${esc(order.customer_name || '')}, the payment for order <strong>${esc(order.order_number)}</strong> could not be completed.`)
        + p('<strong>Nothing has been charged.</strong> If you see a pending amount from your bank, it will be released automatically within a few working days.')
        + p('The items are back in stock and ready if you would like to try again.')
        + button(`${clientUrl()}/cart`, 'Return to my cart')
        + muted('If money did leave your account for this order, reply to this email with the order number and we will trace it.')
    })
  });
}

/**
 * The order is parked in payment_review: the signature was valid but the amount,
 * currency or capture state did not match. The customer's money may well have
 * moved, so this must NOT say the payment failed — telling someone with a good
 * payment that it failed is its own harm.
 */
async function sendPaymentUnderReview(order) {
  return sendMail({
    to: order.customer_email,
    userId: order.user_id,
    subject: `We are checking your payment — ${order.order_number}`,
    template: 'order_payment_review',
    dedupeKey: `payment_review:${order.id || order.order_number}`,
    html: renderShell({
      heading: 'We are verifying your payment',
      preheader: 'A quick manual check. Your order is being held, not cancelled.',
      body: p(`Hi ${esc(order.customer_name || '')}, we have received your payment for order <strong>${esc(order.order_number)}</strong>, but something about it needs a manual check before we ship.`)
        + p('Your order is being <strong>held, not cancelled</strong>, and your items stay reserved while we look. This is usually resolved within one working day and almost always turns out to be nothing.')
        + p('You do not need to do anything or pay again. We will email you as soon as it clears.')
        + button(orderLink(order), 'View order')
    })
  });
}

/**
 * Sent when a refund is SENT to the gateway, which is days before the money
 * appears. Without it the customer watches an unchanged bank balance and
 * concludes nothing happened.
 */
async function sendRefundInitiated({ order, amountPaise, refundId, isPartial }) {
  return sendMail({
    to: order.customer_email,
    userId: order.user_id,
    subject: `Refund on the way — ${order.order_number}`,
    template: 'refund_initiated',
    dedupeKey: refundId ? `refund_initiated:${refundId}` : null,
    html: renderShell({
      heading: 'Your refund is on its way',
      preheader: `${formatRupees(amountPaise)} is being returned to your original payment method.`,
      body: p(`Hi ${esc(order.customer_name || '')}, we have issued a ${isPartial ? 'partial ' : ''}refund of <strong>${esc(formatRupees(amountPaise))}</strong> on order <strong>${esc(order.order_number)}</strong>.`)
        + p('It goes back to the payment method you used. Banks typically take <strong>5–7 working days</strong> to show it, and some card issuers post it against your next statement rather than as a separate credit.')
        + (isPartial ? p('The remaining items on this order are unaffected and will be delivered as normal.') : '')
        + button(orderLink(order), 'View order')
        + muted('If it has not appeared after 10 working days, reply to this email and we will chase it with the payment gateway.')
    })
  });
}

/**
 * GST invoice. India's CGST Rules require a tax invoice for a taxable supply,
 * and customers buying for a business need the HSN codes and the tax split to
 * claim input credit. The confirmation email is a receipt; this is the document.
 */
async function sendOrderInvoice(order, items, seller) {
  const s = seller || {};
  const rows = (items || []).map((i) => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid ${BRAND.rule};font-size:13px;">${esc(i.product_name_snapshot)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid ${BRAND.rule};font-size:13px;">${esc(i.hsn_code || '—')}</td>
      <td style="padding:6px 8px;border-bottom:1px solid ${BRAND.rule};font-size:13px;text-align:center;">${esc(i.quantity)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid ${BRAND.rule};font-size:13px;text-align:right;">${esc(formatRupees(i.unit_price_paise))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid ${BRAND.rule};font-size:13px;text-align:right;">${esc(i.gst_rate != null ? `${Number(i.gst_rate).toFixed(2)}%` : '—')}</td>
      <td style="padding:6px 8px;border-bottom:1px solid ${BRAND.rule};font-size:13px;text-align:right;">${esc(formatRupees(i.line_total_paise))}</td>
    </tr>`).join('');

  return sendMail({
    to: order.customer_email,
    userId: order.user_id,
    subject: `Tax invoice ${order.invoice_number || order.order_number}`,
    template: 'order_invoice',
    dedupeKey: `invoice:${order.id || order.order_number}`,
    html: renderShell({
      heading: `Tax invoice ${esc(order.invoice_number || order.order_number)}`,
      preheader: `Your GST invoice for order ${order.order_number}.`,
      body: `<table role="presentation" width="100%" style="margin:0 0 14px;font-size:13px;color:${BRAND.soft};"><tr>
          <td style="vertical-align:top;">
            <strong style="color:${BRAND.ink};">${esc(s.legal_name || BRAND.name)}</strong><br>
            ${s.address ? `${esc(s.address)}<br>` : ''}
            ${s.gstin ? `GSTIN: ${esc(s.gstin)}<br>` : ''}
          </td>
          <td style="vertical-align:top;text-align:right;">
            Invoice: <strong style="color:${BRAND.ink};">${esc(order.invoice_number || order.order_number)}</strong><br>
            Order: ${esc(order.order_number)}<br>
            Date: ${esc(new Date(order.created_at || Date.now()).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }))}
          </td></tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px;">
          <tr>
            <th align="left"  style="padding:6px 8px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">Item</th>
            <th align="left"  style="padding:6px 8px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">HSN</th>
            <th align="center" style="padding:6px 8px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">Qty</th>
            <th align="right" style="padding:6px 8px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">Rate</th>
            <th align="right" style="padding:6px 8px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">GST</th>
            <th align="right" style="padding:6px 8px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">Amount</th>
          </tr>${rows}</table>`
        + orderTotals(order)
        + muted('This is a computer-generated invoice and does not require a signature. Amounts are inclusive of GST as shown.')
    })
  });
}

/**
 * Abandoned-checkout recovery. Classified as MARKETING on purpose: the customer
 * did not ask to be reminded, and under DPDP Act 2023 "we noticed you left
 * something" is a marketing communication even though it refers to their own
 * session. It therefore honours opt-out and carries an unsubscribe link.
 */
async function sendAbandonedCheckout(order, items) {
  const unsubscribeUrl = await unsubscribeUrlFor(order.customer_email);
  return sendMail({
    to: order.customer_email,
    userId: order.user_id,
    category: CATEGORY.MARKETING,
    subject: 'You left something behind',
    template: 'abandoned_checkout',
    dedupeKey: `abandoned:${order.id || order.order_number}`,
    html: renderShell({
      heading: 'Still thinking it over?',
      preheader: 'Your items are reserved a little longer.',
      unsubscribeUrl,
      body: p(`Hi ${esc(order.customer_name || '')}, your checkout did not finish, so we have kept these aside for you:`)
        + itemsTable(items)
        + p('We hold reserved stock for a short while before releasing it back to the shop.')
        + button(`${clientUrl()}/cart`, 'Finish my order')
    })
  });
}

// ===========================================================================
// BOOKINGS
// ===========================================================================

async function sendBookingConfirmation({ email, name, type, preferredDate, preferredTimeSlot, bookingId }) {
  return sendMail({
    to: email,
    subject: `${type} booking received`,
    template: 'booking_received',
    dedupeKey: bookingId ? `booking_received:${bookingId}` : null,
    html: renderShell({
      heading: `Hi ${esc(name)},`,
      preheader: `Your ${type} request for ${preferredDate} has been received.`,
      body: p(`We've received your ${esc(type)} booking request for <strong>${esc(preferredDate)}</strong> at <strong>${esc(preferredTimeSlot)}</strong>.`)
        + p('Our team will confirm the exact details with you shortly.')
        + button(`${clientUrl()}/account/bookings`, 'View my bookings')
    })
  });
}

const BOOKING_STATUS_COPY = {
  confirmed: { subject: 'booking confirmed', line: 'Your booking has been confirmed.' },
  completed: { subject: 'booking completed', line: `Your booking has been marked as completed. Thank you for choosing ${BRAND.name}.` },
  cancelled: { subject: 'booking cancelled', line: 'Your booking has been cancelled.' }
};

async function sendBookingStatusUpdate({ email, name, type, status, preferredDate, preferredTimeSlot, bookingId }) {
  const copy = BOOKING_STATUS_COPY[status];
  if (!copy) return { sent: false, reason: 'unknown_status' };
  return sendMail({
    to: email,
    subject: `Your ${type} ${copy.subject}`,
    template: `booking_${status}`,
    dedupeKey: bookingId ? `booking_status:${bookingId}:${status}` : null,
    html: renderShell({
      heading: `Hi ${esc(name || '')},`,
      preheader: copy.line,
      body: p(copy.line)
        + p(`${esc(type)} scheduled for <strong>${esc(preferredDate)}</strong> at <strong>${esc(preferredTimeSlot)}</strong>.`)
        + button(`${clientUrl()}/account/bookings`, 'View my bookings')
    })
  });
}

/**
 * Sent the day before. A puja or a consultation is an appointment with a real
 * practitioner who has blocked out time — a no-show costs the business a slot
 * it could have sold and costs the customer the fee. No dedupe key on the date:
 * a rescheduled booking legitimately deserves a second reminder.
 */
async function sendBookingReminder({ email, name, type, preferredDate, preferredTimeSlot, mode, bookingId }) {
  return sendMail({
    to: email,
    subject: `Reminder: your ${type} is tomorrow`,
    template: 'booking_reminder',
    dedupeKey: bookingId ? `booking_reminder:${bookingId}:${preferredDate}` : null,
    html: renderShell({
      heading: `Your ${esc(type)} is tomorrow`,
      preheader: `${preferredDate} at ${preferredTimeSlot}`,
      body: p(`Hi ${esc(name || '')}, this is a reminder that your ${esc(type)} is scheduled for <strong>${esc(preferredDate)}</strong> at <strong>${esc(preferredTimeSlot)}</strong>.`)
        + (mode ? p(`Mode: <strong>${esc(mode)}</strong>`) : '')
        + p('If you need to reschedule, reply to this email today so we can offer the slot to someone else.')
        + button(`${clientUrl()}/account/bookings`, 'View my booking')
    })
  });
}

// ===========================================================================
// CATALOG AND ENGAGEMENT
// ===========================================================================

/**
 * The email the storefront's "notify me" button promised and never sent.
 *
 * Transactional, not marketing: the customer explicitly asked to be told about
 * this one product. It is a single message fulfilling a specific request, not
 * an ongoing relationship, so it needs no opt-in and gets no unsubscribe link.
 */
async function sendBackInStock({ email, productName, productSlug, variantLabel, notificationId }) {
  const url = `${clientUrl()}/product/${encodeURIComponent(productSlug || '')}`;
  return sendMail({
    to: email,
    subject: `Back in stock: ${productName}`,
    template: 'back_in_stock',
    dedupeKey: notificationId ? `back_in_stock:${notificationId}` : null,
    html: renderShell({
      heading: `${esc(productName)} is back`,
      preheader: 'You asked to be told when this returned.',
      body: p(`You asked us to let you know when <strong>${esc(productName)}</strong>${variantLabel ? ` (${esc(variantLabel)})` : ''} was available again. It is back in stock now.`)
        + button(url, 'View the product')
        + muted('Popular pieces go quickly, and we cannot reserve stock without an order. This is a one-off email — you will not hear from us about this item again unless you ask.')
    })
  });
}

async function sendReviewApproved({ email, name, productName, productSlug, reviewId }) {
  const url = `${clientUrl()}/product/${encodeURIComponent(productSlug || '')}`;
  return sendMail({
    to: email,
    subject: 'Your review is now live',
    template: 'review_approved',
    dedupeKey: reviewId ? `review_approved:${reviewId}` : null,
    html: renderShell({
      heading: 'Thank you for your review',
      preheader: `Your review of ${productName} is now published.`,
      body: p(`Hi ${esc(name || '')}, your review of <strong>${esc(productName)}</strong> has been published and is now helping other customers decide.`)
        + button(url, 'See it on the product page')
    })
  });
}

// ===========================================================================
// SUBSCRIPTION (double opt-in)
// ===========================================================================

/**
 * Step one of double opt-in. Deliberately transactional: it is the direct
 * response to someone typing their address into a form, and requiring consent
 * before you can ask for consent would make subscribing impossible.
 */
async function sendSubscriptionConfirm({ email, confirmUrl }) {
  const href = safeUrl(confirmUrl);
  if (!href) return { sent: false, reason: 'invalid_client_url' };
  return sendMail({
    to: email,
    subject: 'Confirm your subscription',
    template: 'subscription_confirm',
    html: renderShell({
      heading: 'One more click',
      preheader: 'Confirm you want panchang updates and early access.',
      body: p(`Someone — we hope you — asked to receive ${esc(BRAND.name)} updates at this address: auspicious dates, new arrivals and festival offers, a couple of times a month.`)
        + button(confirmUrl, 'Yes, subscribe me')
        + muted('This link expires in 48 hours. If this was not you, ignore this email and nothing will be sent — we do not add anyone to a list without this step.')
    })
  });
}

async function sendSubscriptionWelcome({ email, unsubscribeUrl }) {
  return sendMail({
    to: email,
    category: CATEGORY.MARKETING,
    subject: `You're subscribed to ${BRAND.name}`,
    template: 'subscription_welcome',
    html: renderShell({
      heading: 'You are on the list',
      preheader: 'Panchang updates, new arrivals and festival offers.',
      unsubscribeUrl,
      body: p('Thank you for confirming. You will hear from us a couple of times a month with auspicious dates, new arrivals and festival offers — and not otherwise.')
        + button(`${clientUrl()}/shop`, 'Browse the collection')
    })
  });
}

/** One broadcast message. The caller supplies the copy; the engine enforces consent per recipient. */
async function sendNewsletter({ email, subject, heading, bodyHtml, bodyText, unsubscribeUrl, campaignId }) {
  return sendMail({
    to: email,
    category: CATEGORY.MARKETING,
    subject,
    template: 'newsletter',
    dedupeKey: campaignId ? `newsletter:${campaignId}:${String(email).toLowerCase()}` : null,
    html: renderShell({ heading, body: bodyHtml, preheader: heading, unsubscribeUrl }),
    /* The writer's own words, not a reduction of the HTML. Optional, so nothing
       that calls this without one is broken — the engine derives a text part in
       that case, which is strictly better than sending none. */
    text: bodyText
      ? `${heading}\n\n${bodyText}\n\n—\nUnsubscribe: ${unsubscribeUrl || ''}`.trim()
      : undefined
  });
}

// ===========================================================================
// OPERATIONAL — to our own team
// ===========================================================================

async function sendAdminNewOrder(order, items) {
  return sendAdmin({
    subject: `New order ${order.order_number} — ${formatRupees(order.total_paise)}`,
    template: 'admin_new_order',
    dedupeKey: `admin_new_order:${order.id || order.order_number}`,
    heading: `New order ${esc(order.order_number)}`,
    preheader: `${formatRupees(order.total_paise)} from ${order.customer_name || 'a customer'}`,
    body: p(`<strong>${esc(formatRupees(order.total_paise))}</strong> · ${esc(order.payment_method === 'cod' ? 'Cash on delivery' : 'Paid online')}`)
      + p(`Customer: ${esc(order.customer_name || '')}`)
      + itemsTable(items)
      + button(`${clientUrl()}/admin`, 'Open the admin console')
  });
}

async function sendAdminPaymentReview(order, reason) {
  return sendAdmin({
    subject: `ACTION NEEDED: payment review on ${order.order_number}`,
    template: 'admin_payment_review',
    dedupeKey: `admin_payment_review:${order.id || order.order_number}`,
    heading: `Payment held for review — ${esc(order.order_number)}`,
    preheader: 'An order is holding stock and possibly the customer’s money.',
    body: p('An order was parked in <strong>payment_review</strong>. The signature was valid but something else did not match, so it was neither confirmed nor cancelled.')
      + p(`Reason: <code style="background:#f4f0ea;padding:2px 5px;">${esc(reason || 'unspecified')}</code>`)
      + p(`Order total: <strong>${esc(formatRupees(order.total_paise))}</strong>`)
      + p('<strong>This state holds stock and may be holding a customer’s money.</strong> Resolve it from the review queue rather than leaving it — nothing else will clear it.')
      + button(`${clientUrl()}/admin`, 'Open the review queue')
  });
}

async function sendAdminLowStock(products) {
  const rows = (products || []).map((x) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid ${BRAND.rule};font-size:14px;">${esc(x.name)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid ${BRAND.rule};font-size:14px;">${esc(x.sku)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid ${BRAND.rule};font-size:14px;text-align:right;font-weight:600;">${esc(x.stock_qty)}</td>
    </tr>`).join('');
  // Dated key: one low-stock digest per day, however many times the job runs.
  const day = new Date().toISOString().slice(0, 10);
  return sendAdmin({
    subject: `${products.length} product${products.length === 1 ? '' : 's'} running low`,
    template: 'admin_low_stock',
    dedupeKey: `admin_low_stock:${day}`,
    heading: 'Stock running low',
    preheader: `${products.length} product${products.length === 1 ? '' : 's'} at or below the alert threshold.`,
    body: p('These are at or below the alert threshold. A product that hits zero stops selling silently — nothing on the storefront announces it.')
      + `<table role="presentation" width="100%" style="border-collapse:collapse;margin:8px 0;">
          <tr><th align="left" style="padding:6px 10px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">Product</th>
              <th align="left" style="padding:6px 10px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">SKU</th>
              <th align="right" style="padding:6px 10px;border-bottom:2px solid ${BRAND.rule};font-size:11px;text-transform:uppercase;color:${BRAND.soft};">Left</th></tr>
          ${rows}</table>`
      + button(`${clientUrl()}/admin`, 'Update stock')
  });
}

async function sendAdminRefundIssued({ order, amountPaise, adminName, refundId }) {
  return sendAdmin({
    subject: `Refund issued — ${order.order_number} — ${formatRupees(amountPaise)}`,
    template: 'admin_refund_issued',
    dedupeKey: refundId ? `admin_refund:${refundId}` : null,
    heading: 'Refund issued',
    preheader: `${formatRupees(amountPaise)} returned on ${order.order_number}`,
    body: p(`<strong>${esc(formatRupees(amountPaise))}</strong> was refunded on order <strong>${esc(order.order_number)}</strong>${adminName ? ` by ${esc(adminName)}` : ''}.`)
      + p('This is a record for reconciliation — money has left the business. It is also in the audit log, which cannot be edited.')
  });
}

async function sendAdminDailyDigest(stats) {
  const day = new Date().toISOString().slice(0, 10);
  const line = (label, value, emphasis) => `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid ${BRAND.rule};font-size:14px;color:${BRAND.soft};">${esc(label)}</td>
      <td style="padding:5px 10px;border-bottom:1px solid ${BRAND.rule};font-size:14px;text-align:right;${emphasis ? `font-weight:700;color:${BRAND.accent};` : ''}">${esc(value)}</td>
    </tr>`;
  return sendAdmin({
    subject: `${BRAND.name} daily digest — ${day}`,
    template: 'admin_daily_digest',
    dedupeKey: `admin_digest:${day}`,
    heading: `Yesterday at ${esc(BRAND.name)}`,
    preheader: `${stats.orders} orders · ${formatRupees(stats.revenuePaise || 0)}`,
    body: `<table role="presentation" width="100%" style="border-collapse:collapse;margin:0 0 14px;">
        ${line('Orders placed', stats.orders)}
        ${line('Revenue', formatRupees(stats.revenuePaise || 0))}
        ${line('New customers', stats.newCustomers)}
        ${line('Bookings requested', stats.bookings)}
        ${line('Awaiting payment review', stats.paymentReview, Number(stats.paymentReview) > 0)}
        ${line('Unread contact messages', stats.unreadMessages, Number(stats.unreadMessages) > 0)}
        ${line('Reviews awaiting moderation', stats.pendingReviews, Number(stats.pendingReviews) > 0)}
        ${line('Products low on stock', stats.lowStock, Number(stats.lowStock) > 0)}
        ${line('Emails that failed to send', stats.failedEmails, Number(stats.failedEmails) > 0)}
      </table>`
      + (Number(stats.paymentReview) > 0
        ? p('<strong>Orders in payment review hold both stock and possibly a customer’s money.</strong> Nothing clears them automatically.')
        : '')
      + button(`${clientUrl()}/admin`, 'Open the admin console')
  });
}

/**
 * A human reply to a contact-form enquiry, sent from the admin console.
 *
 * TRANSACTIONAL, deliberately. The customer wrote to us and is waiting for an
 * answer; that is the definition of service mail, and routing it as marketing
 * would let the consent check or the marketing kill switch silently swallow a
 * reply somebody is expecting. It carries no unsubscribe link for the same
 * reason — there is nothing here to unsubscribe from.
 *
 * Their original message is quoted back so the reply makes sense on its own,
 * days later, in a thread they may not remember writing.
 */
async function sendContactReply({ toEmail, toName, subject, replyBody, originalMessage, messageId }) {
  return sendMail({
    to: toEmail,
    subject: subject,
    template: 'contact_reply',
    category: CATEGORY.TRANSACTIONAL,
    // Keyed on the message AND the reply text: sending a second, different
    // reply on the same enquiry is legitimate, sending the same one twice
    // because a button was double-clicked is not.
    dedupeKey: 'contact_reply:' + messageId + ':' + Buffer.from(String(replyBody)).toString('base64').slice(0, 40),
    html: renderShell({
      heading: 'Re: ' + (originalMessage && originalMessage.subject ? originalMessage.subject : 'your message'),
      preheader: 'A reply from the ' + BRAND.name + ' team.',
      body: p('Hello ' + esc(toName || 'there') + ',')
        + String(replyBody).split(/\n{2,}/).map(function (para) {
            return p(esc(para).replace(/\n/g, '<br>'));
          }).join('')
        + muted('— The ' + esc(BRAND.name) + ' team')
        + (originalMessage && originalMessage.message
            ? '<hr style="border:none;border-top:1px solid #e7ddd0;margin:22px 0;">'
              + muted('On ' + esc(originalMessage.when || '') + ' you wrote:')
              + '<blockquote style="margin:8px 0 0;padding:0 0 0 12px;border-left:3px solid #e7ddd0;color:#7a6a5c;font-size:13px;white-space:pre-wrap;">'
              + esc(originalMessage.message) + '</blockquote>'
            : '')
    })
  });
}

/**
 * A booking whose payment could not be confirmed straight away.
 *
 * NOT called "failed", and that wording is the whole point. By the time this
 * runs Razorpay has usually taken the money — what has not happened is our
 * verification of it. Telling somebody their payment failed when their bank has
 * already debited them is how a support queue fills up with frightened people,
 * and it invites a second payment attempt for a booking they have already paid
 * for. This says what is true: we have it, we are checking it, nobody needs to
 * do anything.
 */
async function sendBookingPaymentReview({ email, name, type, bookingId, amountPaise }) {
  return sendMail({
    to: email,
    subject: `We are confirming your ${type} booking payment`,
    template: 'booking_payment_review',
    category: CATEGORY.TRANSACTIONAL,
    dedupeKey: 'booking_payment_review:' + bookingId,
    html: renderShell({
      heading: 'Confirming your payment',
      preheader: 'We have your payment and are verifying it. No action needed.',
      body: p('Hello ' + esc(name || 'there') + ',')
        + p('We have received your payment for your <b>' + esc(type) + '</b> booking'
            /* > 0, not truthy. A corrupt or negative amount_paise rendered as
               "of ₹-0.01" in an email about money already taken, which is the
               worst possible place to print a nonsense figure. Omitting the
               clause reads perfectly; printing a negative one does not. */
            + (Number(amountPaise) > 0 ? ' of ' + esc(formatRupees(amountPaise)) : '')
            + ' and our team is confirming it now.')
        + p('<b>You do not need to pay again.</b> We will email you as soon as it is confirmed, usually within a few hours.')
        + muted('Reference: ' + esc(String(bookingId).slice(0, 8)))
        + muted('If anything looks wrong, reply to this email and a person will read it.')
    })
  });
}

/**
 * A booking that was started and never paid for.
 *
 * TRANSACTIONAL rather than marketing, and that is a considered call: the
 * customer chose a service, entered their details and reached a payment screen.
 * This is the completion of a transaction they began, not an approach we
 * initiated — the same footing as an abandoned checkout on an order, which this
 * codebase already treats the same way.
 *
 * Sent ONCE per booking. The dedupe key carries no timestamp, so a job that
 * runs every fifteen minutes cannot turn a forgotten booking into a stream of
 * reminders.
 */
async function sendBookingAbandoned({ email, name, type, bookingId, preferredDate, amountPaise }) {
  return sendMail({
    to: email,
    subject: `Your ${type} booking is still waiting`,
    template: 'booking_abandoned',
    category: CATEGORY.TRANSACTIONAL,
    dedupeKey: 'booking_abandoned:' + bookingId,
    html: renderShell({
      heading: 'Your booking is still held',
      preheader: 'Complete the payment to confirm your ' + type + ' booking.',
      body: p('Hello ' + esc(name || 'there') + ',')
        + p('You started a <b>' + esc(type) + '</b> booking'
            + (preferredDate ? ' for ' + esc(String(preferredDate).slice(0, 10)) : '')
            + ' and it has not been paid for yet, so it is not confirmed.')
        // > 0 for the same reason as the payment-review template above.
        + (Number(amountPaise) > 0 ? p('Amount due: <b>' + esc(formatRupees(amountPaise)) + '</b>') : '')
        + button(clientUrl('/account'), 'Complete my booking')
        + muted('If you have changed your mind, no action is needed — the slot is released on its own.')
    })
  });
}

module.exports = {
  sendBookingPaymentReview,
  sendBookingAbandoned,
  sendContactReply,
  // account
  sendEmailVerification,
  sendWelcome,
  sendPasswordResetEmail,
  sendPasswordChanged,
  // orders
  sendOrderConfirmation,
  sendOrderStatusUpdate,
  sendPaymentFailed,
  sendPaymentUnderReview,
  sendRefundInitiated,
  sendOrderInvoice,
  sendAbandonedCheckout,
  // bookings
  sendBookingConfirmation,
  sendBookingStatusUpdate,
  sendBookingReminder,
  // catalog and engagement
  sendBackInStock,
  sendReviewApproved,
  // subscription
  sendSubscriptionConfirm,
  sendSubscriptionWelcome,
  sendNewsletter,
  // operational
  sendAdminNewOrder,
  sendAdminPaymentReview,
  sendAdminLowStock,
  sendAdminRefundIssued,
  sendAdminDailyDigest,
  // exported for tests and for the scheduled jobs
  adminRecipient,
  ORDER_STATUS_COPY,
  BOOKING_STATUS_COPY
};
