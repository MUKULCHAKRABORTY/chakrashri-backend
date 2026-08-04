# Chakrashri Backend — Production API

[🚀 **View Live Demo**](https://chakrashri.netlify.app)

This is a real, server-side backend for the Chakrashri storefront: Node.js + Express + PostgreSQL,
with genuine Razorpay payment processing, hashed-password authentication, and role-based admin access.
It's built to replace the browser-only demo (which used client-side storage and a hardcoded admin
password) with something that can safely take real orders and real money.

## Stack
- **Runtime:** Node.js 18+, Express
- **Database:** PostgreSQL (any managed host works: Railway, Render, AWS RDS, Supabase, DigitalOcean)
- **Payments:** Razorpay (order creation, signature verification, webhooks)
- **Auth:** JWT + bcrypt password hashing, role-based access control (customer / staff / admin)

## 📐 System Architecture

```mermaid
graph TD
    Client[Netlify Frontend / Client] -->|REST API / JWT Auth| Express[Node.js / Express API]
    Express -->|SELECT FOR UPDATE / Atomic Stock Locks| Postgres[(Neon PostgreSQL DB)]
    Express -->|Create Order / Signature Check| Razorpay[Razorpay Payment Gateway]
    Razorpay -->|Server-to-Server Webhook| Express
// Response (200 OK)
{
  "success": true,
  "razorpayOrderId": "order_Nz1234567890",
  "amountPaise": 149900,
  "currency": "INR"
}
// Response (200 OK)
{
  "success": true,
  "message": "Payment verified and order confirmed",
  "orderId": "ord_987654"
}

## Getting started

```bash
npm install
cp .env.example .env    # then fill in real values — see below
npm run migrate           # applies the schema (safe to re-run)
node scripts/create-admin.js "Your Name" you@chakrashri.com "a-strong-password"
npm run dev              # local development
npm start                # production
```

## Verifying against your real database and Razorpay account

**Important context:** the environment used to build this backend has no general outbound
network access (it can't reach the npm registry, the Razorpay API, or a raw Postgres port) — so
none of this has been tested against your real Neon database or Razorpay keys yet, only against
pure logic (21 unit tests, see `test/unit.test.js`) and static analysis. The steps below are how
*you* verify it for real, in an environment that does have network access (your own machine, a
cloud shell, or directly on your hosting provider).

```bash
npm install
cp .env.example .env        # then paste in your real DATABASE_URL, JWT_SECRET, RAZORPAY_* keys
npm run migrate              # applies the schema to your Neon database (safe to re-run — idempotent)
npm run verify                # runs unit tests + a real DB connectivity check + a real Razorpay check
```

`npm run verify` runs, in order:
1. **`test:unit`** — the 21 pure-logic tests (signature verification, GST/shipping math, stock-restoration idempotency).
2. **`test:db`** — connects to your real Neon database and checks: connection succeeds, SSL is
   actually in use, all 11 expected tables exist (i.e. the migration applied), the `pgcrypto`
   extension is enabled, write/delete permissions work, and row-level locking (`FOR UPDATE`,
   which the stock-reservation logic depends on) works.
3. **`test:razorpay`** — creates a real ₹1 test-mode order against your Razorpay test keys,
   fetches it back, and validates the signature-generation logic — confirming your keys actually
   authenticate, without needing a browser or test card.

If any check fails, it prints exactly which one and why (not just a stack trace) — paste that
output back for a fix rather than guessing.

### Manual end-to-end test (before go-live)

The scripts above can't fully simulate a browser completing Razorpay Checkout. Once the backend
is deployed and reachable over HTTPS, do one real manual pass: call `/api/payments/create-order`
with a real cart, open the returned `razorpayOrderId` in Razorpay Checkout using a
[Razorpay test card](https://razorpay.com/docs/payments/payments/test-card-upi-details/), and
confirm `/api/payments/verify` returns success and the order's `stock_qty` decremented correctly.

### A note on the credentials you shared

The database URL, JWT secret, and Razorpay test keys you provided are now in this chat's history.
The Razorpay keys are test-mode (`rzp_test_...`), so there's no real-money exposure there. For the
Neon database password specifically, standard practice once everything's verified working is to
rotate it in the Neon dashboard and store the new one only in your hosting provider's environment
variables (not back in a chat) — a small step, not urgent, just good hygiene before real customer
data lands in that database.

## Deploying to Render

This repo includes `render.yaml`, a Blueprint that defines both the API and the stock-expiry
cron job in one file — Render reads it automatically once your repo is connected, so you don't
manually configure two separate services by hand.

### 1. Push this code to GitHub
Render deploys from a Git repository, not a zip upload.
```bash
cd chakrashri-backend
git init
git add .
git commit -m "Initial commit"
```
Create a new repository on GitHub (github.com/new), then:
```bash
git remote add origin https://github.com/<your-username>/chakrashri-backend.git
git branch -M main
git push -u origin main
```
`.gitignore` already excludes `node_modules/` and `.env` — your real secrets won't be pushed.

### 2. Connect Render to the repo
1. Sign up / log in at [dashboard.render.com](https://dashboard.render.com) and connect your GitHub account.
2. Click **New** → **Blueprint**, and select the `chakrashri-backend` repo.
3. Render reads `render.yaml` and shows both services it's about to create (`chakrashri-api` and
   `chakrashri-expiry-sweep`). Click **Apply**.

### 3. Set the real secrets
`render.yaml` deliberately does **not** contain your actual credentials (`sync: false` means
"I'll set this manually") — this is why the file is safe to commit to a public or private repo.
For **both** services (the web service and the cron job), go to its **Environment** tab in the
Render dashboard and add:
- `DATABASE_URL` — your Neon connection string (the one already verified working)
- `JWT_SECRET` — the same one from your local `.env`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` — web service only, the cron job doesn't need these
- `CLIENT_URL` — your frontend's real domain once deployed; use a placeholder like `https://chakrashri.com` for now, update later (this only affects CORS)

Render redeploys automatically after you save environment variables.

### 4. Verify the deployment
Once the build finishes, Render gives you a URL like `https://chakrashri-api.onrender.com`.
```bash
curl https://chakrashri-api.onrender.com/api/health
# should return: {"status":"ok","time":"..."}
```
The database schema doesn't need re-migrating — it's the same Neon database you already verified
locally, migrations already applied there.

### 5. Point Razorpay's webhook at the live URL
In the Razorpay Dashboard → **Settings** → **Webhooks**, set the URL to:
```
https://chakrashri-api.onrender.com/api/payments/webhook
```
with events `payment.captured` and `payment.failed`, and confirm the webhook secret matches
`RAZORPAY_WEBHOOK_SECRET` in Render's environment settings.

### 6. Create your first real admin account
Run this from your own machine (it connects directly to Neon, same as before — doesn't need to run on Render):
```bash
node scripts/create-admin.js "Your Name" you@chakrashri.com "a-strong-password"
```

### 7. The one manual end-to-end test
Now that there's a real public HTTPS URL, this is the test that was previously impossible:
call `/api/payments/create-order` on the live URL, complete checkout with a
[Razorpay test card](https://razorpay.com/docs/payments/payments/test-card-upi-details/), and
confirm the webhook fires and `/api/payments/verify` marks the order paid. This closes the last
gap noted in Section 13 of the audit report.

## What else you need to obtain before going live

1. **PostgreSQL database** — already done (Neon, verified working).
2. **Razorpay account** — complete KYC at https://razorpay.com, get `KEY_ID` / `KEY_SECRET` from
   Dashboard → Settings → API Keys — already done (test-mode keys verified working; swap to live
   keys once KYC is fully approved and you're ready for real transactions).
3. **Hosting** — covered above (Deploying to Render). Still open: a **custom domain**
   (chakrashri.com instead of the default onrender.com subdomain) — point your domain's DNS at
   Render once purchased, and use HTTPS only, which Render provides automatically either way.
4. **SMTP provider** — for order confirmation emails (SendGrid, Postmark, AWS SES, or your domain's SMTP).
5. **GST registration** — required to legally issue tax invoices in India. `hsn_code` and `gst_rate`
   fields are already in the product schema; invoice PDF generation still needs to be built (see
   Roadmap in the audit report).
6. **Courier/shipping account** — e.g. Shiprocket, Delhivery, or Shyplite, for real tracking numbers
   and serviceability checks.

## Security notes (what changed vs. the demo)

- Admin login is no longer a hardcoded password visible in page source — it's a real hashed
  password check against the database (`src/routes/auth.routes.js`, `scripts/create-admin.js`).
- All payment amounts are recalculated server-side from the database at checkout — the server
  never trusts a total sent by the browser.
- Payments are verified two independent ways: (1) HMAC signature check right after checkout
  (`/api/payments/verify`), and (2) an authoritative Razorpay webhook
  (`/api/payments/webhook`) that fires server-to-server even if the customer's browser closes.
- Every write to products/orders goes through `requireAuth` + `requireRole`, and is logged to
  `admin_audit_log` — the old shared, publicly-writable storage model is gone.
- Money is stored as integer paise (`price_paise`, `total_paise`, etc.), never floating point,
  to avoid rounding errors in totals and tax.
- **Stock is reserved atomically at checkout, not just checked.** `/api/payments/create-order`
  locks the relevant product rows (`SELECT ... FOR UPDATE`) and decrements stock inside a single
  database transaction, so two customers racing for the last unit of an item cannot both succeed —
  this was tested and fixed during development (see `test/unit.test.js` for the cart-validation
  cases this closes, e.g. rejecting negative/zero/non-integer quantities that could otherwise
  corrupt totals).
- If the Razorpay order-creation call itself fails after stock is reserved, or a
  `payment.failed` webhook arrives, the reservation is released and stock is restored
  (`restoreOrderStock` in `src/utils/stock.js` — the single shared implementation used by the
  payment webhook, admin cancellations/refunds, and the abandoned-checkout expiry sweep, so all
  three paths behave identically rather than risking drift between duplicated logic).

### Abandoned-checkout expiry

If a customer reaches checkout (stock gets reserved) and then simply closes the tab — no payment
success, no `payment.failed` webhook either, since no payment attempt was ever made — that stock
would stay reserved indefinitely. `scripts/release-expired-orders.js` handles this: it finds
`orders` still `pending` after `ORDER_RESERVATION_EXPIRY_MINUTES` (default 30, set in `.env`) and
releases their reserved stock. **You need to schedule it to actually run** — it isn't triggered
automatically by anything in this codebase. Add it to your host's scheduler:

```bash
# example crontab entry, runs every 10 minutes
*/10 * * * * cd /path/to/chakrashri-backend && node scripts/release-expired-orders.js >> /var/log/chakrashri-expiry.log 2>&1
```

Render/Railway/Fly.io all have their own "Cron Job" / "Scheduled Task" equivalents if you'd
rather not manage a crontab directly.

## What's intentionally left as TODOs

These need product/business decisions from you, not just code, so they're marked `// TODO` in the
relevant files rather than guessed at:

- Transactional email/SMS content and provider (`utils/mailer.js` stub not yet built)
- Invoice PDF generation with correct GST breakdown
- Practitioner (pandit/astrologer) accounts and real-time availability calendar
- Shipping rate calculation and courier API integration
- Refund workflow via Razorpay's Refund API
- Image upload pipeline (Cloudinary/S3) for the admin product form

## Folder structure

```
src/
  config/       # db + razorpay clients
  middleware/   # auth (JWT + RBAC)
  routes/       # auth, products, payments, bookings, admin
  utils/        # stock.js — shared stock reservation/restoration logic
  server.js
migrations/     # SQL schema
scripts/        # create-admin.js, run-migrations.js, test-db-connection.js,
                # test-razorpay-connection.js, release-expired-orders.js
test/           # unit.test.js — 21 tests, no DB/network required
```
