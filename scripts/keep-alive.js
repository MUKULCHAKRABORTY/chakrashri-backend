/**
 * KEEP-ALIVE — #20
 *
 * Render's free plan spins a service down after ~15 minutes of inactivity, and
 * the next request pays a ~50s cold start. That is the direct cause of the
 * "Could not reach the server" popups on admin login, and of Razorpay webhooks
 * timing out (which is worse — a customer is charged but the order stays
 * pending until the reconciliation script catches it).
 *
 * Honest framing, because this matters for your decision:
 *
 *   The ONLY way to genuinely guarantee 24/7 with no cold starts is a paid
 *   instance (Render Starter, ~$7/month). That is the real fix.
 *
 *   This script is a workaround: pinging /api/health every ~10 minutes keeps
 *   the instance warm. Render's free tier allows 750 instance-hours/month and
 *   a month is ~730 hours, so ONE service kept awake continuously fits — but
 *   only just, and only if you run exactly one free service. Add a second and
 *   you will exhaust the quota partway through the month and the site will go
 *   down until it resets. Render may also change these limits.
 *
 * Run this on something that is itself always awake — NOT on the Render
 * service being pinged (a sleeping service cannot ping itself). Good options:
 *   • A free uptime monitor (UptimeRobot, cron-job.org, Better Stack) hitting
 *     https://your-api.onrender.com/api/health every 10 minutes. Simplest, and
 *     you get downtime alerts as a bonus. Recommended.
 *   • GitHub Actions on a schedule (see .github/workflows/keep-alive.yml).
 *   • This script on any machine that stays on.
 *
 * Run: node scripts/keep-alive.js
 */
const https = require('https');
const http = require('http');

const TARGET = process.env.KEEPALIVE_URL || 'https://chakrashri-api.onrender.com/api/health';
const INTERVAL_MIN = parseInt(process.env.KEEPALIVE_INTERVAL_MIN || '10', 10);

function ping() {
  const client = TARGET.startsWith('https') ? https : http;
  const started = Date.now();
  const req = client.get(TARGET, { timeout: 60000 }, (res) => {
    res.resume(); // drain, we only care about the status
    const ms = Date.now() - started;
    const note = ms > 5000 ? '  (slow — instance was likely asleep and just cold-started)' : '';
    console.log(`[${new Date().toISOString()}] ${res.statusCode} in ${ms}ms${note}`);
  });
  req.on('timeout', () => { req.destroy(); console.warn(`[${new Date().toISOString()}] timed out after 60s`); });
  req.on('error', (err) => console.error(`[${new Date().toISOString()}] ${err.message}`));
}

console.log(`Keep-alive started: pinging ${TARGET} every ${INTERVAL_MIN} min. Ctrl+C to stop.`);
ping();
setInterval(ping, INTERVAL_MIN * 60 * 1000);
