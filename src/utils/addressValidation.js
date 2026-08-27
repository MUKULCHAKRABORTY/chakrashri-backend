/**
 * Address field validation, extracted so it is unit-testable without an HTTP
 * layer and so checkout and the address book can never diverge on what counts
 * as a deliverable address.
 *
 * WHY THIS MATTERS COMMERCIALLY, not just technically: the old rules were
 * `pincode: isLength({min:4,max:10})` and `phone: notEmpty()`. A typo'd PIN or
 * an unreachable phone number was accepted at checkout, charged, packed, and
 * only failed at the courier's API or at the customer's door — by which point
 * the cost is a return-to-origin, not a form error.
 */

/**
 * Indian PIN codes are exactly six digits and never begin with 0. Non-Indian
 * addresses fall back to a permissive but non-empty rule, since postal formats
 * vary far too much to enumerate.
 */
function pincodeProblem(pincode, country) {
  const value = String(pincode || '').trim();
  const isIndia = !country || /^india$/i.test(String(country).trim());
  if (isIndia) {
    if (!/^[1-9][0-9]{5}$/.test(value)) return 'Please enter a valid 6-digit PIN code.';
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9\s-]{2,11}$/.test(value)) return 'Please enter a valid postal code.';
  return null;
}

/**
 * Accepts +91 XXXXXXXXXX, 0XXXXXXXXXX and bare 10-digit Indian mobiles, plus
 * general international forms. Indian mobile numbers always start with 6-9;
 * a 10-digit number starting with anything else is a landline written without
 * its STD code, which a delivery agent cannot call.
 */
function phoneProblem(phone) {
  const digits = String(phone || '').replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(digits)) return 'Please enter a valid phone number.';
  const indian = digits.replace(/^(\+91|91|0)/, '');
  if (/^[0-9]{10}$/.test(indian) && !/^[6-9]/.test(indian)) {
    return 'Please enter a valid Indian mobile number.';
  }
  return null;
}

module.exports = { pincodeProblem, phoneProblem };
