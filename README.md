# Chakrashri Backend — Production API

This is a real, server-side backend for the Chakrashri storefront: Node.js + Express + PostgreSQL,
with genuine Razorpay payment processing, hashed-password authentication, and role-based admin access.
It's built to replace the browser-only demo (which used client-side storage and a hardcoded admin
password) with something that can safely take real orders and real money.

## Stack
- **Runtime:** Node.js 18+, Express
- **Database:** PostgreSQL (any managed host works: Railway, Render, AWS RDS, Supabase, DigitalOcean)
- **Payments:** Razorpay (order creation, signature verification, webhooks)
- **Auth:** JWT + bcrypt password hashing, role-based access control (customer / staff / admin)

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

**A note on the free tier:** Render's free web-service tier spins down after inactivity, adding a
delay before the first request wakes it back up — this can cause Razorpay's webhook to time out
waiting for a response. `render.yaml` above specifies the `starter` (paid) plan for exactly this
reason; downgrade to `free` only for early testing, not for anything meant to reliably receive
webhooks.

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

- SMS/WhatsApp notifications (email is built — see "Round 4" below — but SMS/WhatsApp needs a
  provider account, e.g. MSG91/Twilio/Gupshup; `.env.example` has placeholder keys for this)
- Invoice PDF generation with correct GST breakdown (the data — `hsn_code`, `gst_rate`,
  `gst_paise` — is all captured; only the PDF rendering step is left)
- Practitioner (pandit/astrologer) accounts and real-time availability calendar (bookings are
  captured and staff can confirm/complete them, but there's no assignment-to-a-specific-person system yet)
- Shipping rate calculation and courier API integration (tracking number/courier name fields
  exist on orders; the actual rate lookup and courier API call are not wired up)

## Folder structure

```
src/
  config/       # db + razorpay clients
  middleware/   # auth (JWT + RBAC)
  routes/       # auth, products, payments, bookings, admin, customer
  utils/        # stock.js, orders.js, crypto.js, cors.js, mailer.js — see "Round 4" below
  server.js
migrations/     # SQL schema (001 initial, 002 constraints + refund columns, 003 password reset)
scripts/        # create-admin.js, run-migrations.js, test-db-connection.js,
                # test-razorpay-connection.js, release-expired-orders.js
test/           # unit.test.js — tests against the REAL application modules, see "Round 4" below
```

## Round 6 — Bookings Never Actually Charged, Order History Silently Broken, Product Detail Data Gaps

Three more real, live bugs — found by reading the actual deployed code, same discipline as every
round before this:

**Puja and astrology bookings collected zero money and were invisible everywhere.**
`confirmPujaBooking()` / `confirmAstroBooking()` in the frontend were 100% fake: they validated
the form, generated a random fake "Booking ID" locally, and showed a success message — no API
call happened at all, no payment was ever collected, and nothing was ever saved to the database.
This is why bookings never appeared in the admin dashboard or the customer's own view: they never
existed anywhere except a modal that briefly appeared and vanished. Fixed with a complete real
implementation:
- `booking_services` table (migration 004) — puja/astrology pricing is now a real, server-side
  source of truth instead of hardcoded frontend JavaScript, seeded with the same services/prices
  that were previously only in the frontend so the catalog isn't empty after migrating.
- `src/utils/bookingPayments.js` — creates a booking and a real Razorpay order together, with the
  price looked up server-side (the client is never trusted for the amount), mirroring the same
  "never trust the client for money" principle as product checkout.
- `POST /api/bookings/verify-payment` — signature-verified, ownership-checked payment confirmation,
  and the Razorpay webhook now also handles booking payments (distinguished from product-order
  payments via `notes.bookingType`), so bookings get the same server-to-server payment confirmation
  resilience that orders already had.
- The frontend's booking confirmation functions were rewritten to actually call these endpoints and
  open a real Razorpay Checkout modal, exactly mirroring the proven product-checkout pattern.
- A customer's booking history is now visible — no such view existed before at all — appended to
  the Orders page, since a customer's "my activity" is naturally one place to check both.
- **A new admin dashboard section ("Booking Services")** lets you actually manage puja/astrology
  pricing and descriptions, since this was previously only changeable by editing frontend code.

**Order history showed "No orders found" even after a successful real payment.** Root cause: the
frontend was calling `apiFetch('/api/orders')`, a URL that has never existed on this backend — the
real endpoint is `/api/customer/orders`. The request 404'd, was silently caught, and the order list
was set to empty. There was also a second, smaller bug underneath it: the rendering code expected
camelCase fields (`orderNumber`, `totalPaise`) but this backend correctly returns snake_case
(`order_number`, `total_paise`) — so even after fixing the URL, totals would have shown as ₹0. Both
fixed with the correct endpoint and correct field names.

**Product descriptions and photos were saved correctly but never shown to customers.** The admin
dashboard correctly writes `short_desc`, `long_desc`, `material`, and images to the real database
— that part always worked. The bug was entirely on the storefront's read side: the product detail
page only ever used data from the lightweight product *list* endpoint (`GET /api/products`), which
deliberately returns a smaller field set for a fast shop-grid payload, and doesn't include long
descriptions or images at all. The detail page never called the separate full-detail endpoint
(`GET /api/products/:slug}`) that actually has this data. Fixed with progressive enhancement: the
page still renders instantly from the fast list data, then fetches the full record in the
background and fills in the real description and real uploaded photos (falling back to the
existing decorative category icon if a product has no photos yet, or if an image URL fails to load).

### A note on the blog: moving to Sanity.io instead of a custom CMS

An earlier round added a `blog_posts` table and a `featured_image_url` column to this backend in
anticipation of building a custom blog admin panel. Per a later decision, the blog is instead
being rebuilt on **Sanity.io** (headless CMS, Portable Text, statically generated) — a completely
different, separate architecture from this Express/Postgres backend, covered in its own setup
guide rather than in this repo. The `blog_posts` table remains in the schema, unused, and is safe
to leave alone or drop later; it does no harm sitting idle.

## Round 5 — Admin Dashboard, Missing Addresses Endpoint, and a Critical Checkout Bug

Two things were reported as broken on the live site: no visible/working admin dashboard, and
checkout not completing properly. Investigating both against the actual deployed `index.html`
(not guessed at) found the real causes:

**Root cause of "admin dashboard not visible":** the admin panel built into the original
`index.html` prototype was never connected to the real backend — it only writes to browser-local
storage (`window.storage`), using fake locally-generated IDs like `usr-172847...` instead of real
database UUIDs. Any product "added" through it never reached Postgres and was silently overwritten
the next time the storefront loaded real data from `/api/products`. This is also very likely why
the storefront had little or nothing real to sell: **a genuinely separate, professional admin
dashboard (`admin.html`) has been built** — a full single-page app talking directly to the real,
JWT-authenticated backend API, covering: a live-data overview with revenue/order-status charts,
full product management (create/edit/delete/deactivate, image management, stock, GST/HSN fields),
order management (status pipeline, tracking numbers, real Razorpay refunds), puja and astrology
booking management (including birth-detail access for staff conducting consultations), a customer
list with lifetime value, and a full audit log viewer. See "Deploying the admin dashboard" below.
The old admin panel inside `index.html` should be considered retired — using it will not affect
the real store, which is more confusing than it being simply broken, so removing or hiding its
entry point in `index.html` is recommended (not done automatically here, since that file is large
and out of this backend repo's scope to edit blindly).

**A critical, live checkout bug:** the storefront's checkout code calls a single endpoint
(`POST /api/payments/create-order`) and sends `paymentMethod: 'cod'` or `'razorpay'` in the body to
choose between them. The backend, however, had two separate endpoints — `/create-order` always
hardcoded to Razorpay regardless of what was sent, and a second `/create-cod-order` that the front
end never actually called. **The practical effect: selecting "Cash on Delivery" on the live site
still silently opened the Razorpay payment popup**, because the backend never looked at
`paymentMethod` at all. Fixed by consolidating into the one endpoint the front end actually calls,
branching correctly on `paymentMethod`.

**A missing endpoint that would have meant undeliverable orders:** the checkout flow calls
`POST /api/addresses` to save the shipping address before creating the order — but this endpoint
did not exist anywhere in the backend. It failed silently (caught and ignored by the front end),
meaning a fully paid order could be created with `shipping_address_id = NULL` — a paid order with
nowhere to ship the product. A real address CRUD endpoint (`src/routes/addresses.routes.js`) now
exists, and — since the endpoint now works — a shipping address is a hard requirement for placing
any order, rather than a silently-optional field.

### Deploying the admin dashboard

`admin.html` (delivered alongside this backend) is a separate static file — deploy it to the same
Netlify site as a second page (e.g. `https://chakrashri.netlify.app/admin.html`), the same way
`index.html` is deployed; it needs no build step and no server changes beyond what's already in
this repo. It reads `window.__API_BASE__` the same way `index.html` does, so if that's already set
correctly in your Netlify deployment, no further configuration is needed. Log in with the admin
account created via `scripts/create-admin.js`.

## Round 4 — Independent Audit Response

An independent technical audit of this codebase (conducted separately, not by the same process
that built it) found several real issues — most seriously, a bug where the same product listed
twice in one cart could pass two independent stock checks and oversell, because the earlier test
suite tested a reimplementation of the cart logic rather than the actual production code. That
specific criticism was taken seriously and addressed structurally, not just patched:

**Critical fixes:**
- **Duplicate cart item oversell** — cart items are now aggregated by product ID *before* any
  stock check, inside a single locked database transaction (`src/utils/orders.js`,
  `validateAndAggregateCart`). The stock-decrement `UPDATE` also now has a `WHERE stock_qty >= $1`
  guard as a second, independent backstop — even if application logic were ever wrong again, the
  database itself refuses to let stock go negative.
- **Timing-unsafe signature comparison** — `/verify` and the Razorpay webhook previously compared
  HMAC signatures with plain `!==`, which leaks microsecond timing differences based on where the
  first mismatched byte occurs. Replaced with `crypto.timingSafeEqual` (`src/utils/crypto.js`).
- **Admin login validation bug** — `express-validator`'s rules were declared on the admin login
  route but the code never actually checked `validationResult()`, so malformed input fell through
  to the database query instead of getting a clean 400.
- **Login timing side-channel (user enumeration)** — a login attempt for a non-existent email
  returned instantly, while a wrong password for a real account spent ~100ms+ in `bcrypt.compare`.
  Both paths now always run `bcrypt.compare` (against a precomputed dummy hash when no user is
  found), so response time no longer reveals which emails have accounts.
- **Refunds didn't actually refund anything** — marking an order "refunded" only changed a status
  column; the customer's money never moved. The admin order-status endpoint now calls Razorpay's
  real Refunds API and records the resulting `refund_id` (migration 002). A paid order can no
  longer be silently "cancelled" either — that combination used to restore stock and hide the
  order while Razorpay still showed the payment as captured, meaning a customer could pay and the
  order would just vanish from view with no refund. Cancellation is now blocked once money has
  moved; "refunded" is the only path back, and it actually returns the money.

**Also fixed:** `trust proxy` wasn't set (meant the login rate limiter could have applied to
Render's proxy IP for *everyone* combined, not per-visitor); no graceful shutdown (in-flight
checkouts holding a database lock could be cut off mid-transaction during a Render redeploy);
`DB_SSL` was hardcoded to skip certificate verification (`rejectUnauthorized: false`) even though
Neon's certificates are publicly trusted and don't need that; JWT verification didn't pin the
signing algorithm; order numbers used low-entropy trailing timestamp digits that could collide
under real concurrent traffic (now high-entropy random with a retry-once fallback);
`create-admin.js` always exited `0` even on failure, which would look like success in a deploy
script; `render.yaml` didn't pin a region (now `ohio`, matching Neon's `us-east-2`); database-level
`CHECK` constraints were added as a backstop against negative prices/stock and invalid status
values, independent of whatever application code does (migration 002); `multer` and `uuid` were
listed as dependencies but never actually used anywhere in the code, and `multer` specifically had
known vulnerabilities flagged by `npm install` — both removed.

**New, previously missing functionality:** password reset (`/api/auth/forgot-password`,
`/api/auth/reset-password` — tokens are stored only as a SHA-256 hash, never in plain text, expire
in 30 minutes, and are single-use); customer-facing order and booking history
(`/api/customer/orders`, `/api/customer/bookings/*` — this route file existed from earlier work
but was never actually mounted in `server.js`, so it was unreachable dead code until this pass);
staff endpoints to actually view astrology booking details and update booking status (previously,
bookings could be created but staff had no way to retrieve the details needed to conduct a
consultation, or mark anything confirmed/completed); Cash-on-Delivery as a full second checkout
path sharing the same stock-reservation logic as Razorpay; order-confirmation and
booking-confirmation emails (`src/utils/mailer.js` — fails safe and just logs if SMTP isn't
configured, never blocks the underlying order/booking from succeeding); admin image management via
URL rather than file upload (Render's disk doesn't persist across deploys, so a local-file-upload
endpoint would have silently lost every image on the next deploy — this sidesteps that entirely).

**Test suite rebuilt to test the real code, not a copy of it.** This directly addresses the
audit's central criticism. The suite now imports the actual `src/utils/*.js` modules rather than
reimplementing their logic locally, and includes a genuine end-to-end test: the real
`reserveStockAndCreateOrder` function, run against a mocked (but behaviorally accurate) database
client, proving the exact duplicate-cart-item scenario is rejected before any stock is touched.
This was verified two ways, not just written and assumed correct: run as-is (31/31 pass), then the
aggregation fix was deliberately reintroduced as broken and the suite was re-run to confirm it
correctly fails — then the fix was restored and the suite re-run again to confirm it passes. Both
the pure-logic test and the mocked end-to-end test caught the reintroduced bug.
