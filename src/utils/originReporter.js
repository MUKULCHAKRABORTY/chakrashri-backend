/**
 * REPORTING AN UNKNOWN ORIGIN ONCE, NOT ONCE PER REQUEST.
 *
 * The CORS handler logs when a browser origin is not on the allow-list. That
 * line used to be written for every single request, and a single misconfigured
 * client — or a developer previewing the storefront from localhost — produced
 * several hundred of them in a couple of minutes. On a plan with limited log
 * retention that pushes real errors out of the window entirely, which is the
 * opposite of what a warning is for.
 *
 * So each distinct origin is reported at most once per interval, carrying a
 * count of how many further requests it made in between.
 *
 * WHY THIS IS ITS OWN FILE. It has two properties that are easy to get wrong and
 * impossible to see from the outside — the suppression window and the cap on how
 * many origins it will track — and both matter. Inline in server.js they could
 * only be tested by booting the server and reading log output; here they are
 * ordinary functions with an injectable clock.
 *
 * THE CAP IS NOT AN OPTIMISATION. An attacker can send unlimited distinct Origin
 * headers, one per request, and every one of them would otherwise become a
 * permanent Map entry. Without a bound, the thing added to stop a log flood
 * becomes a slower memory leak with exactly the same cause.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_TRACKED = 500;

/**
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]  how long to stay quiet about one origin
 * @param {number} [opts.maxTracked]  hard ceiling on remembered origins
 * @param {() => number} [opts.now]   injectable clock, so the window is testable
 *                                    without making a test sleep for a minute
 */
function createOriginReporter(opts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxTracked = opts.maxTracked ?? DEFAULT_MAX_TRACKED;
  const now = opts.now ?? Date.now;
  const seen = new Map();

  /**
   * @returns {null | { origin: string, suppressed: number }}
   *   the details to log, or null when this origin was reported recently.
   *   Returning the payload rather than logging keeps the decision and the
   *   side effect apart, which is what makes it testable.
   */
  function report(origin) {
    const at = now();
    const prev = seen.get(origin);
    if (prev && at - prev.at < intervalMs) {
      prev.suppressed++;
      return null;
    }
    const suppressed = prev ? prev.suppressed : 0;
    seen.set(origin, { at, suppressed: 0 });
    prune(at);
    return { origin, suppressed };
  }

  /* Drop anything past its window first, since those can never suppress
     anything again. Only if that is not enough does the whole thing go: losing
     the counters is a cosmetic loss, and unbounded growth is not. */
  function prune(at) {
    if (seen.size <= maxTracked) return;
    for (const [origin, entry] of seen) {
      if (at - entry.at >= intervalMs) seen.delete(origin);
    }
    if (seen.size > maxTracked) seen.clear();
  }

  return {
    report,
    /** Exposed for the test that proves the cap actually holds. */
    tracked: () => seen.size
  };
}

module.exports = { createOriginReporter, DEFAULT_INTERVAL_MS, DEFAULT_MAX_TRACKED };
