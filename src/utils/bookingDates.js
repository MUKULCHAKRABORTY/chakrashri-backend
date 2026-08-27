/**
 * Booking date validation in the customer's timezone — closes BIZ-06.
 *
 * THE PROBLEM
 * The original check was, in effect, `new Date(value) < todayAtMidnight()`. On
 * Render that runs in UTC, 5.5 hours behind IST. Between 00:00 and 05:30 IST,
 * "today" in Kolkata is still yesterday in UTC — so a customer booking a puja
 * for the current day at 6am was told their date was in the past, with no way to
 * proceed and no explanation that made sense to them.
 *
 * It is a small window, but it is the early-morning window, which for a business
 * selling pujas is not an incidental one.
 *
 * WHY en-CA
 * Intl.DateTimeFormat('en-CA') formats as YYYY-MM-DD. That is the one common
 * locale whose output is directly comparable, as a string, with the ISO date the
 * client sends — no parsing, no Date arithmetic, no second timezone conversion
 * to get wrong.
 */

const BOOKING_TZ = process.env.BOOKING_TIMEZONE || 'Asia/Kolkata';

/** Today's date in the booking timezone, as YYYY-MM-DD. */
function todayInBookingTz(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BOOKING_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now || new Date());
}

/**
 * express-validator custom validator: throws with a customer-facing message.
 * Also caps how far ahead a booking can be — a request for 2087 is a data-entry
 * error or a probe, and letting it through means it sits in the admin queue
 * forever.
 */
function isTodayOrFuture(value) {
  const requested = String(value).slice(0, 10); // ISO date portion
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    throw new Error('Preferred date must be a valid date.');
  }
  if (requested < todayInBookingTz()) {
    throw new Error('Preferred date cannot be in the past.');
  }
  const oneYearOut = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (requested > oneYearOut) {
    throw new Error('Please choose a date within the next year.');
  }
  return true;
}

module.exports = { isTodayOrFuture, todayInBookingTz, BOOKING_TZ };
