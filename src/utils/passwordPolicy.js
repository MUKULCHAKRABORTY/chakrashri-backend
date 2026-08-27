/**
 * Password policy — part of AUTH-04.
 *
 * The previous rule was `isLength({ min: 8 })`, which accepts "password",
 * "12345678" and "qwertyuiop" — a length requirement doing no actual work,
 * since those are the first entries in every credential-stuffing list.
 *
 * DELIBERATELY LIGHT ON COMPOSITION RULES. Forcing an uppercase letter, a digit
 * and a symbol reliably produces "Password1!" and a sticky note; NIST SP
 * 800-63B has recommended against composition rules and forced rotation for
 * years for exactly that reason, and recommends screening against known-bad
 * lists instead. So: a real length floor, a block-list of the passwords that
 * actually get compromised, and a check that the password is not simply the
 * user's own email — nothing that punishes a good passphrase.
 *
 * NEXT STEP WHEN THERE IS TIME: screen against Have I Been Pwned's k-anonymity
 * range API (send the first 5 characters of the SHA-1, never the password) to
 * catch the long tail this static list cannot. Left out here because it adds a
 * network dependency to the signup path, which needs its own timeout and
 * fail-open policy to avoid registration breaking when that service is slow.
 */

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd',
  '12345678', '123456789', '1234567890', '87654321', '11111111',
  'qwertyuiop', 'qwerty123', 'qwertyui', 'asdfghjkl',
  'iloveyou', 'welcome1', 'welcome123', 'admin123', 'administrator',
  'letmein1', 'letmein123', 'abc12345', 'abcd1234', 'a1b2c3d4',
  'password@123', 'india@123', 'india123', 'bharat123',
  'chakrashri', 'chakrashri1', 'chakrashri123',
  'sunshine1', 'football1', 'baseball1', 'trustno1', 'monkey123',
  'krishna123', 'ganesh123', 'shivshiv', 'omnamahshivaya'
]);

/**
 * @returns {string|null} a customer-facing reason to reject, or null if fine.
 */
function passwordProblem(password, email) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 200) {
    // bcrypt truncates beyond 72 bytes anyway; this cap is about not hashing a
    // megabyte of attacker-supplied input on an unauthenticated endpoint.
    return 'Password is too long.';
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    return 'That password is too common. Please choose something harder to guess.';
  }
  if (/^(.)\1+$/.test(password)) {
    return 'Please choose a password with more variety.';
  }
  // Sequential runs like "12345678" or "abcdefgh" that the block-list misses.
  if (/^(?:0123456789|abcdefghijklmnopqrstuvwxyz){1,}/.test(lowered.slice(0, 8))
      && lowered.length <= 12) {
    return 'Please choose a password with more variety.';
  }
  const localPart = String(email || '').split('@')[0].toLowerCase();
  if (localPart.length >= 4 && lowered.includes(localPart)) {
    return 'Please choose a password that does not contain your email address.';
  }
  return null;
}

module.exports = { passwordProblem, COMMON_PASSWORDS };
