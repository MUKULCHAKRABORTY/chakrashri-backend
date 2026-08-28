# Deploying this change

Everything in the audit that could be fixed in code has been. This is the
sequence to get it live safely, and the short list of things only you can do.

The changes are designed to be deployable in the order below, with each step
independently safe. Nothing here requires downtime.

---

## 0. Before anything else — rotate the credentials (SEC-01)

**This is the only genuinely urgent item, and it is not a code change.**

The archive contained a `.env` with real values for `DATABASE_URL`,
`JWT_SECRET`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and the SMTP
password. `.gitignore` correctly excludes that file, so this was a packaging
leak rather than a git leak — but the archive was transmitted, which is the same
outcome. `JWT_SECRET` alone lets anyone forge an admin token.

Rotate in this order:

1. **Neon** — reset the role password, update `DATABASE_URL` in Render (web
   service *and* both cron services).
2. **JWT_SECRET** — `openssl rand -hex 32`. This signs everyone out, which is
   the intended effect.
3. **Razorpay** — regenerate the API key pair and the webhook secret in the
   dashboard, update all three env vars.
4. **SMTP** — reset the mailbox password.

Then review Neon's connection log and Razorpay's activity log for anything you
do not recognise.

The `.env` file has been removed from this deliverable. Only `.env.example`
ships, and it is placeholder-only.

---

## 1. Database migrations

Two new migrations. `render.yaml` now runs `npm run migrate` as a
`preDeployCommand`, so on Render this happens automatically before the new
process starts serving. To run it by hand:

```bash
npm run migrate
```

**`013_security_integrity_and_capacity.sql`** — transactional, atomic.
Adds `token_version`, the order shipping-address snapshot with a backfill, the
refunds ledger (including a backfill of refunds already recorded on orders and
bookings, so historical refunds cannot be issued a second time), review
moderation columns, practitioners and availability slots, COD risk columns, an
append-only trigger on the audit log, and several CHECK constraints.

**`014_performance_indexes.sql`** — **not** transactional, by design. It uses
`CREATE INDEX CONCURRENTLY`, which Postgres refuses to run inside a transaction.
The migration runner recognises the `-- migrate:no-transaction` directive on its
first line and executes its statements outside one.

The trade-off, stated plainly: if it fails partway, the earlier statements are
already applied and the file is not recorded as complete. Every statement is
idempotent, so the fix is to resolve the cause and re-run. An interrupted
`CONCURRENTLY` build leaves an INVALID index behind; find it with:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

then `DROP INDEX` that name and re-run. The runner prints this guidance on
failure so nobody has to remember it.

**Both migrations are additive.** Every new column defaults to a value that
reproduces existing behaviour, so 013 can be applied before the application code
that uses it. The two deploys do not have to be simultaneous.

---

## 2. Environment variables

New, all optional except where noted:

| Variable | Default | Why |
|---|---|---|
| `TZ` | `Asia/Kolkata` | BIZ-06. Set it explicitly on Render. |
| `REQUIRE_TOKEN_VERSION` | `false` | See step 5. |
| `ADDITIONAL_CLIENT_ORIGINS` | — | Comma-separated. Netlify branch previews. |
| `ANTHROPIC_API_KEY` | — | Enables the support chat. Unset = the widget shows your WhatsApp number instead. |
| `LOG_LEVEL` | `info` | |
| `DB_*` timeouts | see `.env.example` | Bound how long a stuck connection holds a pool slot. |

`render.yaml` declares all of them. The server now **refuses to start** if
`DATABASE_URL` or `JWT_SECRET` is missing, or if `JWT_SECRET` is under 32
characters in production — a clear startup error instead of "login is broken".

### One change to make in `DATABASE_URL` itself (TLS-01)

If your connection string ends in `?sslmode=require`, change it to
`?sslmode=verify-full` — in `.env` and in the Render dashboard.

`pg` prints this on every boot today:

> SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are
> treated as aliases for 'verify-full'. In the next major version … these modes
> will adopt standard libpq semantics, which have weaker security guarantees.

Read plainly: **`require` means "encrypted and verified" today and will mean
"encrypted, but I'll accept any certificate anyone hands me" after a routine
`npm update`.** No code change, no error, no failing test — just a
man-in-the-middle window that opens by itself. Anyone able to intercept traffic
between Render and Neon would see every order, address and password hash.

`src/config/db.js` now rewrites `require` and `verify-ca` to `verify-full` at
boot and logs one line saying it did. That is a safety net, not the fix: set the
value at the source so nothing has to be corrected. Behaviour is identical
either way on today's `pg`, so this is safe to change immediately and there is
no reason to wait.

Deliberately left alone: `sslmode=prefer` is warned about but never rewritten
(it permits a plaintext fallback that a local development database relies on),
and a `localhost` / `127.0.0.1` connection is never touched, because a dev
Postgres commonly has a self-signed certificate that `verify-full` is right to
reject. `DB_SSL_NORMALIZE=false` turns the rewrite off entirely.

---

## 3. Razorpay webhook events

In the Razorpay dashboard, add these to your webhook subscription:

- `refund.processed`
- `refund.created`

Already subscribed and still needed: `payment.captured`, `payment.failed`.

**Why:** a refund issued from the Razorpay dashboard rather than your admin
panel used to be invisible to this system — the money went back and the order
stayed `paid` forever, so the books disagreed with the bank and nobody found out
until a reconciliation. Those two events now record it.

---

## 4. The second cron job

`render.yaml` adds **`chakrashri-payment-reconcile`**, every 15 minutes.

This is the OPS-02 fix. `scripts/reconcile-payments.js` already existed, its own
header said "schedule it every ~15 minutes", and nothing ever ran it. It is the
third and most authoritative of the three paths that can confirm a payment — the
one that asks Razorpay directly. Without it, "customer paid, closed the tab,
webhook was throttled" ends with the expiry sweep cancelling the order while the
money is captured.

It exits non-zero on any amount mismatch, so a real problem shows up as a failed
cron run rather than a green tick with a warning buried in the log. **Turn on
failure notifications for it** — it is the job most worth being paged about.

---

## 5. The one deliberately staged change: token revocation

`REQUIRE_TOKEN_VERSION` starts as `false`. Here is exactly why.

Access tokens now carry a `tv` claim holding the user's `token_version`, and a
password reset increments that column — which is what makes "resetting my
password ends the attacker's session" true, when previously it was not.

Tokens issued *before* this deploy have no `tv` claim. Rejecting them would sign
out every customer with an open session at the moment of deploy — a real
conversion cost to close a latent gap. So during the grace window they are
accepted and skip the check, and they cannot outlive `JWT_EXPIRES_IN` anyway.

**Seven days after deploying, set `REQUIRE_TOKEN_VERSION=true`.** That is a
dashboard change, no redeploy. After it, any token without a `tv` claim is
refused and the gap is closed permanently.

---

## 6. Storefront deploy (Netlify)

New files at the repository root, all of which Netlify serves from the publish
directory:

- `_redirects` — **required.** Routing now uses real paths (`/product/slug`)
  instead of fragments. Without the SPA rewrite rule, every product URL is a hard
  404 on refresh or from a search result.
- `_headers` — Content Security Policy and transport hardening.
- `robots.txt`
- `netlify.toml` — sets the publish directory and runs the sitemap generator.
- `vendor/chart.umd.js` — Chart.js, self-hosted (see below).

Set the build command to `node scripts/generate-sitemap.js` (netlify.toml
already does). It regenerates `sitemap.xml` from the live catalog on every
deploy and fails soft — an unreachable API produces a sitemap of static pages
rather than a failed build.

**Order matters slightly:** deploy the API first, then the storefront. The
coupon endpoint accepts both the old and new request shapes precisely so the
window between the two deploys is harmless, but the storefront's new product URLs
need `_redirects` live to resolve.

### Old links keep working

Real-path routing is a visible change, so this was built to be non-breaking:
any URL still arriving with a `#fragment` — a bookmark, a link in an
already-delivered order email — is read, honoured, and quietly rewritten to its
path form. Nothing 404s.

---

## 7. Chart.js is now self-hosted

`admin.html` loaded Chart.js from cdnjs with `crossorigin` but no `integrity`,
so a compromised CDN response would have executed with full access to the admin
session token.

Adding an SRI hash would mitigate that. Self-hosting removes it: no third-party
origin in the request path, cdnjs gone from the CSP, the console still works if
cdnjs is blocked or slow (a real consideration on some Indian networks), and no
hash to remember to regenerate — a stale one silently blocks the script and the
dashboard charts just vanish.

The file is `vendor/chart.umd.js`, copied verbatim from `chart.js@4.4.4` on npm.
The `integrity` attribute is kept as a tamper check on our own asset, and
`test/frontend.test.js` verifies the hash still matches the file. To upgrade:

```bash
npm pack chart.js@<version>
tar xzf chart.js-<version>.tgz package/dist/chart.umd.js
cp package/dist/chart.umd.js vendor/chart.umd.js
openssl dgst -sha384 -binary vendor/chart.umd.js | openssl base64 -A
# paste the result into the integrity attribute in admin.html
```

---

## 8. Verify

One-time per machine, before the first run — `npm install` fetches the Playwright
library but **not** the browser it drives, because the binary is hundreds of
megabytes and cached per machine rather than per project:

```bash
npm run setup:browser     # == npx playwright install chromium
```

Then:

```bash
npm test                  # offline suite — this is what CI gates on
npm run verify            # adds the DB integration tests and live connectivity checks
npm run verify:full       # the actual pre-deploy gate — nothing is allowed to skip
```

### `verify` and `verify:full` are not the same claim

Two suites can remove themselves from a run: `test:browser` without a Chromium
binary, and `test:db-integration` without a disposable database. Both skips are
correct on a laptop — a missing optional download must never stop the checks that
*can* run — and both are wrong immediately before a deploy.

`npm run verify` permits them and says loudly what did not run.
`npm run verify:full` forbids them: a skip becomes a failure. **Use `verify:full`
as the gate.** Its green means every suite actually executed; `verify`'s does not.

### Setting up the throwaway database (one time)

The 29 integration tests create and delete rows — concurrent checkout of the last
unit, refund-ledger arithmetic, append-only audit log — so they read
`TEST_DATABASE_URL`, never your production `DATABASE_URL`. A guard refuses
anything that does not look disposable: the host must be localhost, or the
database name must contain `test` or `ci` as a whole word. Credentials are not
examined, deliberately — a password must never be what grants write permission.

A **Neon branch** is the easiest option: instant, free, isolated, discardable.

```bash
# 1. create the branch/database in the Neon console, copy its URL
# 2. apply the migrations to it once — migrate reads DATABASE_URL, so point it there
#    for this one command only:
DATABASE_URL="postgresql://.../chakrashri_test?sslmode=verify-full" npm run migrate
# 3. put it in .env as TEST_DATABASE_URL, then:
npm run verify:full
```

If you skip `setup:browser`, the browser test now reports `SKIPPED` and the rest
of the chain still runs — a missing optional download must never be able to stop
the checks that *can* run. In CI that leniency would hide a broken install, so
the workflow sets `REQUIRE_BROWSER_TESTS=true` and a skip there fails the build.
Set the same variable locally when you want to be sure the browser test really
ran:

```bash
REQUIRE_BROWSER_TESTS=true npm run test:browser
```

CI (`.github/workflows/ci.yml`) now runs the suite on every push and pull
request, applies the migrations against a real Postgres 16 (twice, to prove they
are re-runnable), and fails on any high or critical dependency advisory. It also
blocks a pull request that edits an already-committed migration — those are
tracked by filename and would silently never re-run.

The manual end-to-end check before going live is unchanged and still worth doing:
place one real ₹1 order through Razorpay, confirm the webhook lands, then refund
it from the admin panel and confirm the ledger, the audit entry and the customer
email all appear.

---

## What is now enforced that was not before

A short list worth knowing about, because each one can surface as "why did that
just get rejected?":

- **COD has a ₹5,000 ceiling** and auto-blocks a customer after 2 returned COD
  orders. Both are `site_settings` rows you can change from the API without a
  deploy; set `cod_max_order_paise` to `0` to disable the ceiling.
- **Reviews require a verified email address.** Existing customers who have never
  verified will be asked to, with a resend link on their account page.
- **PIN codes must be 6 digits** and Indian mobile numbers must start with 6-9.
- **A booking must use a published slot** — but *only* for services that have
  slots published. Publish none and bookings behave exactly as they do today.
  This is the same rule the catalog already uses for product variants.
- **A payment whose captured amount, currency or capture status does not match**
  no longer marks an order paid. It goes to `payment_review`, appears on the
  admin dashboard with a count, and waits for a person. That state is new; it is
  the correct answer to a case that previously shipped goods against money that
  had not settled.


---

## Regression pass — what a second review found, and fixed

After the first round of fixes I ran a dedicated regression hunt (a fresh
adversarial review of the diff, plus real-browser and real-database testing)
specifically looking for things the fixes had BROKEN rather than fixed. It found
fifteen. All are fixed and covered by tests; they are listed here because
several are worth knowing about.

**Introduced by the fixes, and serious:**

- **A full refund stopped restoring stock.** The refund committed
  `status = 'refunded'` and *then* called `restoreOrderStock()`, whose own
  idempotency guard sees that status and no-ops. No error, no log — the units
  simply left sellable inventory forever. Same shape for booking slots. Fixed by
  doing the restore inside the refund transaction, before the status write.
- **…and then the opposite.** Removing that guard meant cancel-then-refund, or
  reject-review-then-refund, restored stock **twice** — inventing phantom stock
  the shop would oversell. Fixed with a status precondition at the route *and*
  inside `issueRefund()`.
- **Clicking "add to cart" on the shop grid navigated to the product page.**
  Making the card a real `<a>` for crawlability put the buttons inside a link;
  their `stopPropagation()` stops the listener but not the browser following the
  href. Only a real browser could have caught this; there is now a Playwright
  test that does.
- **Reviews became unreachable.** The email-verification gate went in with no
  verification UI — no handler for the link, no resend button, and a message
  telling a customer whose order *was* delivered that it had not been.
- **Customers were told "Order Confirmed" for payments the server had parked.**
  The new 202 `{pending:true}` response is a *success* status, so the storefront
  fell straight through to the success screen.
- **A `*/10` cron expression inside a block comment** closed the comment early
  and made the expiry-sweep script unparseable — it would have crashed on its
  first run. **A backtick inside a SQL comment** ended a template literal. **A
  closing script tag inside a comment** silently truncated 140KB of storefront
  JavaScript.
- **Migrations ran under the API's 15-second statement timeout**, so on a
  populated database `CREATE INDEX CONCURRENTLY` would be cancelled and — since
  migrations are a `preDeployCommand` — the deploy would fail. They now use a
  separate pool with no timeout; the request pool is unchanged.
- **A skipped constraint reported success.** Migration 013 silently skipped a
  data-integrity constraint when legacy rows violated it. It now raises a
  warning naming the offending rows and the exact recovery command, and the
  runner surfaces Postgres warnings (node-postgres discards them by default).

**Pre-existing, found along the way and fixed:**

- **Refreshing the admin console logged you out.** `let currentView` was
  declared *after* the IIFE that reaches it, so restoring a session threw in the
  temporal dead zone and the catch turned it into a silent logout. Present in
  the original too.

**What changed in how this is verified**

`npm test` now begins with `npm run check:syntax`, which parses every `.js` file
*and* the inline scripts of both HTML files, and fails if a script block is
suspiciously short. I added it because my own earlier shell loop piped
`node --check` through `head` and discarded the exit status — it printed
"all checked" while a file was unparseable. A verification that looks like it is
working while it is not is worse than none.

The suite is now 240 offline assertions plus 29 against a real PostgreSQL,
including a real-browser test of the product card and of admin capability
gating.
