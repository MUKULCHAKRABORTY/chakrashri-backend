const crypto = require('crypto');

/**
 * Constant-time comparison for HMAC signatures. A plain `===`/`!==` string
 * comparison returns fractionally faster the sooner it hits a mismatched
 * character, which is a textbook timing side-channel for secrets compared
 * this way — in principle, an attacker with enough attempts and a stable
 * network path could use those timing differences to recover a valid
 * signature byte-by-byte. crypto.timingSafeEqual() takes the same amount of
 * time regardless of where the first mismatch occurs.
 *
 * timingSafeEqual() throws if the two buffers aren't the same length (rather
 * than returning false), so the length check must happen first — and doing
 * it as a plain `!==` on `.length` is fine, since leaking the *length* of a
 * fixed-size hex-encoded HMAC digest (always 64 chars for SHA-256) reveals
 * nothing useful.
 */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    // Buffer.from(..., 'hex') on a non-hex string doesn't throw — it just stops
    // parsing early, which can produce mismatched buffer lengths and make
    // timingSafeEqual itself throw. Any error here means "not a valid match".
    return false;
  }
}

module.exports = { timingSafeEqualHex };
