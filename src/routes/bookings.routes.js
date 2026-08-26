const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendBookingConfirmation, sendBookingStatusUpdate } = require('../utils/mailer');
const { createBookingWithPayment } = require('../utils/bookingPayments');
const { timingSafeEqualHex } = require('../utils/crypto');
const razorpay = require('../config/razorpay');

const router = express.Router();

// isISO8601() alone accepts any valid date, including yesterday or the year
// 1900 — it only checks format, not whether the date makes sense for a
// booking. This closes that gap for both booking types below.
function isTodayOrFuture(value) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(value);
  if (date < today) throw new Error('Preferred date cannot be in the past.');
  return true;
}

// ---------- Create a puja booking + real Razorpay order ----------
// Previously this endpoint just inserted an "unpaid" row with no payment
// path at all — the frontend never even called it, since its own
// confirmPujaBooking() was a local-only fake success message. This now
// mirrors the real product-checkout pattern: server-side price lookup,
// a real Razorpay order, and a signature-verified payment step below.
router.post(
  '/puja',
  requireAuth,
  [
    body('serviceId').notEmpty(),
    body('preferredDate').isISO8601().custom(isTodayOrFuture),
    body('preferredTimeSlot').notEmpty(),
    body('contactName').notEmpty(),
    body('contactPhone').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { serviceId, preferredDate, preferredTimeSlot, preferredMode, contactName, contactPhone, notes } = req.body;
    try {
      const result = await createBookingWithPayment({
        bookingType: 'puja',
        userId: req.user.id,
        serviceId,
        fields: { contact_name: contactName, contact_phone: contactPhone, preferred_date: preferredDate, preferred_time_slot: preferredTimeSlot, preferred_mode: preferredMode, notes }
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not create booking.' });
    }
  }
);

// ---------- Create an astrology consultation booking + real Razorpay order ----------
router.post(
  '/astrology',
  requireAuth,
  [
    body('serviceId').notEmpty(),
    body('consultationMode').isIn(['call', 'video', 'chat']),
    body('preferredDate').isISO8601().custom(isTodayOrFuture),
    body('preferredTimeSlot').notEmpty(),
    body('contactName').notEmpty(),
    body('contactPhone').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { serviceId, consultationMode, preferredDate, preferredTimeSlot, contactName, contactPhone, birthDetails } = req.body;
    try {
      // NOTE: birthDetails (DOB/time/place) is sensitive personal data under
      // India's DPDP Act 2023 — only ever returned to the owning user or staff.
      const result = await createBookingWithPayment({
        bookingType: 'astrology',
        userId: req.user.id,
        serviceId,
        fields: { contact_name: contactName, contact_phone: contactPhone, preferred_date: preferredDate, preferred_time_slot: preferredTimeSlot, consultation_mode: consultationMode, birth_details: birthDetails }
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not create booking.' });
    }
  }
);

// ---------- Verify booking payment (shared by both puja and astrology) ----------
router.post(
  '/verify-payment',
  requireAuth,
  [
    body('bookingType').isIn(['puja', 'astrology']),
    body('bookingId').notEmpty(),
    body('razorpay_order_id').notEmpty(),
    body('razorpay_payment_id').notEmpty(),
    body('razorpay_signature').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { bookingType, bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const table = bookingType === 'puja' ? 'puja_bookings' : 'astrology_bookings';

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (!timingSafeEqualHex(expectedSignature, razorpay_signature)) {
      return res.status(400).json({ error: 'Payment verification failed. Signature mismatch.' });
    }

    try {
      const { rows: existing } = await db.query(`SELECT user_id FROM ${table} WHERE razorpay_order_id = $1`, [razorpay_order_id]);
      if (!existing.length) return res.status(404).json({ error: 'Booking not found.' });
      if (existing[0].user_id !== req.user.id) return res.status(403).json({ error: 'This booking does not belong to your account.' });

      const { rows } = await db.query(
        `UPDATE ${table}
         SET payment_status = 'paid', razorpay_payment_id = $1, razorpay_signature = $2
         WHERE razorpay_order_id = $3 AND payment_status = 'unpaid'
         RETURNING id, contact_name, contact_phone, preferred_date, preferred_time_slot`,
        [razorpay_payment_id, razorpay_signature, razorpay_order_id]
      );
      if (!rows.length) {
        const { rows: current } = await db.query(`SELECT payment_status FROM ${table} WHERE razorpay_order_id = $1`, [razorpay_order_id]);
        if (current[0]?.payment_status === 'paid') return res.json({ success: true, bookingId: existing.length ? bookingId : null });
        return res.status(409).json({ error: 'This booking is not in a payable state.' });
      }

      const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      if (userRows.length) {
        sendBookingConfirmation({
          email: userRows[0].email,
          name: rows[0].contact_name,
          type: bookingType === 'puja' ? 'Puja' : 'Astrology consultation',
          preferredDate: rows[0].preferred_date,
          preferredTimeSlot: rows[0].preferred_time_slot
        }).catch(() => {});
      }
      res.json({ success: true, bookingId: rows[0].id });
    } catch (err) {
      res.status(500).json({ error: 'Could not verify payment.' });
    }
  }
);

// ---------- Admin: list bookings ----------
router.get('/puja', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pb.*, bs.name AS service_name FROM puja_bookings pb
       LEFT JOIN booking_services bs ON bs.id = pb.service_id
       ORDER BY pb.created_at DESC LIMIT 200`
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load puja bookings.' });
  }
});

router.get('/astrology', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ab.id, ab.user_id, ab.consultation_mode, ab.preferred_date, ab.preferred_time_slot, ab.status,
              ab.payment_status, ab.amount_paise, ab.contact_name, ab.contact_phone, ab.created_at, bs.name AS service_name
       FROM astrology_bookings ab
       LEFT JOIN booking_services bs ON bs.id = ab.service_id
       ORDER BY ab.created_at DESC LIMIT 200`
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load astrology bookings.' });
  }
});

// ---------- Staff: astrology booking detail (includes birth_details) ----------
// The list endpoint above deliberately omits birth_details (sensitive under
// DPDP Act 2023) — but there was previously no endpoint that returned it AT
// ALL, meaning staff had no way to actually retrieve what they need to
// conduct the consultation. This makes that data available, but only via an
// explicit single-record fetch (not bulk-listable), and only to staff/admin.
router.get('/astrology/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    // Joins the service catalog and the customer account so the admin's
    // Manage view can show every field the customer was actually asked for,
    // rather than a partial row.
    const result = await db.query(
      `SELECT ab.*, bs.name AS service_name, bs.duration_label,
              u.name AS account_name, u.email AS account_email
       FROM astrology_bookings ab
       LEFT JOIN booking_services bs ON bs.id = ab.service_id
       LEFT JOIN users u ON u.id = ab.user_id
       WHERE ab.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Booking not found.' });
    res.json({ booking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not load booking.' });
  }
});

// ---------- Staff: single puja booking detail ----------
// Astrology had a detail endpoint but puja never did, so the admin's puja
// "Manage" dialog could only show whatever happened to be in the list row.
router.get('/puja/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pb.*, bs.name AS service_name, bs.duration_label,
              u.name AS account_name, u.email AS account_email
       FROM puja_bookings pb
       LEFT JOIN booking_services bs ON bs.id = pb.service_id
       LEFT JOIN users u ON u.id = pb.user_id
       WHERE pb.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Booking not found.' });
    res.json({ booking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not load booking.' });
  }
});

const BOOKING_STATUSES = ['requested', 'confirmed', 'completed', 'cancelled'];

// ---------- Staff: update puja booking status ----------
// Previously there was no way for staff to mark a booking confirmed/completed
// at all — bookings could be created but never progressed.
router.patch('/puja/:id/status', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { status } = req.body;
  if (!BOOKING_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    const result = await db.query(
      `UPDATE puja_bookings SET status = $1 WHERE id = $2
       RETURNING id, status, user_id, puja_type, preferred_date, preferred_time_slot`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Booking not found.' });

    (async () => {
      try {
        const b = result.rows[0];
        const { rows: userRows } = await db.query('SELECT name, email FROM users WHERE id = $1', [b.user_id]);
        if (userRows.length) {
          await sendBookingStatusUpdate({
            email: userRows[0].email, name: userRows[0].name, type: 'puja', status: b.status,
            preferredDate: b.preferred_date, preferredTimeSlot: b.preferred_time_slot
          });
        }
      } catch (err) {
        console.error('[bookings.routes] Failed to send puja status update email:', err.message);
      }
    })();

    res.json({ booking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not update booking status.' });
  }
});

// ---------- Staff: update astrology booking status ----------
router.patch('/astrology/:id/status', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { status } = req.body;
  if (!BOOKING_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  try {
    const result = await db.query(
      `UPDATE astrology_bookings SET status = $1 WHERE id = $2
       RETURNING id, status, user_id, consultation_mode, preferred_date, preferred_time_slot`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Booking not found.' });

    (async () => {
      try {
        const b = result.rows[0];
        const { rows: userRows } = await db.query('SELECT name, email FROM users WHERE id = $1', [b.user_id]);
        if (userRows.length) {
          await sendBookingStatusUpdate({
            email: userRows[0].email, name: userRows[0].name, type: 'astrology consultation', status: b.status,
            preferredDate: b.preferred_date, preferredTimeSlot: b.preferred_time_slot
          });
        }
      } catch (err) {
        console.error('[bookings.routes] Failed to send astrology status update email:', err.message);
      }
    })();

    res.json({ booking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Could not update booking status.' });
  }
});

// ---------- Admin: refund a booking payment (real money movement) ----------
// Mirrors the order refund flow: calls Razorpay's Refunds API so money
// actually returns to the customer, records the real refund id, and notifies
// them — rather than just flipping a status and leaving the payment captured.
router.post('/:type/:id/refund', requireAuth, requireRole('admin'), async (req, res) => {
  const { type, id } = req.params;
  if (!['puja', 'astrology'].includes(type)) return res.status(400).json({ error: 'Invalid booking type.' });
  const table = type === 'puja' ? 'puja_bookings' : 'astrology_bookings';
  const { refundAmountPaise } = req.body;

  try {
    const { rows } = await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Booking not found.' });
    const booking = rows[0];

    if (booking.payment_status !== 'paid' || !booking.razorpay_payment_id) {
      return res.status(409).json({ error: 'This booking has no captured payment to refund.' });
    }
    if (booking.refund_id) {
      return res.status(409).json({ error: 'This booking has already been refunded.' });
    }

    const paid = Number(booking.amount_paise) || 0;
    const amountToRefund = Number.isInteger(refundAmountPaise) && refundAmountPaise > 0
      ? Math.min(refundAmountPaise, paid) // never refund more than was actually paid
      : paid;                              // default: full refund

    let refund;
    try {
      refund = await razorpay.payments.refund(booking.razorpay_payment_id, {
        amount: amountToRefund,
        speed: 'normal',
        notes: { reason: 'admin_initiated_booking_refund', bookingType: type, adminUserId: req.user.id }
      });
    } catch (err) {
      return res.status(502).json({ error: `Razorpay refund failed: ${err.error?.description || err.message}` });
    }

    const { rows: updated } = await db.query(
      `UPDATE ${table}
       SET refund_id = $1, refunded_amount_paise = $2,
           payment_status = 'refunded', status = 'cancelled', updated_at = now()
       WHERE id = $3 RETURNING *`,
      [refund.id, amountToRefund, id]
    );

    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'refund_booking', $2, $3, $4)`,
      [req.user.id, type + '_booking', id, JSON.stringify({ refundId: refund.id, amountPaise: amountToRefund })]
    );

    // Fire-and-forget: a mail failure must not undo a completed refund.
    (async () => {
      try {
        const { rows: u } = await db.query('SELECT name, email FROM users WHERE id = $1', [booking.user_id]);
        if (u.length) {
          await sendBookingStatusUpdate({
            email: u[0].email, name: u[0].name,
            type: type === 'puja' ? 'puja' : 'astrology consultation',
            status: 'cancelled',
            preferredDate: booking.preferred_date, preferredTimeSlot: booking.preferred_time_slot
          });
        }
      } catch (err) { console.error('[bookings] refund email failed:', err.message); }
    })();

    res.json({ booking: updated[0], refundId: refund.id, refundedAmountPaise: amountToRefund });
  } catch (err) {
    console.error('[bookings] refund failed:', err.message, err.code || '');
    res.status(500).json({ error: 'Could not process refund.', code: err.code || null });
  }
});

module.exports = router;
