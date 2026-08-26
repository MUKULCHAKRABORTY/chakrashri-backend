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

## Round 13b — #21 Gaps Closed and #25 Mobile Fixes

**#21 — two gaps found on re-check.** Badges are now stored lowercase
(migration 012), but the storefront rendered custom badges verbatim, so a badge
saved as "certified" displayed as *certified* rather than *Certified*. The
storefront now title-cases badges and categories using the same rule as the
backend's `displayTerm()`, so a value reads identically everywhere it appears.
The admin category/badge fields also gained `datalist` suggestions listing what
is already in use — normalisation already prevents duplicates, but showing the
existing values prevents the confusion at the point it occurs.

**#25 — checkout on small screens.** The only mobile rule was a single
`grid-template-columns:1fr` at 900px; nothing below that. On a phone the 32px
card padding, the fixed 40px step-indicator separators and the payment provider
tag rows (GPay/PhonePe/Paytm, Visa/Mastercard/RuPay) all competed for space and
pushed the layout past the viewport. Added proper 640px and 400px breakpoints
covering padding, the step indicator, payment blocks, summary lines and field
rows — including `min-width:0` on the flex/grid children, which is what
actually allows them to shrink below their content width instead of overflowing.

One detail worth noting: at 400px the step labels ("Cart", "Details & Payment")
need to disappear, but they are bare text nodes rather than elements, so
`display:none` on a child could never have worked. Collapsing them with
`font-size:0` on the step and restoring the size on the `.num` child is the
correct approach for unwrapped text.

**#25 — admin topbar.** It had no mobile rules at all, and adding the Clear
Site Cache button in the previous round made an existing squeeze into a genuine
overflow: menu toggle + title + subtitle + two labelled buttons on one
non-wrapping row. The buttons are now grouped in a wrapper that wraps as a
unit, collapse to icon-only below 700px, and the subtitle is dropped to give
the title room.

Verified additive-only: sections 24, pages 14, modals 4 (unchanged), functions
198 -> 199 (+1). 60/60 tests pass.

## Round 13 — Tasks 19-24

**#19 — variant edits not updating product total.** Two real causes, both fixed:

1. `stock_qty` was in the product PUT's allowed fields. The product form always
   posts that field, so clicking **Save Product** wrote the stale number from
   the form straight over the freshly-calculated total — which is exactly the
   reported symptom. The server now ignores `stock_qty` for any product that
   has variants (silently, because the value isn't the admin's to set and
   failing the whole save would block legitimate edits to name/price).
2. The trigger only recalculated while the product still had variant rows, so a
   HARD delete of the last variant left the old total frozen in place — stale
   stock that could still be sold. It is now unconditional, and resets to 0
   when the last variant goes.

The admin form now also shows that stock field as read-only with an explanation
when variants exist, and refreshes the derived total immediately after any
variant is added, edited or removed — so the rule is visible rather than
surprising.

**#20 — Render free-tier sleeping.** Being straight about this: the only way to
genuinely guarantee no cold starts is a paid instance (~$7/month). Everything
else is a workaround. Two are provided — `.github/workflows/keep-alive.yml`
(runs on GitHub's infrastructure, so it works with your machine off) and
`npm run keep-alive`. **The free tier allows 750 instance-hours/month against a
~730-hour month, so keeping ONE service awake fits — just barely, and only if
you run exactly one free service.** A dedicated uptime monitor (UptimeRobot,
cron-job.org) is the most reliable free option and alerts you on real downtime.

**#21 — duplicate categories/badges.** These were free text, so "Malas",
"malas" and " MALAS " became three separate filter entries. They are now stored
canonically (trimmed, whitespace-collapsed, lowercased) and title-cased for
display. Migration 012 merges existing duplicates, and empty-string badges
collapse to NULL.

**#22 — booking order.** The two booking arrays were concatenated, so every
puja appeared above every astrology booking regardless of date — a consultation
booked this morning sat below a puja from months ago. Now merged into one list
sorted by booking time, newest first.

**#23/#24 — "Could not reach the server".** Not a connection problem on the
admin's end: both API wrappers did a single fetch with no retry and no timeout,
so the first request after the API had been idle failed outright and the
message wrongly blamed their network. Both now retry with backoff and a 30s
ceiling, with an honest message about the server starting up.

The retry policy is deliberately **asymmetric**, which is the important part:
GET and login retry automatically (safe to repeat), but other writes do **not**.
A network error never tells you whether the request reached the server, so
blindly retrying a POST could create a second order, a second refund or a
duplicate coupon. Those surface a message telling the admin to check before
retrying, keeping that decision explicit rather than silently risking a double
charge.

Verified additive-only: sections 24, pages 14, modals 4, drawers 2 (unchanged),
functions 197 -> 198 (+1). 60/60 tests pass.

## Round 12b — Word-by-Word Re-Read Caught Three Skipped Requirements

Re-read every task text literally rather than trusting a summary. Three specific
sentences had been passed over:

**"If varient select and mind change then they can deselect by tapping again"** —
not implemented. Tapping an already-selected swatch simply re-selected it, so a
customer who changed their mind had no way to clear the choice short of
reloading. Tapping the active value now clears it, and clearing the selection
restores the product's own images (previously a variant photo would linger on
screen after its selection was gone).

**"In product view of customer side, add 'Varients' to see then all varient
details"** — only a selector existed, not a details view. There is now a
**Variants** tab on the product page listing every combination with its own
photo, options (with colour dots), price and live stock, so a customer can
compare them all at once. The tab hides itself for products without variants.

**"that is how stock status should be seen in the admin dashboard products
section"** — the admin products table showed a bare number with no indication
it was derived. It now shows the total plus "sum of N variants" for
variant-backed products, because the derived figure and a directly-managed one
are edited in completely different places and confusing the two would lead an
admin to try editing a number that is recomputed by a trigger.

Verified additive-only afterwards: sections 24, pages 14, modals 4, drawers 2
(all unchanged), functions 196 → 197 (+1, the new renderer). All 18 major
homepage/site sections re-confirmed present, all onclick handlers resolve, all
tags balanced, 54/54 tests pass.

## Round 12 — Tasks 6 and 8 Completed (all 18 now done)

**#8 — mobile layout.** On small screens the animated chakra now sits at the
top, directly under the navbar, with the hero copy beneath it. Implemented with
flex `order` rather than moving markup, so the desktop layout and the DOM are
byte-for-byte unchanged — the reorder exists only inside the mobile media
query. The chakra is also scaled down on mobile so it doesn't push the
headline and CTAs below the fold.

The mobile **Shop** menu previously only expanded/collapsed — there was no way
to reach the full catalogue from it at all. It is now a split tap target
(industry standard for mobile nav): tapping the "Shop" label goes straight to
all products, tapping the chevron expands the category list. `aria-expanded`
is kept in sync for screen readers.

**#6 — homepage puja showcase and product-section polish.** A new Puja
Services section sits between Featured Products and the existing promo band,
populated from the **same `booking_services` catalog** the booking page uses —
so a price edited in the admin appears here immediately and the two can never
disagree. Each card deep-links into the booking flow with that puja already
selected and the detail steps open, removing a step rather than dropping the
visitor on a generic page. The section hides itself entirely when no services
are configured rather than rendering an empty band.

Commercial polish: cards lift and reveal a gold accent bar on hover, icons
rotate subtly, the primary CTA carries a slow attention pulse, and product
images zoom gently within their frame. All hover motion is disabled on touch
devices (where it causes sticky states) and all animation is disabled under
`prefers-reduced-motion`.

**Integrity check.** Verified purely additive against the pre-edit baseline:
sections 23 → 24 (+1, the new one), functions 194 → 196 (+2, the new ones),
element IDs 228 → 230 (+2). Page sections (14), modals (4) and drawers (2) all
unchanged. Every major section re-confirmed present, all onclick handlers
resolve, all tags balanced, 54/54 tests pass.

## Round 11b — Pre-Push Integrity Audit (and a real bug it caught)

Before pushing, the working copy was diffed against the **actually-live**
Netlify build rather than trusting an internal claim. All 15 page sections,
23 `<section>` blocks, 4 modals, 194 functions and 228 element IDs verified
present — nothing lost in the earlier faulty edit that had to be rolled back.

The audit caught a genuine, pre-existing bug: **the wishlist never persisted on
the live site.** `loadWishlist`/`saveWishlist` used only `window.storage` — the
Claude-artifact preview API, which does not exist on a real website — with no
fallback. Every read threw (caught, leaving the wishlist empty) and every save
silently vanished. The cart was fine because it already had a `localStorage`
fallback; the wishlist never got one. Now mirrors the cart's working pattern.

Also confirmed during the audit: the obsolete in-page demo admin panel
(with "Demo password: chakrashri2026" visible in the markup) is **already
unreachable** — `admin` is not in `VALID_PAGES`, so any attempt to reach
`#admin` redirects to the homepage. It is inert dead markup, deliberately left
alone rather than risking further surgery on a working file. The real admin is
`admin.html`.

## Round 11 — Remaining Items Completed (1–18)

**Variant stock architecture (#15)** — enforced with a database TRIGGER, not
application code: `products.stock_qty` is now always the sum of its active
variants' stock. A trigger makes that invariant impossible to violate from any
code path, present or future. Building it exposed a hole that had to be closed
in the same change: if a variant product could be bought *without* choosing a
variant, that decrement would land on `products.stock_qty` and be overwritten
by the trigger on the next variant change — silently erasing the sale from
inventory and giving stock away. There is now a hard guard plus a test named
for exactly that scenario. Also added: variant **Edit** (stock/price/image),
live image **preview** while typing a URL, and the cart/checkout now shows the
selected variant's own photo rather than the generic product shot. The option
combination is deliberately NOT editable — changing it would rewrite what past
orders appear to contain.

**Payment reliability (#13)** — the likely cause of intermittent
"verification failed" is environmental, not a logic bug: on Render's free plan
the service sleeps after inactivity, so both the browser's `/verify` call and
Razorpay's webhook can hit a cold start and time out. Three things address it:
`/verify` now retries with backoff (permanent failures like a signature
mismatch are never retried, only transient ones); and `npm run reconcile`
(`scripts/reconcile-payments.js`) asks Razorpay directly what actually
happened and repairs any order or booking whose payment was captured but never
recorded. It refuses to auto-confirm when the captured amount doesn't match the
order total, flagging it for manual review instead. **Schedule it every ~15
minutes** — it is the last line of defence against a customer being charged
while their order sits at "pending". Note the customer-facing wording also
changed: after Razorpay captures payment, a confirmation failure is never
reported as a failed payment, which previously caused duplicate attempts.

**Cache clearing (#18)** — a **Clear Site Cache** button in the admin header
bumps a shared content version; each visitor's browser notices on next load,
clears caches and reloads exactly once (guarded against reload loops, which
would be worse than a stale page).

**Homepage & contact (#5, #7, #10)** — "Shop By Category" is now real data:
true product counts, ranked by units actually sold from paid orders only, top
7, with a fallback so it never renders empty. Real contact details replaced the
Nashik placeholders. A WhatsApp button sits above the Chakra AI launcher.

**Also:** login prompt before checkout/booking (#11), admin booking "Manage"
rebuilt as a grouped question→answer view with real Razorpay refunds (#9, #12),
stock shortfall wording (#14), footer developer credit with a live status dot
(#16), and a pulsing chakra bindu (#17).

### Still open, deliberately

**#6** (homepage showcase redesign / dedicated Puja Services section) and **#8**
(mobile-only chakra reordering, restyled mobile Shop menu) are visual redesign
work rather than functional gaps. Everything else in 1–18 is implemented. These
two are best done against the live site with your eye on it, since "make it
more attractive" is a judgement call that benefits from your feedback rather
than my guess.

## Round 10c — The Verification Script Had Gone Stale (False Confidence)

`npm run verify` was reporting **"All expected tables exist — 12/12 found"** and
**"ALL CHECKS PASSED"** — while the database actually had **20** tables. The
`EXPECTED_TABLES` list in `scripts/test-db-connection.js` was last updated at migration 003 and
never extended as migrations 004–008 added eight more.

The result was technically true but misleading: the script was silently *not* verifying
`booking_services`, `product_reviews`, `coupons`, `coupon_redemptions`, `product_properties`,
`product_options`, `product_option_values`, or `product_variants` — i.e. essentially everything
built in the last several rounds. A missing table or column among those would have passed
verification and only surfaced later as a runtime failure during a real customer checkout.

Now covers all 20 tables, cross-checked programmatically against what the migration files
actually create (exact match, no drift in either direction). Column-level checks were extended
too, including the ones checkout writes on every single order: `orders.coupon_code`,
`orders.discount_paise`, `order_items.variant_id`, and `order_items.variant_snapshot`.

## Round 10b — nodemailer Upgraded to 9.0.5 (Security Advisory Cleared)

`npm audit` flagged 8 high-severity advisories against nodemailer 6.x. Assessed against this
codebase's actual usage rather than upgrading blindly:

- **6 of the 8 did not apply here at all** — this code never sets `envelope`, never sets a custom
  transport `name`, never sets `List-*` headers, never uses `jsonTransport`, never uses OAuth2
  (it uses plain SMTP user/pass), and never uses the message-level `raw` option.
- The remaining two (address interpretation, addressparser DoS) touch address parsing of values
  that already pass `express-validator`'s `isEmail().normalizeEmail()` at registration.

Upgraded to **9.0.5** regardless, since the advisory is real and this codebase only uses the most
stable part of the nodemailer API (`createTransport({host, port, secure, auth})` and
`sendMail({from, to, subject, html})`). Done as a targeted version bump, **not** `npm audit fix
--force`, which installs breaking major upgrades across unrelated packages.

Verified rather than assumed: installed 9.0.5, confirmed `src/utils/mailer.js` loads and exports
correctly, confirmed `createTransport` accepts this exact config shape, re-ran `npm audit`
(**0 vulnerabilities**), re-ran the full test suite against real dependencies (47/47), and booted
`server.js` with every route and middleware wired without error.

## Round 10 — Self-Audit: Three Gaps Found and Closed

Re-checked the full requirement list against what was actually built, rather than assuming. Three
real gaps turned up:

**1. Variant details were captured but never displayed.** The backend correctly stored and
returned each order item's `variant_snapshot`, but neither the admin order drawer nor the
customer's order view rendered it — so a seller opening an order could not actually see which
variation was purchased, which was the whole point of the request. Both views now show each
purchased option as a pill (with the colour swatch for colour options).

**2. The booking flow was only half-changed.** The requirement was a two-step confirm: a
**Confirm & Pay** button below the details form, which pops up a summary of all entered details
with a **Pay** button at its foot. The previous round only renamed the sidebar button and never
built the popup. Now implemented properly — validation runs *before* the popup opens, so errors
highlight on the form the customer is already looking at rather than inside a modal they'd have
to dismiss to fix. The sidebar summary button now reads "Review Booking" and opens the same popup.

**3. A latent page-destroying bug, found while wiring the above.** Both booking functions used
`const btn = document.activeElement` and then `btn.innerHTML = 'Processing…'` to show a loading
state. After the new review popup closes, `document.activeElement` is typically `<body>` — so
that line would have replaced the **entire page contents** with the word "Processing…". Replaced
with a non-destructive toast. This was pre-existing and would have been reachable in other ways
too; the popup change simply made it near-certain to fire.

## Round 9 — Coupons, Product Variants, Properties, and a Large UI Pass

### Coupon system (built with seller protection as the first concern)

Discount codes, creatable from the admin dashboard (**Coupons** in the sidebar), supporting
percentage or flat-amount discounts, a maximum-discount cap on percentage coupons, minimum order
value, total usage limit, per-customer usage limit, and an expiry date.

Because a coupon bug costs real money, the correctness guarantees are worth stating explicitly:

- **The discount is computed server-side only.** What the browser shows at checkout is a preview;
  the authoritative amount is recalculated inside the order-creation transaction. A tampered or
  stale client value cannot affect what's actually charged.
- **The coupon row is locked (`SELECT ... FOR UPDATE`) during checkout**, so two simultaneous
  orders can't both slip past a "last remaining use" limit — the same race-condition protection
  already used for stock.
- **Redemption is recorded in the same transaction as the order.** If checkout fails for any
  reason (stock ran out, gateway error), the redemption rolls back with it — a failed checkout can
  never burn a customer's use of a coupon.
- **The discount is clamped at both layers** — in the coupon logic and again in the totals
  calculation — so it can never exceed the order value or produce a negative total, even if a
  coupon were misconfigured.
- **A coupon that would zero out an order entirely is rejected** rather than silently creating a
  ₹0 order (which Razorpay would reject anyway, leaving a confusing stuck order).
- Every redemption is recorded individually in `coupon_redemptions`, so usage limits are counted
  from a real audit trail rather than a single counter that could drift.

One judgement call worth flagging for your accountant: **GST is scaled proportionally to the
discount** (a 20%-off coupon reduces the GST total by 20%). India's actual GST-on-discount rules
can depend on how a discount is structured and disclosed on the invoice, so please have your CA
confirm this matches your specific coupon structures before relying on it for filing. The
free-shipping threshold is deliberately evaluated on the **original** subtotal — it reflects the
value of goods bought, not the amount paid after a coupon.

### Product variants (the industry-standard model)

Products can now have real purchasable variations — Options (e.g. "Colour") → Values (e.g. "Red")
→ Variants (a specific combination). Each variant has **its own stock, and optionally its own
price and image**. Selecting a variant on the storefront live-updates the price, stock message,
and main product image. Colour options are picked from a real colour picker in the admin, so the
storefront swatch shows the true shade rather than guessing from a name like "Maroon".

**A critical bug this work introduced was caught and fixed before shipping:** `restoreOrderStock`
(used for cancellations, refunds, and failed payments) was restoring stock to `products` in all
cases. For a variant purchase that would have credited the wrong pool entirely — inflating the
base product's stock while leaving the actual variant permanently short. Now variant-aware, with
end-to-end tests proving variant stock decrements correctly and the base product stock is never
touched for a variant-only purchase.

Order items store a **frozen snapshot** of the variant's option values at purchase time, so the
admin order view shows exactly what a customer bought even if that variant is later edited or
removed — the same principle already used for product names and prices.

### Product properties (Additional Information)

Separately from variants, admins can add free-form name/value properties (e.g. "Finish: Antique
Gold") shown in the product's Additional Information tab. Colour-type properties render with a
small filled circle of that exact colour, as requested.

### Storefront changes

- **Cart drawer opens automatically** when an item is added.
- **Coupon field on both the cart and checkout order summary**, with a live discount line.
- **Product cards fixed** — the name was appearing twice because `shortDesc` falls back to the
  product name when no description is set. The name now appears once in bold, with the material
  shown in small text below the rating instead.
- **Mobile product grid tightened** — reduced gaps, padding, and type sizes at 560px and 380px
  breakpoints so two columns read as a compact grid rather than a stretched-out single column.
- **Review stars are now clickable** on the product page and jump straight to the Reviews tab.
- **Login and Sign Up merged** into two tabs with cross-links; once logged in the tab strip is
  replaced entirely by a proper account panel showing the real name, email, and initial avatar,
  with links to orders, wishlist, and continue shopping (it previously showed a placeholder
  "you@example.com").
- **Puja and Astrology pages restructured into steps** — services are shown first on their own,
  and the date/mode/details steps only appear after pressing **Continue to Booking Details**. The
  final button is now **Review & Pay**, since it opens the payment sheet rather than confirming
  directly.

### Admin dashboard changes

- **Found why the Revenue and Order Status charts appeared empty**: both had a silent
  `catch {}` that swallowed every error, so an API failure, a blocked Chart.js CDN, and a genuine
  "no orders yet" state all looked identical — a blank box with no explanation. Each case now
  shows a specific message, and the charts render responsively with formatted ₹ tooltips.
- **Dashboard stat boxes fixed on mobile** — the grid used `minmax(200px, 1fr)`, which resolves to
  a single column on a phone (a ~360px screen can't fit two 200px tracks), stacking all four
  stats into one tall strip. Now two-up with proportionally tighter padding.
- **Badge filter and Badge column** added to Products, applying together with the category filter.
- **Total and Payment Status columns** added to both booking tables, so you can confirm money
  actually arrived (verified against Razorpay) before confirming or scheduling a booking.
- **Coupons section** for full coupon management.
- **Properties and Variants builders** in the product form.

## Round 8 — Service Creation Diagnostic, Status Emails, Order-Level Reviews, Flexbox Bugs

**"Could not create service" — now with a concrete Postgres error code (42P01, "undefined table")
instead of a generic message.** This is genuine progress: it proves the failure is a real
database-level issue, not a validation or network problem. But it's honestly still not 100% solved
— `GET` requests prove the `booking_services` table exists, the transaction helper was re-verified
correct, and the route code has no typo, which rules out the obvious causes. Two things went in
this round rather than a guessed fix:
1. **A defensive, zero-risk change**: every transaction now explicitly runs `SET search_path TO
   public` before its real queries. This costs nothing and can't break anything if it wasn't the
   cause, but directly addresses the one plausible explanation to which pattern this narrows down —
   a transaction-scoped connection resolving an unqualified table name differently than a plain
   query would.
2. **A maximally decisive diagnostic**: the transaction now runs `SELECT to_regclass('public.booking_services')`
   as its first statement and fails loudly with an unambiguous message if the table isn't visible
   from that exact connection, and each subsequent INSERT is individually try/caught and tagged
   with *which* statement failed. The next attempt — whether it now succeeds because of the
   search_path fix, or still fails — will not require another round of guessing to diagnose. If it
   still fails, check Render's Logs tab for the `[booking-services] POST / failed:` line and paste
   it back exactly.

**Automatic customer emails on every status change.** Previously only the initial order/booking
confirmation sent an email — a `// TODO: notify customer of status change` comment had been sitting
in the code since an earlier round. Now wired for real: order status transitions
(processing/shipped/delivered/cancelled/refunded) and booking status transitions
(confirmed/completed/cancelled) each send an appropriate email
(`src/utils/mailer.js` — `sendOrderStatusUpdate`, `sendBookingStatusUpdate`). When an order is
marked **delivered**, the email also includes a direct link to review each purchased product —
this is deliberately the same moment reviews become possible at all (see Round 7's verified-
purchase gate), so it's a real invitation, not a premature one. Email sending is fire-and-forget
relative to the status update itself — a slow or failed email can never block or fail the actual
status change.

**Order-level review flow.** The customer's order history table now has a **Review** column as its
last column (as requested) — clicking it opens every distinct product from that order in one
place, each independently rateable, rather than requiring the customer to hunt down each product's
own page separately. Reviews are still gated server-side to delivered orders (the button reads
"View" until then, "Review" once delivered), and each order's item list now also indicates which
products the customer has already reviewed, so the same product can't be double-submitted from
this view.

**A recurring mobile CSS bug, found and fixed everywhere it appeared.** The reported "search bar
width in sidebar" issue was a classic flexbox pitfall: a flex child with `flex:1` does not actually
shrink below its own content's natural width unless `min-width:0` is also set — without it, the
input pushes against (or past) its sibling button instead of properly filling the available space
on a narrow screen. Rather than patch only the one reported instance, the same exact pattern was
searched for and fixed in **five** places it was silently present: the main header search bar (the
single highest-traffic element on the site), the mobile drawer search, the chat widget input, and
the cart/checkout coupon code input. Separately, the customer's orders table had **no horizontal-
scroll handling on its wrapper at all** (`.orders-table-wrap` had zero CSS rules defined) — on a
narrow phone this table could overflow the viewport itself rather than scrolling neatly within its
own container. Fixed with `overflow-x:auto` and a properly-measured edge-to-edge scroll treatment
on small screens (measured against the real `--sp-5` container padding token, not guessed).

## Round 7 — Categories/Badges, Images Everywhere, Reviews, Routing, Order Columns, Blog CMS

Seven issues reported from real testing, each traced to an actual root cause rather than patched
by symptom:

**1. Category showed "undefined"; category/badge couldn't be freely admin-defined.**
`CAT_LABELS` was a hardcoded 7-key lookup object — any category an admin typed into the product
form that wasn't already one of those 7 exact keys returned `undefined` from every lookup, which
rendered as the literal text "undefined" on product cards, breadcrumbs, and the shop sidebar. Nine
separate call sites had this same unguarded lookup. Fixed with a `catLabel()` helper that falls
back to a nicely title-cased version of any category the admin actually types, and the shop
sidebar now dynamically includes every real category present in the catalog (previously it only
ever iterated the fixed 7 keys, so a new category could never even be filtered by). The badge
system had the same class of bug in a different shape: any value other than exactly `'bestseller'`
or `'new'` was silently replaced with the hardcoded text "Sale", discarding whatever the admin
actually typed (e.g. "Certified" would display as "Sale"). Fixed with a matching `badgeInfo()`
helper that displays custom badge text verbatim.

**2. Product image visible on the detail page, but gone after a reload.** Root cause: the URL hash
only ever encoded the page name (`#product`), never *which* product — `currentProductId` is an
in-memory JavaScript variable that resets to nothing on every page reload, and there was no
`'product'` branch in the router at all to reconstruct it. Fixed by encoding the product's slug in
the hash (`#product/<slug>`), adding a proper router branch that looks the product up by slug, and
a graceful "product not found, redirecting to shop" fallback for stale/deleted links — rather than
the blank page reload previously produced.

**3. Images not shown in shop, home, or quick view — blank with only the default icon.** By design,
the public product *list* endpoint doesn't include images (a deliberate lightweight payload for a
fast shop grid) — but nothing anywhere else ever fetched the full per-product detail that does have
them, so every card thumbnail across the entire site only ever showed the decorative placeholder,
by construction, not by accident. Fixed with a genuine architectural addition: the list endpoint
now includes one lightweight primary image URL per product (`image_url`, via a cheap scalar
subquery — not the full gallery, just enough for a card thumbnail), and a single shared
`productThumbInnerHTML()` helper now renders it consistently everywhere a product thumbnail
appears: shop grid, home page, quick view, mini-cart, full cart, and checkout order review — six
locations that previously each independently rendered only the placeholder.

**4. No product review feature.** Built from scratch, gated to verified purchases: a
`product_reviews` table (migration 005), one review per customer per product, and — critically —
the eligibility check (has this customer received a *delivered* order containing this exact
product?) is enforced server-side on the actual submission endpoint, not just used to decide
whether to show the form. The product's aggregate rating and review count are recomputed from real
review data on every new review, rather than incrementally patched (which can drift out of sync
over time, e.g. if a review is ever removed). This also **replaced entirely fake content**: the
previous "Reviews" tab generated seeded pseudo-random fake reviews with fake names, and mislabeled
every one of them "Verified Purchase" — which was actively misleading to real customers.

**5. "Could not create service" when adding a puja/astrology service.** The confirmed, fixed bug:
the service-creation INSERT and its audit-log INSERT were two separate, non-transactional queries —
if the audit-log write failed for any reason, the admin saw a failure even though the service row
may have already been committed. Wrapped both in one transaction. Error responses now also include
a safe Postgres error code (e.g. `23505`, `23514`) rather than only a generic message, and the full
error is logged server-side (visible in Render's Logs tab) — so if this specific failure mode
recurs for a different underlying reason, the actual cause is immediately visible instead of
requiring another round of guessing.

**6. Customer's order history needed Product Name and Quantity columns.** The orders list endpoint
previously returned only order-level summary data with no product information at all. Added an
aggregation (`STRING_AGG` for product names, `SUM` for total quantity) to the same query, with
sensible truncation on the frontend ("Product A, Product B +2 more") for orders with many distinct
items rather than an unbounded list.

**7. Blog rebuilt on Sanity.io (headless CMS) + Astro (Static Site Generation)**, replacing the
plan for a custom-built blog CMS entirely. Delivered as a separate project
(`chakrashri-blog.zip`) rather than inside this backend, since Portable Text + SSG fundamentally
needs a build step this single-file frontend doesn't have: a real block-based rich text editor
(Sanity Studio), a brand-matched public blog (`astro-site/src/pages/blog/`) using the same
Cinzel/Poppins fonts and color palette as the storefront, and zero JavaScript shipped by default
(Astro's static output) — so normal blog traffic never touches the Sanity API quota. A **Journal**
link was added to this admin dashboard's sidebar, opening the deployed Sanity Studio in a new tab
— update the `SANITY_STUDIO_URL` constant near the top of `admin.html` once the Studio is deployed
(see `chakrashri-blog/README.md`).

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
