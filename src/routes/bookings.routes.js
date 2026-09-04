const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const db = require('../config/db');
const { requireAuth, requireRole, requireCapability, CAPABILITIES: C } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateUuidParam, handleValidation, isUuid } = require('../middleware/validate');
const { sendBookingConfirmation, sendBookingStatusUpdate, sendBookingPaymentReview } = require('../utils/mailer');
const { createBookingWithPayment } = require('../utils/bookingPayments');
const { timingSafeEqualHex } = require('../utils/crypto');
const { verifyCapturedPayment, flagForReview, REASONS } = require('../utils/paymentVerification');
const { listAvailableSlots } = require('../utils/bookingSlots');
const { isTodayOrFuture, BOOKING_TZ } = require('../utils/bookingDates');
const { issueRefund } = require('../utils/refunds');
const { logger } = require('../utils/logger');

const router = express.Router();
router.param('id', validateUuidParam('id'));

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.BOOKING_RATE_LIMIT_MAX || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) || req.ip,
  message: { error: 'Too many booking attempts. Please wait a few minutes and try again.' }
});

// ---------- Public: which slots can actually be booked (BIZ-02) ----------
// The storefront must not be able to render a slot it cannot book, so this only
// ever returns future, active slots with seats remaining.
router.get('/availability', asyncHandler(async (req, res) => {
  const { serviceType, serviceId, from, days } = req.query;
  if (!['puja', 'astrology'].includes(serviceType)) {
    return res.status(400).json({ error: 'serviceType must be "puja" or "astrology".' });
  }
  if (serviceId && !isUuid(serviceId)) {
    return res.status(400).json({ error: 'Invalid serviceId.' });
  }
  const slots = await listAvailableSlots({ serviceType, serviceId, fromDate: from, days });
  res.json({ slots, timezone: BOOKING_TZ });
}));

// ---------- Create a puja booking + real Razorpay order ----------
router.post(
  '/puja',
  requireAuth,
  bookingLimiter,
  [
    body('serviceId').custom((v) => isUuid(v) || Promise.reject(new Error('A valid service must be selected.'))),
    body('slotId').optional({ nullable: true, checkFalsy: true })
      .custom((v) => isUuid(v) || Promise.reject(new Error('Invalid slot.'))),
    body('preferredDate').isISO8601().custom(isTodayOrFuture),
    body('preferredTimeSlot').trim().isLength({ min: 1, max: 40 }),
    body('contactName').trim().isLength({ min: 2, max: 120 }),
    body('contactPhone').trim().isLength({ min: 7, max: 20 }),
    body('preferredMode').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 20 }),
    body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { serviceId, slotId, preferredDate, preferredTimeSlot, preferredMode, contactName, contactPhone, notes } = req.body;
    try {
      const result = await createBookingWithPayment({
        bookingType: 'puja',
        userId: req.user.id,
        serviceId,
        slotId: slotId || null,
        fields: {
          contact_name: contactName,
          contact_phone: contactPhone,
          preferred_date: preferredDate,
          preferred_time_slot: preferredTimeSlot,
          preferred_mode: preferredMode,
          notes
        }
      });
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error('Puja booking creation failed', err, { userId: req.user.id });
      res.status(500).json({ error: 'Could not create your booking. Please try again.' });
    }
  })
);

// ---------- Create an astrology consultation booking + real Razorpay order ----------
router.post(
  '/astrology',
  requireAuth,
  bookingLimiter,
  [
    body('serviceId').custom((v) => isUuid(v) || Promise.reject(new Error('A valid service must be selected.'))),
    body('slotId').optional({ nullable: true, checkFalsy: true })
      .custom((v) => isUuid(v) || Promise.reject(new Error('Invalid slot.'))),
    body('consultationMode').isIn(['call', 'video', 'chat']),
    body('preferredDate').isISO8601().custom(isTodayOrFuture),
    body('preferredTimeSlot').trim().isLength({ min: 1, max: 40 }),
    body('contactName').trim().isLength({ min: 2, max: 120 }),
    body('contactPhone').trim().isLength({ min: 7, max: 20 }),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { serviceId, slotId, consultationMode, preferredDate, preferredTimeSlot, contactName, contactPhone, birthDetails } = req.body;

    // birth_details is free-form JSONB written by a public form and read back on
    // every staff view. Bound its size so it cannot be used as arbitrary
    // storage, and reject anything that is not a plain object.
    if (birthDetails !== undefined && birthDetails !== null) {
      if (typeof birthDetails !== 'object' || Array.isArray(birthDetails)) {
        return res.status(400).json({ error: 'Birth details are not in the expected format.' });
      }
      if (JSON.stringify(birthDetails).length > 4000) {
        return res.status(400).json({ error: 'Birth details are too long.' });
      }
    }

    try {
      // NOTE: birthDetails (DOB/time/place) is sensitive personal data under
      // India's DPDP Act 2023 — only ever returned to the owning user or staff,
      // never in a list endpoint, and every staff read of it is audit-logged
      // (see GET /astrology/:id below).
      const result = await createBookingWithPayment({
        bookingType: 'astrology',
        userId: req.user.id,
        serviceId,
        slotId: slotId || null,
        fields: {
          contact_name: contactName,
          contact_phone: contactPhone,
          preferred_date: preferredDate,
          preferred_time_slot: preferredTimeSlot,
          consultation_mode: consultationMode,
          birth_details: birthDetails || null
        }
      });
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error('Astrology booking creation failed', err, { userId: req.user.id });
      res.status(500).json({ error: 'Could not create your booking. Please try again.' });
    }
  })
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
    body('razorpay_signature').notEmpty(),
    handleValidation
  ],
  asyncHandler(async (req, res) => {
    const { bookingType, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    // Table name comes from a strict two-value whitelist, never from input.
    const table = bookingType === 'puja' ? 'puja_bookings' : 'astrology_bookings';
    const entityType = bookingType === 'puja' ? 'puja_booking' : 'astrology_booking';

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (!timingSafeEqualHex(expectedSignature, razorpay_signature)) {
      logger.warn('Booking payment signature mismatch', { userId: req.user.id, razorpay_order_id });
      return res.status(400).json({ error: 'Payment verification failed. Signature mismatch.' });
    }

    const { rows: existing } = await db.query(
      `SELECT id, user_id, payment_status, amount_paise, contact_name, contact_phone,
              preferred_date, preferred_time_slot
         FROM ${table} WHERE razorpay_order_id = $1`,
      [razorpay_order_id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Booking not found.' });
    const booking = existing[0];
    if (booking.user_id !== req.user.id) {
      logger.warn('Cross-account booking confirmation attempt', { userId: req.user.id, bookingId: booking.id });
      return res.status(403).json({ error: 'This booking does not belong to your account.' });
    }

    if (booking.payment_status === 'paid') {
      return res.json({ success: true, bookingId: booking.id });
    }
    if (booking.payment_status !== 'unpaid') {
      return res.status(409).json({ error: 'This booking is not in a payable state.' });
    }

    // PAY-01 — the signature proves the payment is genuine; it does not prove
    // the money was captured or that the amount is right. Same check the order
    // path now performs.
    const verification = await verifyCapturedPayment({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      expectedAmountPaise: Number(booking.amount_paise),
      currency: 'INR'
    });

    if (!verification.ok) {
      if (verification.reason === REASONS.UNVERIFIABLE) {
        return res.status(202).json({
          pending: true,
          bookingId: booking.id,
          message: 'We are confirming your payment. Your booking will update shortly.'
        });
      }
      await db.withTransaction(async (client) => {
        await client.query(
          `UPDATE ${table} SET payment_status = 'payment_review', razorpay_payment_id = $2, updated_at = now()
            WHERE id = $1 AND payment_status = 'unpaid'`,
          [booking.id, razorpay_payment_id]
        );
        await flagForReview(client, {
          entityType, entityId: booking.id,
          reason: verification.reason, detail: verification.detail
        });
      });
      /* Told, not just recorded. Before this, a booking going to payment_review
         left the customer on a screen saying "verifying" with nothing in
         writing — and if they closed the tab, nothing at all. That is the
         moment somebody pays a second time. fireAndForget because a mail
         failure must never turn a successfully-received payment into an error
         response. */
      sendBookingPaymentReview({
        // The account email. Neither booking table has a contact_email column —
        // the booking captures a name and phone only — and requireAuth puts
        // { id, role, email } on req.user, which is where every other booking
        // email on this route gets its address.
        email: req.user.email,
        name: booking.contact_name,
        // Derived from the same whitelisted bookingType this route already
        // trusts, rather than a variable that belongs to another function.
        type: bookingType === 'puja' ? 'puja' : 'astrology',
        bookingId: booking.id,
        amountPaise: Number(booking.amount_paise)
      }).catch(function(err){
        // Never let a mail failure turn a payment we HAVE received into an
        // error response. The booking is already flagged for review in the
        // database; the email is a courtesy on top of that.
        logger.warn('Booking payment review email failed', { bookingId: booking.id, message: err.message });
      });
      return res.status(202).json({
        pending: true,
        bookingId: booking.id,
        message: 'We have received your payment and are verifying it. Our team will confirm shortly.'
      });
    }

    const { rows } = await db.query(
      `UPDATE ${table}
         SET payment_status = 'paid', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = now()
       WHERE razorpay_order_id = $3 AND payment_status = 'unpaid'
       RETURNING id, contact_name, preferred_date, preferred_time_slot`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    );
    if (!rows.length) {
      // Lost the race with the webhook; either way the customer is fine.
      return res.json({ success: true, bookingId: booking.id });
    }

    const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (userRows.length) {
      sendBookingConfirmation({
        email: userRows[0].email,
        name: rows[0].contact_name,
        type: bookingType === 'puja' ? 'Puja' : 'Astrology consultation',
        preferredDate: rows[0].preferred_date,
        preferredTimeSlot: rows[0].preferred_time_slot
      }).catch((err) => logger.warn('Booking confirmation email failed', { bookingId: rows[0].id, message: err.message }));
    }
    res.json({ success: true, bookingId: rows[0].id });
  })
);

// ---------- Staff: list bookings ----------
// Neither list returns birth_details or contact details beyond what the queue
// view actually needs. The previous puja list used `pb.*`, which published
// every column including free-text notes on every row.
router.get('/puja', requireAuth, requireCapability(C.BOOKINGS_READ), asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const { rows } = await db.query(
    `SELECT pb.id, pb.user_id, pb.puja_type, pb.preferred_date, pb.preferred_time_slot, pb.preferred_mode,
            pb.status, pb.payment_status, pb.amount_paise, pb.contact_name, pb.contact_phone,
            pb.refund_id, pb.refunded_amount_paise, pb.created_at, pb.slot_id,
            bs.name AS service_name
     FROM puja_bookings pb
     LEFT JOIN booking_services bs ON bs.id = pb.service_id
     ORDER BY pb.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ bookings: rows });
}));

router.get('/astrology', requireAuth, requireCapability(C.BOOKINGS_READ), asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const { rows } = await db.query(
    `SELECT ab.id, ab.user_id, ab.consultation_mode, ab.preferred_date, ab.preferred_time_slot, ab.status,
            ab.payment_status, ab.amount_paise, ab.contact_name, ab.contact_phone, ab.created_at,
            ab.refund_id, ab.refunded_amount_paise, ab.slot_id, bs.name AS service_name
     FROM astrology_bookings ab
     LEFT JOIN booking_services bs ON bs.id = ab.service_id
     ORDER BY ab.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ bookings: rows });
}));

// ---------- Staff: astrology booking detail (includes birth_details) ----------
// The list endpoint above deliberately omits birth_details (sensitive under the
// DPDP Act 2023). This makes it available for staff to actually conduct the
// consultation, but only via an explicit single-record fetch — and every such
// read is now audit-logged, because "who accessed this person's date, time and
// place of birth, and when" is a question the Act expects to have an answer.
router.get('/astrology/:id', requireAuth, requireCapability(C.BOOKINGS_READ_SENSITIVE), asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT ab.id, ab.user_id, ab.service_id, ab.slot_id, ab.consultation_mode, ab.preferred_date,
            ab.preferred_time_slot, ab.scheduled_at, ab.status, ab.payment_status, ab.amount_paise,
            ab.contact_name, ab.contact_phone, ab.birth_details, ab.refund_id, ab.refunded_amount_paise,
            -- Restored. Narrowing this query from SELECT-star to an explicit
            -- column list dropped these two, and admin.html renders both in the
            -- Payment section. Its bookingRow() helper hides an empty value, so
            -- they silently vanished and there was no way to reconcile an
            -- astrology payment against Razorpay from the panel.
            -- razorpay_signature deliberately stays out: it is of no use to a
            -- human and does not belong in a response.
            ab.razorpay_order_id, ab.razorpay_payment_id,
            ab.created_at, ab.updated_at,
            bs.name AS service_name, bs.duration_label,
            u.name AS account_name, u.email AS account_email,
            p.full_name AS practitioner_name
     FROM astrology_bookings ab
     LEFT JOIN booking_services bs ON bs.id = ab.service_id
     LEFT JOIN users u ON u.id = ab.user_id
     LEFT JOIN availability_slots s ON s.id = ab.slot_id
     LEFT JOIN practitioners p ON p.id = s.practitioner_id
     WHERE ab.id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Booking not found.' });

  if (result.rows[0].birth_details) {
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
       VALUES ($1, 'read_sensitive', 'astrology_booking', $2, $3)`,
      // The detail records THAT sensitive data was read, never the data itself
      // — an audit log full of birth details would be a second copy of exactly
      // what the log exists to protect.
      [req.user.id, req.params.id, JSON.stringify({ field: 'birth_details' })]
    );
  }
  res.json({ booking: result.rows[0] });
}));

// ---------- Staff: single puja booking detail ----------
router.get('/puja/:id', requireAuth, requireCapability(C.BOOKINGS_READ), asyncHandler(async (req, res) => {
  const result = await db.query(
    `SELECT pb.*, bs.name AS service_name, bs.duration_label,
            u.name AS account_name, u.email AS account_email,
            p.full_name AS practitioner_name
     FROM puja_bookings pb
     LEFT JOIN booking_services bs ON bs.id = pb.service_id
     LEFT JOIN users u ON u.id = pb.user_id
     LEFT JOIN availability_slots s ON s.id = pb.slot_id
     LEFT JOIN practitioners p ON p.id = s.practitioner_id
     WHERE pb.id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking: result.rows[0] });
}));

const BOOKING_STATUSES = ['requested', 'confirmed', 'completed', 'cancelled'];

function bookingStatusRoute(table, typeLabel, entityType) {
  return asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (!BOOKING_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

    const outcome = await db.withTransaction(async (client) => {
      const { rows: before } = await client.query(
        `SELECT id, status, user_id, preferred_date, preferred_time_slot, slot_id, payment_status
           FROM ${table} WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!before.length) throw Object.assign(new Error('Booking not found.'), { status: 404 });
      const previous = before[0];

      const { rows } = await client.query(
        `UPDATE ${table} SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
        [status, req.params.id]
      );

      // Cancelling frees the seat. Without this a cancelled booking held its
      // slot forever and the practitioner's day looked full when it was not.
      if (status === 'cancelled' && previous.status !== 'cancelled' && previous.slot_id) {
        await client.query(
          `UPDATE availability_slots SET booked_count = GREATEST(booked_count - 1, 0), updated_at = now()
            WHERE id = $1`,
          [previous.slot_id]
        );
      }

      // Booking status changes were not audit-logged at all — only orders were.
      await client.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, detail)
         VALUES ($1, 'update_booking_status', $2, $3, $4)`,
        [req.user.id, entityType, req.params.id,
          JSON.stringify({ previousStatus: previous.status, newStatus: status, slotReleased: status === 'cancelled' && Boolean(previous.slot_id) })]
      );

      return { booking: rows[0], previous };
    }).catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });

    if (!outcome) return res.status(404).json({ error: 'Booking not found.' });

    (async () => {
      try {
        const b = outcome.booking;
        const { rows: userRows } = await db.query('SELECT name, email FROM users WHERE id = $1', [b.user_id]);
        if (userRows.length) {
          await sendBookingStatusUpdate({
            email: userRows[0].email, name: userRows[0].name, type: typeLabel, status: b.status,
            preferredDate: b.preferred_date, preferredTimeSlot: b.preferred_time_slot
          });
        }
      } catch (err) {
        logger.warn('Booking status email failed', { bookingId: req.params.id, message: err.message });
      }
    })().catch(() => {});

    res.json({ booking: outcome.booking });
  });
}

router.patch('/puja/:id/status', requireAuth, requireCapability(C.BOOKINGS_WRITE),
  bookingStatusRoute('puja_bookings', 'puja', 'puja_booking'));

router.patch('/astrology/:id/status', requireAuth, requireCapability(C.BOOKINGS_WRITE),
  bookingStatusRoute('astrology_bookings', 'astrology consultation', 'astrology_booking'));

// ---------- Admin: refund a booking payment (real money movement) ----------
// PAY-02 — routed through the shared refund ledger, so booking refunds get the
// same intent-first, crash-resolvable, partial-refund-aware treatment as orders.
router.post('/:type/:id/refund', requireAuth, requireCapability(C.BOOKINGS_REFUND), asyncHandler(async (req, res) => {
  const { type, id } = req.params;
  if (!['puja', 'astrology'].includes(type)) return res.status(400).json({ error: 'Invalid booking type.' });
  const table = type === 'puja' ? 'puja_bookings' : 'astrology_bookings';
  const entityType = type === 'puja' ? 'puja_booking' : 'astrology_booking';
  const { refundAmountPaise, reason } = req.body;

  const { rows } = await db.query(
    `SELECT id, payment_status, amount_paise, razorpay_payment_id FROM ${table} WHERE id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Booking not found.' });
  const booking = rows[0];

  // 'payment_review' is included deliberately. PAY-01 parks a booking there when
  // the gateway reported an amount or capture status that did not match — which
  // means money may well have moved. Excluding it left those bookings in a dead
  // end: not refundable, and with no other way to resolve them.
  if (!booking.razorpay_payment_id || !['paid', 'partially_refunded', 'payment_review'].includes(booking.payment_status)) {
    return res.status(409).json({ error: 'This booking has no captured payment to refund.' });
  }

  try {
    const result = await issueRefund({
      entityType,
      entityId: booking.id,
      razorpayPaymentId: booking.razorpay_payment_id,
      capturedTotalPaise: Number(booking.amount_paise),
      requestedAmountPaise: (refundAmountPaise === undefined || refundAmountPaise === null) ? null : Number(refundAmountPaise),
      adminUserId: req.user.id,
      restock: true, // for a booking this releases the slot rather than stock
      reason: reason || 'admin_initiated_booking_refund'
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error('Booking refund failed', err, { bookingId: id, type });
    res.status(500).json({ error: 'Could not process the refund. No money has been moved — please try again.' });
  }
}));

module.exports = router;
