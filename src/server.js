require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/products.routes');
const paymentRoutes = require('./routes/payments.routes');
const bookingRoutes = require('./routes/bookings.routes');
const adminRoutes = require('./routes/admin.routes');
const customerRoutes = require('./routes/customer.routes');
const addressRoutes = require('./routes/addresses.routes');
const bookingServicesRoutes = require('./routes/bookingServices.routes');
const couponRoutes = require('./routes/coupons.routes');
const siteRoutes = require('./routes/site.routes');
const db = require('./config/db');
const { normalizeOrigin } = require('./utils/cors');

const app = express();

// Render (like most PaaS hosts) sits behind a reverse proxy, so every
// incoming request's socket IP is Render's proxy, not the real client.
// Without trust proxy set, express-rate-limit and req.ip both see that one
// proxy IP for every visitor — meaning the "10 login attempts per 15 min"
// limiter would apply to your ENTIRE user base combined, not per-customer,
// so a handful of legitimate failed logins could lock everyone out of
// login/registration simultaneously. `1` trusts exactly one hop (Render's
// own proxy), which is correct for this deployment — trusting proxies
// blindly (`true`) would let a client spoof their IP via X-Forwarded-For.
app.set('trust proxy', 1);

// ---------- Security & infra middleware ----------
app.use(helmet());

// CORS: matches CLIENT_URL against the browser's actual Origin header.
// Origin headers never include a trailing slash or a path (they're always
// scheme://host[:port]), so a CLIENT_URL value with a trailing slash — an
// easy copy-paste mistake — would silently fail every cross-origin request
// with no useful error beyond a generic CORS rejection in the browser
// console. Normalizing both sides here closes that specific failure mode.
const allowedOrigin = normalizeOrigin(process.env.CLIENT_URL);
app.use(
  cors({
    origin: allowedOrigin || undefined,
    credentials: true
  })
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(cookieParser());

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '200', 10),
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Razorpay webhook needs the RAW body for signature verification —
// mount it BEFORE express.json() and only for that one path.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));

// ---------- Routes ----------
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/booking-services', bookingServicesRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/site', siteRoutes);

// ---------- 404 + error handling ----------
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`Chakrashri API listening on port ${PORT}`));

// Render (and most hosts) send SIGTERM before killing a process during a
// deploy or restart. Without handling it, in-flight requests — including a
// checkout mid-transaction, holding a row lock on products — get cut off
// abruptly. This stops accepting new connections, lets existing requests
// finish, then closes the database pool cleanly.
function shutdown(signal) {
  console.log(`${signal} received: closing server gracefully...`);
  server.close(async () => {
    try {
      await db.pool.end();
    } catch (err) {
      console.error('Error closing DB pool:', err.message);
    }
    console.log('Shutdown complete.');
    process.exit(0);
  });
  // Safety net: if something hangs (e.g. a stuck connection), don't let the
  // process wait forever — force-exit after a bounded grace period.
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
