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

**Status:** as of the 1.2.0 pre-deploy gate, the whole suite has been run green against a real
Neon database and real Razorpay test keys — **270 tests across six suites plus two browser
suites, nothing skipped**. (Earlier revisions of this README said none of it had been run against
a live database; that is no longer true.)

```bash
npm install
npm run setup:browser        # ONE TIME PER MACHINE — downloads the Chromium the browser tests need
cp .env.example .env         # then paste in your real DATABASE_URL, JWT_SECRET, RAZORPAY_* keys
npm run migrate              # applies the schema to your database (safe to re-run — idempotent)
npm run verify:full          # THE PRE-DEPLOY GATE — see below
```

### `test` vs `verify` vs `verify:full` — they make different promises

Read this before trusting a green run. The difference is the whole point.

| Command | What it covers | Can a suite skip itself? |
|---|---|---|
| `npm test` | Offline only — no database, no network. What CI gates on. | Yes: the browser suites skip without Chromium |
| `npm run verify` | The offline suite **plus** integration + live connectivity | Yes: browser *and* database can skip, and it still reports success |
| `npm run verify:full` | Identical to `verify`, but **nothing is allowed to skip** | **No** — a missing browser or test database is a *failure* |

**Use `verify:full` as the pre-deploy gate.** `verify` is the developer command: it tells you
loudly when a suite removed itself, but it still exits 0, so its green does not mean everything
ran. This distinction exists because it went wrong for real — a run once reported success while
the browser suite had crashed and 29 database tests had silently skipped.

`verify:full` needs `TEST_DATABASE_URL` pointing at a **disposable** database (a Neon branch, or
a second database named e.g. `chakrashri_test`) — never production, because these tests create
and delete rows. A guard refuses to run them against a URL that does not look disposable, and it
decides on the host and database name only, never on the credentials.

Apply the migrations to that throwaway database once. `npm run migrate` reads `DATABASE_URL`, not
`TEST_DATABASE_URL`, so point it there for that one command only:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
```

### What the live checks actually tell you

- **`test:db`** — connects to whatever `DATABASE_URL` names and checks SSL is really in use, the
  `pgcrypto` extension is enabled, writes and deletes work, and `FOR UPDATE` row locking works
  (the stock-reservation logic depends on it). It also checks every table this build expects,
  grouped by the migration that creates it, so it can tell two different things apart: a database
  that is merely **behind** (missing tables whose migration has not run — expected before any
  deploy that adds one, reported loudly but not a failure), and genuine **schema drift** (tables
  missing even though `_migrations` says they were applied — a real failure).
- **`test:razorpay`** — creates a real ₹1 test-mode order, fetches it back and validates signature
  generation, confirming your keys authenticate without needing a browser or test card.

If a check fails it prints which one and why, not a stack trace.

### One known flake, and why it is not "fixed"

Running `verify:full` from a laptop against a remote Neon database occasionally fails this test:

```
FAIL - THE CORE INVARIANT: two simultaneous checkouts for the LAST unit — exactly one wins
       The input did not match the regular expression /stock|out of stock/i. Input:
       'timeout exceeded when trying to connect'
```

That is a connection timeout, not an oversell. The test deliberately asserts *why* the losing
checkout failed: if the loser was rejected because it could not get a database connection, then
nothing about the stock invariant was actually proven, and the test says so rather than passing
for the wrong reason. **That behaviour is correct and should not be softened** — a test that
accepts any failure from the loser would still pass on a day when the guard is genuinely broken.

Re-run the suite. It is a remote-connection artifact and does not appear in CI, where Postgres
runs as a service container next to the job:

```bash
npm run test:db-integration
```

If it fails twice in a row with the same message, that is no longer a flake — look at
`DB_CONNECT_TIMEOUT_MS`, and at whether the Neon endpoint is throttling or asleep.

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

This repo includes `render.yaml`, a Blueprint defining the API plus three cron services.

> ### ⚠️ `render.yaml` is NOT currently in effect
>
> The live service was created **by hand in the Render dashboard**, and a `render.yaml` only
> governs services created *from* it as a Blueprint. For a hand-made service it is an inert text
> file no matter how correct it is. Verified 2026-08-29: the file says `region: ohio`, the live
> service runs in **Oregon**; the dashboard shows one service under "Ungrouped Services" and none
> of the three cron services exist.
>
> The file is kept complete and ready **on purpose** — it is the target configuration for the paid
> Starter plan. Do not delete it to tidy up. Read the header comment inside it before changing
> anything there.

### Running on the free plan

Render's free tier has no cron services and no pre-deploy command, so four things `render.yaml`
promises do not happen. Each has a free replacement, already in the repo:

| Missing on free tier | If ignored | Free replacement |
|---|---|---|
| `preDeployCommand: npm run migrate` | New code meets an old schema | `.github/workflows/migrate-on-deploy.yml` |
| `chakrashri-expiry-sweep` (10 min) | Abandoned checkouts hold stock forever | external cron → job trigger |
| `chakrashri-payment-reconcile` (15 min) | "Paid, webhook throttled" → order cancelled **and money captured** | external cron → job trigger |
| `chakrashri-scheduled-emails` (15 min) | No restock alerts, reminders, recovery mail or digest | external cron → job trigger |

The reconciler matters **more** here, not less: a free instance sleeps after ~15 minutes, so a
Razorpay webhook can reach a cold instance and time out. Keeping it warm reduces that; only the
reconciler catches a payment whose webhook was genuinely lost.

#### Setup — three steps, once

**1. Migrations.** Add your production connection string as a repository secret named
`DATABASE_URL` (GitHub → Settings → Secrets and variables → Actions). `migrate-on-deploy.yml`
then applies migrations on every push to `main` that touches `migrations/`, and fails loudly if
the secret is missing rather than skipping silently. Delete that workflow when you upgrade —
Render's `preDeployCommand` does the same job at a better moment.

**2. Generate a job-trigger token** and set it as `JOBS_TRIGGER_TOKEN` in the Render dashboard
(Environment → Add Environment Variable), then redeploy:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Until it is set, the endpoint answers `503` and runs nothing. That is deliberate — a blank
setting must never mean "no authentication required".

**3. Point a free scheduler at the trigger.** [cron-job.org](https://cron-job.org),
UptimeRobot and Better Stack all do this on their free tiers. Configure:

- URL — `https://chakrashri-api.onrender.com/api/internal/jobs/run`
- Method — `POST`
- Header — `X-Jobs-Token: <the token from step 2>` (`Authorization: Bearer <token>` also works)
- Every 10 minutes

The token goes in a **header, never the query string** — the request logger records every URL, so
`?token=…` would write the credential into the log on every single run.

This one call runs all three jobs in sequence *and* keeps the instance warm, so it replaces
`.github/workflows/keep-alive.yml`. **Disable that workflow once this is working** — see its
header comment: at every 10 minutes it costs roughly double the free Actions allowance on a
private repository.

#### Checking it works

The trigger returns `202` as soon as the run starts, because an external scheduler will time out
long before the jobs finish (cron-job.org allows 30s; a cold start alone can take ~50s). `202`
therefore means *started*, not *succeeded*. Ask for the outcome separately:

> **Expect occasional timeouts in the scheduler's history, and don't chase them.** If the instance
> had gone to sleep, waking it takes longer than the scheduler is willing to wait — so it records a
> timeout even though your server received the request and ran the jobs anyway. Set the scheduler's
> timeout to its maximum, and treat `/status` (below) as the source of truth for whether work
> actually happened, not the cron dashboard's red ticks.

**Put `JOBS_TRIGGER_TOKEN` in your local `.env` as well** — the same value you set in the Render
dashboard. `.env` is gitignored, and it lets the two commands below read the token instead of you
pasting it into a shell (which puts it in your shell history, and into any screenshot you share):

```bash
npm run jobs:status
```

That prints whether a run is in progress, when the last one finished, and each job's exit code.
**It exits non-zero if no run has ever happened** — which is what you want in a monitor, because
"the scheduler was never configured" and "the scheduler is fine" must not both look like success.

To start one immediately — the thing to reach for when a payment looks stuck:

```bash
npm run jobs:run
```

Or a single job:

```bash
node scripts/jobs-trigger.js run payment-reconcile
```

Valid names: `expiry-sweep`, `payment-reconcile`, `scheduled-emails`.

Two things about `jobs:status` that will otherwise mislead you:

- **`lastRun` lives in memory, not the database.** Every deploy resets it, so "no run has ever
  happened" is normal immediately after deploying and only meaningful once the service has been up
  longer than your scheduler's interval.
- **A non-zero exit is not always a bug.** The reconciler exits non-zero deliberately when an
  amount mismatch needs a human to look at it. That is the signal working, not failing.

**Design note worth knowing before you change it:** the trigger runs each script as its own
child process, exactly as Render's cron would — it does not `require()` them. Two of the three
call `main()` at import time and then `db.pool.end()` and `process.exit()`, so importing either
into the web process would close the pool the API is serving from and shut the server down. See
the header of `src/routes/jobs.routes.js`.

**When you upgrade to Starter:** Render dashboard → Blueprints → New Blueprint Instance → point it
at this repo, then delete the hand-made service so you aren't billed for two. Re-enter every
`sync: false` secret. Then remove `migrate-on-deploy.yml`, delete the external cron schedule, and
drop `JOBS_TRIGGER_TOKEN` — the real cron services take over all of it.

#### Cold starts, and why a visitor never waits through one

Keeping the instance warm makes a cold start **rare**. It cannot make it impossible — a deploy,
an eviction, or a missed schedule all bring one back. So the storefront is built to render
completely **without the API**, and the cold start happens behind a page the visitor is already
using.

**What it used to do.** `init()` awaited seven API calls before it did anything else, and routing
was the *last* thing it did. `#page-home` is the only page marked active in the static HTML, so a
visitor opening a shared product link on a sleeping API sat on the **home page**, with empty
product grids, for the whole 30–60 second boot — and was then thrown to the product without
warning. Nothing was broken; the first paint was simply gated on a request that had no business
gating it.

**What it does now.** Three sources for the catalog, fastest first:

| Tier | Source | Typical | Used when |
|---|---|---|---|
| 1 | `catalog.json` on Netlify's edge | ~50 ms | Always, if the file exists |
| 2 | `localStorage` (last catalog seen, max 24h old) | ~1 ms | Snapshot missing or slow |
| 3 | The live API | 30–60 s when cold | Always — in the **background**, and it always wins |

The page routes and renders from tier 1 or 2 in well under a second; tier 3 replaces it silently
when it lands. A shared product link now shows the real product — name, price, images,
description, working Add to Cart — while the server is still booting.

Three supporting pieces, all in `index.html`, each marked with a `COLD START` comment block:

- **The knock happens in `<head>`.** `/api/health` is fetched before the 460 KB of markup is
  parsed, so Render's boot clock starts ~1.5 s earlier than it used to. It touches no database and
  is exempt from the rate limiter, so a slow answer costs nothing.
- **Skeletons, never a false empty state.** An empty grid because the catalog has not arrived is
  not an empty catalog. "No products found" is now shown only once a tier has actually answered.
- **Honest, escalating copy** — and only on requests something is genuinely waiting on. Browsing
  is served from the snapshot and stays silent; add-to-cart, login and checkout show
  "Just a moment…" at 4 s and "Our server is waking up…" at 15 s.

**What still waits on the server, stated plainly.** Add to cart, login, checkout and booking
cannot be served from a snapshot and never will be. What changed is *when* they happen: a visitor
browses for 30-odd seconds first, and the server has been waking that whole time. The static shell
buys exactly the time the boot needs.

**The snapshot is display data only.** Price and stock in `catalog.json` can be minutes or days
old. The server re-checks both at add-to-cart and again at checkout (`utils/stock.js`,
`utils/orders.js`), which is what makes a stale snapshot a cosmetic problem rather than a
mispriced order. **Never compute a total from it.**

##### Setup — one command, then commit the result

`netlify.toml` regenerates `catalog.json` on every deploy, so normally there is nothing to do. But
generate one by hand and **commit it**, once:

```bash
npm run snapshot
```

That is the safety net. On a build where the API never wakes, the script refuses to publish an
empty shop and keeps whatever copy is in the repo — so the committed one is what visitors get.
With no committed copy and a failed build fetch, the storefront falls back to tiers 2 and 3, which
still works but gives a first-time visitor skeletons instead of products.

The script wakes the API by polling `/api/health` for up to 90 s before fetching, and always exits
`0`: a deploy blocked because a snapshot could not be refreshed is worse than a deploy carrying
yesterday's snapshot.

#### Shared links: why every product used to preview as the same thing

Separate problem, same symptom, and worth understanding on its own.

`_redirects` serves the **same** `index.html` for every path. Its head carries
the generic site title, the generic description and no image. `updatePageMeta()`
rewrites those per view — but it rewrites them *in JavaScript*, and the crawlers
that build link previews do not run JavaScript.

So every product link shared on WhatsApp — the dominant channel for this market —
previewed as "Chakrashri — Sacred Objects, Puja Booking & Astrology" with no
picture and no price, whichever product it pointed at. Facebook, Twitter/X,
Slack, Telegram, LinkedIn and iMessage all behave the same way.

`scripts/generate-product-pages.js` writes a real `product/<slug>/index.html`
per product on every deploy, with that product's own title, description, image,
`og:type=product` and Product/Offer JSON-LD already in the bytes. Netlify serves
a real file in preference to the `/*` catch-all, so these win automatically —
**do not add `!` to that rule**, since a forced rewrite would shadow every one
of them. The frontend test asserts it is not forced.

Two silent bugs were found and fixed while doing this, both of which had been
quietly costing the site:

- **`og:image` was never emitted at all.** The social-card and JSON-LD code read
  `p.img`, and no product object in this project has ever had an `img` field —
  the API mapper builds `imageUrl` and the embedded seed catalog has no image
  field whatsoever. Reading a missing property is `undefined`, not an error, so
  it failed in total silence. Every shared link was pictureless, and Google
  never had an image to attach to a result.
- **The Product JSON-LD was mostly wrong.** It read `short_desc`, `stock_qty`
  and `review_count` from objects whose fields are named `shortDesc`, `stockQty`
  and `reviews`. Net effect: every product Google indexed had an **empty
  description**, was advertised as **InStock whether or not it was**, and
  **never carried its star rating**. The availability mismatch is the serious
  one — Google issues manual actions over it. Both readers now accept either
  shape, because the generator passes raw API rows and the storefront passes
  mapped ones.

##### What the generated pages are, and what they cost

Each page is a full copy of `index.html` with its head rewritten — there are no
shared external assets to link to, since all CSS and JS is inline. That reads
alarming at ~487KB and mostly is not: Netlify serves them brotli-compressed at
roughly 85KB, and a visitor downloads exactly **one**, because every navigation
after the entry page is client-side routing. The real cost is a repeat visitor
entering at two different products on different days paying for two documents
instead of one cached one — a fair trade for previews that work.

Each page also inlines its own product row as `window.__PRERENDER__`, which
`seedPrerenderedProduct()` reads *before* the snapshot is awaited. A prerendered
product page therefore renders completely with **no network request at all** —
not even `catalog.json`. Verified: with the API unreachable and localStorage
cleared, `/product/<slug>` renders name, price, MRP, saving, SKU, rating and a
working Add to Cart, with `catalogSource` still `null`.

The pages are **gitignored build output** (`/product/`), regenerated from the
live catalog on every deploy — note the deliberate asymmetry with
`catalog.json`, which *is* committed because it is the storefront's fallback
when a build cannot reach the API. These pages have no such role: with none
present, every product still renders through the SPA exactly as before.

`PRERENDER_MAX_PAGES` (default 400) caps how many are written. Beyond it the
remaining products still work, they just share the generic preview.

**Failure is always soft.** If the head of `index.html` ever changes shape so a
replacement pattern stops matching, the script writes **nothing** and says so
loudly, rather than publishing pages that look fine and carry the wrong preview.
It always exits `0` — link previews must never be able to block a deploy.

#### The rule: never show a visitor something that is not true

Every piece below enforces one rule — when the site cannot say what is true, it
says nothing rather than inventing it. Auditing for that turned up four defects
that had nothing to do with cold starts and everything to do with this rule.

**1. A sleeping API used to produce a shop full of products that do not exist.**
`index.html` carried 128 lines of demo catalog — "Natural Sphatik Shivling – 2
Inch" at ₹1,299, ids like `lin-01`, invented ratings and review counts — as the
last-resort fallback. So the failure mode of an unreachable backend was a
storefront that looked completely normal and sold nothing real. That is the one
failure a customer cannot detect: an empty grid is obviously a site with a
problem; a full grid of fake products looks fine right up until they try to buy.
The seed data is **deleted**. `PRODUCTS` now starts empty, and when every source
fails the grids say *"We could not load the collection"* with a Try Again button.

**2. Three mega-menu links pointed at those demo ids.** `openProduct('lin-01')`
resolves against no real catalog, so "Popular Picks" was three links that each
ended in *"that product could not be found"*. They are now filled from the live
catalog by `renderMegaMenuPicks()`, bestsellers first, and render nothing at all
when there is no catalog — an empty column is honest, three dead links were not.

**3. THE CART EMPTIED ITSELF DURING A COLD START.** The worst of the four. A
cart line stored only `{ id, qty, variant }`, so every name and price came from
a live `PRODUCTS` lookup, and `getCartLinesWithProducts()` discarded any line it
could not resolve. For the whole of a 30–60 second cold start the shopper saw
the cart badge reading **3** and *"Your cart is empty"* inside the drawer, the
cart page and the checkout.

Worse, `getCartSubtotal()` sums that same filtered list, so the checkout quoted
a total that excluded the missing lines — and the order still went through at
the correct amount, because the client sends only `{ productId, variantId,
quantity }` and the server computes every figure from the database. Being
charged an amount you were never shown is a trust failure whatever the cause.

Two fixes. A line now records what it needs to describe itself (`snap`) at the
moment it is added, and falls back to that whenever the catalog cannot answer —
the live product still wins whenever it is present, so a price change is picked
up the moment the catalog lands, and `backfillCartSnapshots()` heals carts saved
before this existed. And `placeOrder()` refuses outright while any line is
unresolvable, rather than taking payment against a total it cannot vouch for.

**The snapshot on a cart line is display data and nothing else.** It is never
sent to the server and never used to compute what anyone pays. Verified: with
the API unreachable and `PRODUCTS` emptied, the cart shows the same two lines
and the same ₹8,297 total it showed while healthy.

**4. A cache-busting reload could fire 60 seconds into a visit.**
`checkSiteVersion()` resolves over the network, so on a cold API it lands a
minute in. That was harmless when the visitor was still staring at an empty
page; now they are reading a product, and reloading discards their scroll
position, an open drawer, or a half-filled address form. It now reloads only if
they have not interacted yet, and otherwise waits for their next visit.

##### The awakening screen

A full-viewport chakra — the hero Sri Yantra — sits in the **markup** at the top
of `<body>`, with its own inline `<style>`. Both details matter: a loading screen
rendered by the app it is covering for is no loading screen at all, and one that
waits for a stylesheet hundreds of KB further down the document is not much
better.

Two bounds, in `AWAKEN_MIN_MS` (900) and `AWAKEN_MAX_MS` (4000):

- The **floor** stops it flashing. With the snapshot in place the page is
  usually ready in ~300ms, so without it the brand mark would appear and vanish.
- The **ceiling** is the four seconds asked for, and it is a ceiling rather than
  a fixed duration on purpose. A splash that always ran its full length would
  make every visit slower than the storefront actually is, delay Largest
  Contentful Paint on every page, and cost conversions on exactly the mobile
  connections this market runs on. **To make it a flat four seconds instead, set
  `AWAKEN_MIN_MS` to 4000** — that is the only change needed.

Measured: visible at full opacity to 900ms, fading by 962ms, gone from the DOM
at 1767ms.

It can never become permanent. The ceiling is armed unconditionally at parse
time, and both an `error` and an `unhandledrejection` listener dismiss it
immediately. Both listeners are required: `init()` is `async`, so a throw inside
it surfaces as a rejection and fires no error event — without the second one, a
dead boot would sit behind a full-screen overlay.

##### Waking both sleeping services, not just one

There are **two** things asleep, and they wake independently. `/api/health`
touches no database, so it answers as soon as Node is listening — the earliest
honest signal that Render is back. `/api/ready` runs `SELECT 1`, which is what
actually resumes the Neon compute. Firing only the first meant the database
only began waking when the first real query arrived, so the visitor paid the
Render cold start **and** the Neon one, in series. Both now go out from the
`<head>`, before the markup is parsed, and both are exempt from the rate limiter.

##### Keeping the published snapshot fresh, without burning the build budget

A returning visitor always has their own copy in `localStorage`, refreshed every
visit. A **first-time** visitor has only whatever `catalog.json` was published on
the last deploy — which on a site that deploys rarely can be weeks behind.

`.github/workflows/refresh-catalog.yml` runs every six hours, compares the live
catalog against the one currently being served, and asks Netlify to rebuild
**only when they actually differ**. The comparison is the whole point: Netlify's
free plan allows 300 build minutes a month, and rebuilding on a timer would
exhaust it and then stop deploying anything at all — including real code changes
— which is far worse than a stale price. The fingerprint covers only the fields a
visitor actually sees, so a reordered API response or a new unused column is not
a change.

It is optional and fails safe. Without `NETLIFY_BUILD_HOOK_URL` set it logs and
exits; if the API will not wake, or returns an empty catalog, it does nothing
rather than publishing an empty shop. Check drift by hand any time with:

```bash
npm run catalog:drift
```

##### Actions taken while the backend is asleep (the outbox)

The cart and the wishlist already live in `localStorage`, so they never needed a
server. Everything else a visitor can *do* was a bare POST that simply failed
while the instance was cold: a restock alert, a newsletter signup, a contact
message all ended in *"Could not add you to the list. Please try again."* That
is a dead end, and it is not even true — nothing was wrong with the request
except when it was made.

Those three are now recorded locally, confirmed to the customer at once, and
delivered the moment the backend answers. From their side the site behaves
identically whether it was awake or asleep.

**What may be queued, and what may never be.** Only actions where *"we will do
this shortly"* is an honest thing to say. A payment, an order, a booking and a
login all hand the customer something that cannot be invented — money moves, a
slot is held, a token is issued. `OUTBOX_ROUTES` is an allowlist and
`queuedPost()` throws on any path not in it, so a future call site cannot make a
payment fire-and-forget by reaching for the wrong helper. The test suite asserts
that list never grows to include `payments`, `orders`, `bookings` or `auth`.

**Duplicates.** `stock-notify` and `newsletter` are `ON CONFLICT` upserts
server-side (see `engagement.routes.js`), so replaying either changes nothing
and they stay queued until they land. `contact` is a plain `INSERT`, so a replay
would open a second support ticket — it is dispatched **at most twice** and then
handed back to the customer with an honest message rather than retried forever.

A 4xx is never queued. `isTransportFailure()` separates *"the server is asleep"*
from *"the server refused this"*; queueing a refusal would only replay the
refusal. The queue is bounded to 40 items and 7 days, and drains on wake, on tab
focus, and when the browser regains a connection — each of those checks the
queue is non-empty first, so a visitor with nothing pending never pays for a
probe.

**One bug found by testing this, worth recording:** the branches that give up on
an item filtered it out of the in-memory array but never wrote that back. The
item stayed at `dispatched: 2` forever — it could never be sent, never be
cleared, and re-toasted its own failure on every flush for the rest of the
visit. Every removal now goes through a single `drop()` helper so the write
cannot be forgotten again.

##### The wait before a payment, and what it is spent on

A restock alert can be recorded and delivered later. A payment cannot, and
neither can a booking — a slot has to be held against real availability, and
confirming a pandit before anything confirmed one is worse than any wait. So for
those the wait is unavoidable; the only question is what it is spent on.

`withBackendReady()` gates `placeOrder`, `confirmPujaBooking` and
`confirmAstroBooking`. **When the backend is already up it runs the action
immediately — measured at 0ms, with no modal and no artificial delay anywhere.**
Only when it is not does the waiting screen appear, and it closes the instant
`/api/ready` confirms both the web process and the database are up.

Readiness is re-checked rather than answered once at page load: Render sleeps
after ~15 minutes and Neon after ~5, so a session that started warm can go cold
while someone is still reading. `BACKEND_READY_TTL_MS` (45s) bounds how long an
"awake" answer is trusted, and every successful API call refreshes it for free,
so an active session almost never probes at all.

**What the wait shows.** Six strategies, chosen for what is actually in the cart
and rotated so the same card cannot simply reappear to fill time:

| Strategy | Fires when |
|---|---|
| Complete the ritual | Pairs categories that genuinely belong together (a lingam with samagri, a mala with books) |
| Free shipping is ₹X away | Subtotal is under ₹999, and only items that actually close the gap, cheapest first |
| Small things worth having | Items under ₹500, most-reviewed first |
| Most chosen this season | Bestsellers not already in the cart |
| Looking after it | A genuine care note for the material in their cart — no products at all |
| From the Journal | An article, when there is nothing useful left to suggest |

Every product shown is real, from the last catalog the site actually served.
Adding one is an ordinary local cart write, which is exactly why it can be
offered with the server still cold — the test suite asserts `waitAddSuggestion`
touches no network.

**The rule that matters: the intent is never lost.** Whether they add three
things, dismiss every suggestion, or sit and read, the original action continues
on its own the moment the backend and database both answer — with whatever they
added included, because `placeOrderNow()` reads the cart when it *runs*, not
when it was requested. That is why `placeOrder` was split in two, and the test
suite asserts the items array is built inside `placeOrderNow`.

Cancelling genuinely cancels: the intent is dropped, `withBackendReady` returns
`undefined`, and a later wake does not resurrect it. Escape routes through
`cancelWaitingExperience()` rather than `closeModal`, because hiding the box
while leaving a pending intent alive would fire an order later with nothing on
screen to explain it. A 120-second ceiling ends the wait honestly: nothing
charged, cart saved, try again.

**Business note.** This turns the worst moment on the site — a shopper with
their card out, waiting — into the one place a relevant cross-sell is genuinely
welcome. It is measured against the same catalog the storefront renders, so it
costs nothing extra to run and nothing extra to maintain.

##### The storefront origin — read it, never assume it

**The site is live at `https://chakrashri.netlify.app`.** The custom domain
`www.chakrashri.com` is not attached yet and currently 404s.

That distinction is not cosmetic. Every build script writes absolute URLs —
`canonical`, `og:url`, each `sitemap.xml` entry, the Product JSON-LD
`offers.url` — and all four defaulted to the custom domain. The result was a
storefront telling Google that every real page was a duplicate of an address
that does not resolve, and handing every WhatsApp preview a dead destination.
Nothing on the site itself looks wrong when this happens, which is what makes it
dangerous. `npm run check:share` caught it as a 404 against the live URL.

Scripts now read `SITE_ORIGIN || URL`, falling back to the Netlify subdomain.
**`URL` is set by Netlify during every build to the site's primary domain**, so
attaching the custom domain later needs no code change at all.

Three literals cannot read an environment variable and are the only things to
change at cutover:

| File | What to change |
|---|---|
| `index.html` | `<link rel="canonical">` and `<meta property="og:url">` in the head, the two JSON-LD `url` fields, and the `SITE_ORIGIN` `file://` fallback |
| `robots.txt` | the `Sitemap:` line |
| Render dashboard | `CLIENT_URL` — or add both origins to `ADDITIONAL_CLIENT_ORIGINS` during the cutover, or CORS blocks the storefront |

`npm run check:storefront` compares those literals against the origin the build
actually uses and **fails** when they disagree, so this cannot silently rot
again. Run it after any domain change.

##### Checking the storefront artifacts

Two questions come up every time you build these: *did the snapshot capture
everything?* and *do shared links actually show the right thing?* Both are npm
scripts:

```bash
npm run check:storefront
```

Reads `catalog.json` and `product/` and reports what a visitor would really get:
product/category/service counts, snapshot age, missing slugs or prices,
duplicate slugs, which products have no image (their link previews are text-only),
what is out of stock, whether every product has a page, and a spot-check of one
generated page's title, `og:image`, Product JSON-LD and inline payload. Exits
non-zero on anything that would reach a customer.

```bash
npm run check:share
```

The same, plus it fetches the **live** site to confirm the deployed product page
carries the product's own `og:title` and that `/catalog.json` is being served.
Run it after a deploy; if it reports the generic site title, the prerender step
did not run in the Netlify build.

**Both exist as npm scripts for a specific reason.** They were originally handed
over as `node -e '...'` one-liners and both *failed when run*: PowerShell
re-quotes arguments on their way to a native executable, so the double quotes
inside a single-quoted string are stripped and node receives
`require(./catalog.json)` — a syntax error that reads like a broken project
rather than a broken command. A verification command that cannot be pasted and
run is worse than none, because it costs confidence before telling you anything.

##### The related-products rail

`renderRelatedProducts` passed same-category matches straight to
`renderGridInto`, and an empty list there renders the **shop grid's** empty
state: *"No products found. Try adjusting your filters, or ask Chakra AI for a
recommendation."* with a **Clear Filters** button — inside a product page, where
there are no filters at all. With a catalog spread thinly across categories,
which is the normal state of a growing shop, that was most product pages. It was
only obvious once the rail was checked against the real 10-product catalog.

It now takes same-category matches first, tops the rail up from the rest of the
catalog (bestsellers first) so it is useful rather than empty, hides the whole
section when there is genuinely nothing to show, and relabels the heading *"More
From Chakrashri"* when the products shown are not actually related — because
calling them Related when they share nothing is the same class of small untruth
as everything else this work removed.

##### Variant prices in the cart

The server prices a variant line from `variant.price_paise`, falling back to the
base product when that column is NULL (`utils/orders.js`). The cart recorded the
chosen `variantId` and its image but **never its price**, so every number the
customer saw — the mini-cart unit price, the cart page price and line total, the
checkout line total, and the subtotal that drives the free-shipping threshold —
was the **base product** price.

The order was never wrong: the client sends only `{ productId, variantId,
quantity }` and the server computes every amount itself. What was wrong was the
number the customer agreed to. Someone choosing a dearer variant was quoted the
cheaper figure all the way to the payment sheet and then charged correctly.

`cartUnitPrice(line, product)` is now the single reader for every cart price, and
`variantUnitPrice(product, variant)` mirrors the server's rule exactly — including
the NULL-inherits-base case — so Add to Cart and Buy Now cannot drift apart.
**Buy Now was the easier one to miss and the worse one to get wrong**, since it
goes straight to checkout; a test asserts both call sites pass the price.

Three deliberate properties:

- **The recorded price is display data only.** It is never sent to the server and
  never prices an order. A test asserts it cannot leak into the order payload.
- **Carts saved before this fix still render.** A line with no `unitPrice` falls
  back to the base price — exactly what it did before, so nothing regresses.
- **Those legacy lines repair themselves.** The product detail fetch is the only
  place variant prices reach the client, so `refreshCartVariantPrices()` runs
  there and corrects any stale or missing line price.

Only one product in the catalog currently has variants (`dhoti`), so the blast
radius was small — but it would have grown silently with every variant product
added.

##### What the waiting screen says, and what it must never say

Three things were wrong with it in practice, all found by looking at a real
screenshot rather than at the code.

**The suggestion cards showed a drawing of nothing.** `waitItemHTML` rendered
`productMediaSVG(p.cat)` — the generic category glyph — so every product in the
one moment we are asking the customer to stay looked like a faceless
placeholder, even though eight of ten products carry a real photo. It now uses
`productThumbInnerHTML`, the same helper the cart and checkout already use, so
the picture matches the next screen and a dead image URL still falls back
gracefully.

**The copy confessed.** At the exact moment a customer was about to pay, the
status read *"Our server is waking up — this happens on the first order after a
quiet spell."* That volunteers that our infrastructure is unreliable while
asking for money, and explains an idle policy to someone who never asked. Every
such line is now about **their order**, and every one is still true:

| Before | Now |
|---|---|
| "Connecting to our payment service…" | "Setting up your secure payment…" |
| "Our server is waking up — … after a quiet spell." | "Confirming availability and preparing your order…" |
| "Almost there. … we are nearly connected." | "Thank you for your patience — finalising your secure checkout." |
| "Waking the server — first visit after a quiet spell" | "Preparing the collection for you…" |
| "This is on us, not on you — our storefront is waking up." | "We are refreshing the collection. Please try again in a moment." |
| "Could not reach the server — it may be starting up." | "That did not go through just now. Please try again in a moment." |

A test scans the file with comments stripped and fails if any of the old
phrasings returns — the comments explaining this fix legitimately quote the old
wording, and a naive scan would match its own documentation.

**The suggestions ignored the cart.** `small-additions` and `bestsellers` sorted
on price and badge alone, so someone buying a lingam could be offered a dhoti.
Both now run through `waitRelevanceSort()`, which scores a known `RITUAL_PAIRS`
pairing highest, then the same category, then everything else, breaking ties on
bestseller badge and review count.

##### Two more found by running the code, not reading it

**A suggestion could offer something the customer cannot buy.** `buyable()` was
stock + not-already-in-cart, which let a product **with variants** be suggested.
A suggestion card has no size selector, so Add put it in the cart with no
`variantId` — and the server refuses to sell a variant product without one
(`utils/orders.js`). The sequence would have been: customer waits, adds the
suggested item, backend wakes, **order rejected at the moment of payment**. The
exact failure the waiting screen exists to prevent, caused by the screen itself.

`qvAddToCart` solves the same problem by bouncing the customer to the product
page to choose an option. That is wrong here — it would abandon the waiting
screen and discard the pending payment intent. So variant products are simply
never suggested. Verified against the live catalog: `Dhoti` is correctly
excluded, leaving 9 of 10 products suggestable.

**No product thumb clipped its photo.** `border-radius` alone does not clip a
child image; without `overflow: hidden` a square photo renders hard-cornered
inside a rounded frame. This was true of `.mc-thumb`, `.cart-thumb`,
`.order-review-item .thumb` **and** the new `.wait-item .thumb` — so it had been
visible on the mini-cart, the cart page and the checkout all along, and only
became obvious once real photos replaced the flat glyph. All four now clip.

Measured in the browser against the live stylesheet before and after: the image
fills its 132×132 thumb exactly, does not overflow, and the glyph fallback for a
photo-less product is still sized correctly at 52%.

##### A trap worth remembering: copy is not control flow

Rewording that error message silently broke something. `isTransportFailure()`
decided whether an action was retryable by **pattern-matching the user-facing
sentence** — so changing it for tone stopped queued actions being recognised as
transport failures, and the outbox would have discarded them instead of saving
them for delivery.

It survived only by luck: queued POSTs are non-retryable and threw the *other*
message, which still matched. That is not a safety margin.

`apiFetch` now throws `{ transport: true, ... }` and `isTransportFailure` reads
the flag first, keeping the text match only as a legacy fallback. **Copy and
control flow must never share a source of truth** — the text is for the
customer and must stay free to change.

##### The wake call is the first request the page makes

`<head>` order matters here in a way that is not obvious, and getting it wrong
cost exactly what this work exists to save.

**An inline script element is blocked until every stylesheet before it has
loaded** — the browser must assume the script might read computed styles. The
wake-up block sat *after* the render-blocking Google Fonts stylesheet, so the
knock on `/api/health` and `/api/ready` was not sent until `fonts.googleapis.com`
had answered. On a slow mobile connection that is hundreds of milliseconds added
to a 30-60 second cold start, for nothing.

It now sits **above** the font tags, so the two knocks are the first requests the
document makes — before fonts, before the stylesheet, before 460KB of markup is
parsed. Both `/api/health` (wakes the Render process) and `/api/ready` (runs
`SELECT 1`, which resumes the Neon compute) go out together, so the two sleeping
services wake in parallel rather than in series.

This applies to every entry point equally: the home page, a prerendered product
page opened from a WhatsApp link, or any deep link. There is a comment above the
block warning against reordering it.

##### The welcome screen

The first thing a visitor sees is the hero Sri Yantra, the words **Welcome to**,
and **CHAKRASHRI** rising one letter at a time under a slow gold sheen. It sits
in the markup at the top of `<body>` with its own inline `<style>`, so it paints
from the first bytes of the document rather than waiting on 460KB of app script
or a stylesheet hundreds of KB further down.

**2.6 seconds, shown once per session.** Both halves of that are deliberate, and
the number is bounded from both directions.

*Why not longer.* The storefront renders from the catalog snapshot in ~300ms, so
for almost every visit this screen is not masking work — it is holding a finished
page back. A full-viewport overlay defers the real Largest Contentful Paint
element until it lifts, so **the dismissal time IS the LCP**:

| Threshold | Limit | At 5s | At 2.6s |
|---|---|---|---|
| Core Web Vitals LCP | ≤2.5s good, >4s poor | poor | needs-improvement |
| Mobile abandonment | climbs sharply past 3s | past it | inside it |
| Conversion (Google/Deloitte) | ~1% lost per 100ms | ~25% exposure | ~13% |

A product page opened from a shared WhatsApp link is the highest-intent arrival
there is; gating the price behind five seconds is the worst place on the site to
spend them.

*Why not shorter.* The letter stagger finishes at 1.53s and the sheen begins at
0.9s. Below about 2.4s the animation is cut mid-sweep and reads as a glitch
rather than a greeting. 2600ms lands just past it — the welcome completes,
settles for a beat, and lifts.

*Once per session* is the larger win, and it is what brand-led storefronts
actually ship. A shopper who opens six products should be greeted once, not six
times. The head boot script sets `html.welcomed` **before the body is parsed**,
and `display:none` means a repeat load never paints, measures or animates the
overlay at all — no flash, and no LCP penalty on any page after the first.
`sessionStorage`, not `localStorage`: a customer returning tomorrow is a new
arrival and should be welcomed again. If storage throws (private mode) it falls
through and greets, which is the safe direction.

It can also always be dismissed — a tap, Escape, Enter or Space. A greeting that
cannot be skipped is an obstacle.

`AWAKEN_MAX_MS = 4500` stays deliberately **above** the floor. It is the
unconditional safety net for a boot that throws before `releaseAwakeningScreen()`
is reached; making the two equal would leave no margin for the normal release to
fire, and a loading screen that can become the site is the one failure this must
never have.

Verified in a browser: first arrival paints it; a repeat load computes to
`display:none` with **0px painted area**; private mode greets. Verified with a
real page reload that the session flag survives, so **every reload loads the site
directly** rather than replaying the welcome.

Three details that are easy to get wrong and are covered by tests:

- **The name can never render invisible.** `background-clip:text` with a
  transparent fill shows *nothing* where it is unsupported — on the one screen
  whose entire job is to show the name. A solid `#E8CE86` is set first and the
  gradient only applies inside an `@supports` guard.
- **Reduced motion shows the finished state, not the starting one.** Cancelling
  the animations without also restoring `opacity:1` would leave every letter at
  zero and the brand would simply never appear.
- **A screen reader hears "Chakrashri", not ten letters.** The spans are
  `aria-hidden` and the wrapper carries `aria-label`.

**Sized by measurement, not by guess.** Verified in a real browser at each
viewport — brand width against available width after the 6vw side padding:

| Viewport | Font | Brand | Available | Headroom |
|---|---|---|---|---|
| 320 | 28px | 259px | 282px | +22px |
| 375 | 32px | 295px | 330px | +35px |
| 768 | 56px | 518px | 676px | +158px |
| 1280 | 56px | 518px | 1126px | +608px |
| 1600 | 56px | 518px | 1408px | +890px |

No horizontal body scroll at any width. A separate `max-height:520px` rule
shrinks the mark and the name on a landscape phone, which is short rather than
narrow and would otherwise clip.

##### Why the waiting screen almost never appears — and that is correct

Testing this by hand is confusing, and it is worth writing down why. Waiting
twenty minutes and then buying something will **not** show the waiting screen,
because the external scheduler calls the job trigger every ten minutes and that
call keeps Render awake. The instance is essentially never idle long enough to
spin down. Verified: the last job run was 2.6 minutes old and `/api/health`
answered in 561ms — a cold start takes 30-60 seconds.

`withBackendReady()` returns immediately when the backend is confirmed up, which
is the designed behaviour: *"when the backend and database are active there is
no need for this waiting."* So a healthy site never shows it.

It still exists for the cases the scheduler cannot cover:

- the minute or two after a deploy, while Render restarts
- if the cron-job.org schedule fails, is paused, or the account lapses
- a free-tier eviction, which Render does not announce

To see it deliberately, open the browser console on the live site and run:

```
backendReady = { awake: false, at: 0, inFlight: null };
probeBackend = async () => false;
withBackendReady(async () => 'ORDER', { title: 'Preparing your secure checkout' });
```

Verified end-to-end against the live site: the modal opens, the order does **not**
run, the cart stays intact, and when the backend wakes the order proceeds
automatically without the customer touching anything.

**Monitor the scheduler**, because it is now the only thing keeping the site warm:

```bash
npm run jobs:status
```

If the last run is more than ~15 minutes old, check the cron-job.org dashboard.
That timestamp lives in memory and resets on every deploy, so "no run yet" is
normal immediately after deploying.

##### Suggestion variety depends on your categories

The `complete-ritual` strategy pairs categories using `RITUAL_PAIRS`, which is
keyed by the canonical slugs (`lingam`, `yantra`, `idols`, `malas`, ...). But
categories are admin-created and free-form: this catalog uses `book` (not
`books`), `dhoti` and `sphatik`, none of which the map knows. The strategy
returned `null` for almost every real cart, quietly cutting the waiting screen's
variety by a third — and it would have failed the same way for every new category
added from now on.

It now falls back to categories the customer does **not** already have in their
cart, sorted bestsellers-first. Because that is a weaker claim, it gets weaker
wording — *"Also in the collection"* instead of *"Complete the ritual"* — on the
same principle as the Related Products rail: never assert a relationship the data
does not support.

Measured against the live 10-product catalog, every cart now has **2-4** usable
strategies. `bestsellers` still declines for most carts, correctly: there is only
one bestseller-badged product, and a suggestion rail with one lonely card is
worse than a different suggestion. Badging more products improves it with no code
change.

##### Four defects found in the final audit, and what they teach

These were introduced by the outbox and waiting-screen work above and found by
re-reading the code rather than by a failing test. Recorded because each one is
a pattern, not a typo.

**1. `undefined !== false` is true.** `queuedPost` read
`isBackendKnownAwake() || opts.tryLiveFirst !== false`, and no real call site
passes `tryLiveFirst`, so the right-hand side was permanently true and the whole
condition always true. Every queued action therefore attempted a live POST
against a sleeping instance first — 30 seconds of `apiFetch` timeout, with the
"our server is waking up" notice appearing — before finally queueing. The outbox
existed to remove exactly that experience and was reintroducing it. *An
option-defaulting expression that is true when the option is absent is not a
default; it is an unconditional.*

**2. Moving a slow step earlier can unguard a fast one.** "Place Order & Pay" is
a plain `onclick` with no re-entrancy guard of its own, and never needed one:
`placeOrder` synchronously hid the checkout layout and showed the processing
pane, so the button was gone within a frame. Putting the backend wait *before*
that swap left the button live and clickable for up to two minutes — and two
taps, which is precisely what an impatient shopper does when nothing appears to
happen, meant two orders and two charges. The guard now lives in
`withBackendReady`, so the bookings are covered too and any money path added
later inherits it. *Check what was protecting a thing implicitly before you
change when it runs.*

**3. A modal is not a page.** Browser-back during the wait left the overlay on
screen with a live intent behind it, which would then place an order from a
screen the customer had already left. `popstate` now cancels it.

**4. Claim a lock before the thing you await, not after.** `flushOutbox` probed
the backend and only then set `outboxFlushing`, so two callers arriving together
— a wake notification and a tab focus, say — could both pass the unclaimed lock
and deliver the same queued items twice.

A fifth, found earlier the same way: the outbox branches that gave up on an item
filtered it out of the in-memory array but never wrote that back, so the item
stayed at `dispatched: 2` forever — never sent, never cleared, re-toasting its
own failure on every flush. Every removal now goes through one `drop()` helper.

All five are covered by `[fe-19]` in `test/frontend.test.js`.

**A note on writing those tests:** two of them initially failed against correct
code, because the assertion matched the explanatory *comment* rather than the
code — the same trap as the earlier duplicate-`id` scan. When a test greps
source, its own documentation is part of what it greps.

##### Two things left deliberately alone — your call, not mine

- **The testimonials on the home page** are hardcoded and attributed to named
  individuals with cities ("Priya Sharma, Pune"). If those are real customers
  quoted with permission, nothing needs doing. If they are placeholder copy,
  they are the same class of problem as the demo catalog, and they carry more
  risk: the Consumer Protection Act 2019 and the BIS standard on online consumer
  reviews both treat fabricated testimonials as a misleading advertisement.
  Product reviews are *not* affected — those are real, and come from the API.
- **The hero statistics** (40,000+ devotees served, 4.8/5, 120+ verified
  priests, 12 years in service) are unverifiable from the code. They are
  business claims, so they are yours to stand behind.

##### A caveat about Neon, before you add a second schedule

Neon suspends its compute after ~5 minutes idle, so the 10-minute job trigger leaves it asleep
about half the time. It is tempting to add a 4-minute ping at `/api/ready` (which runs `SELECT 1`)
to keep it permanently warm — **check your Neon compute-hour allowance first.** Keeping it awake
round the clock is ~730 compute-hours a month, which is well beyond what the free plan includes,
and exhausting it takes the database down rather than just making it slow.

You almost certainly do not need to. Neon's wake is seconds, not the tens of seconds Render costs,
and the tiers above already hide it — the job trigger's own database work keeps it warm during
the window that matters anyway.

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
  middleware/   # auth (JWT + RBAC), capabilities.js (AUTH-02 capability gating), validate.js
  routes/       # auth, products, payments, bookings, admin, customer, engagement, site, support
  utils/        # stock.js, orders.js, crypto.js, cors.js, settings.js — see "Round 4" below
    email/      # engine.js (consent, suppression, dedupe, send) + templates.js (the 24 emails)
  server.js
migrations/     # 001-015, applied in filename order and tracked in the _migrations table.
                # 013 security/integrity, 014 CONCURRENTLY indexes (non-transactional),
                # 015 the email system + the three storefront capture surfaces.
                # NEVER edit an applied migration — CI fails the build if you do, because the
                # runner tracks by filename and will not re-run a file it has already recorded.
scripts/        # run-migrations.js, verify-full.js (THE pre-deploy gate), create-admin.js,
                # test-db-connection.js, test-razorpay-connection.js, reconcile-payments.js,
                # release-expired-orders.js, send-scheduled-emails.js, check-syntax.js
test/           # Every suite runs the REAL application modules — no reimplementations.
                #   unit / coupons / http / security  — offline logic and middleware
                #   frontend            — parses index.html + admin.html: CSP, SRI, XSS,
                #                         accessible names, capability gating
                #   browser-cards       — renders a product card in Chromium and clicks it
                #   browser-settings    — renders the admin settings screen in Chromium
                #   db-integration      — real Postgres: concurrency, refunds, constraints
vendor/         # Self-hosted third-party assets, pinned by SRI hash. Marked `-text` in
                # .gitattributes — see Round 17 before touching anything in here.
admin.html      # The admin console (10 views). index.html is the storefront.
```

## Round 19 — Email Was Sending Perfectly and Nobody Was Receiving It

**Every email was logged `sent`. Customers were not reading them.** They were in Spam and
Promotions, and no amount of looking at the application would have shown why, because from the
server's point of view nothing was wrong: SMTP accepted every message, `email_log` recorded
`sent`, the cron exited 0.

The cause was one environment variable:

```
SMTP_HOST=smtp-relay.brevo.com          ← relaying through Brevo, correctly
FROM_EMAIL=Chakrashri<...@gmail.com>    ← while claiming to be a gmail.com user
```

Sending through one provider while putting another domain in `From` is, to every receiving mail
server, indistinguishable from spoofing:

- **SPF fails** — `gmail.com` authorises Google's servers, not Brevo's.
- **DKIM cannot align** — Brevo signs as Brevo; nobody can sign for a domain they do not own.
- **DMARC fails** — it needs SPF *or* DKIM aligned to the From domain, and neither was.

Gmail is especially strict when the impersonated domain is `gmail.com` itself. Spam was the
lenient outcome.

**The fix was configuration, not code:** authenticate `chakrashri.com` in Brevo, add its DKIM
records plus SPF and DMARC to DNS, and set `FROM_EMAIL` to an address at that domain. No deploy.

**How to verify it, on any future change** — open a received message's headers. All three must
name your domain:

```
from:       Chakrashri <orders@chakrashri.com>
signed-by:  chakrashri.com          ← DKIM alignment, the decisive one
mailed-by:  mail.chakrashri.com     ← Return-Path, for SPF alignment
```

If `signed-by` ever shows your provider instead of your domain, alignment is broken again and
mail is silently going to Spam. **This cannot be caught by any test in this repo** — the
application has no visibility into inbox placement. It is checked by reading headers, or not at
all.

### Three silent-failure defects found while diagnosing this — now fixed

**1. A failed send was marked as delivered, forever.** `runBackInStock` claims rows by setting
`notified_at` *before* attempting the send — correct, because it is what stops two concurrent runs
mailing the same person twice. But the claim was never released when the send failed. The admin
console showed the notification delivered, the cron exited 0, and a customer who explicitly asked
to be told about a product was never told and never retried. `runAbandonedCheckout` had the
identical bug with `recovery_email_sent_at`.

Both now release the claim when the failure is retryable. "Retryable" means *not* in
`TERMINAL_SKIP_REASONS` (exported from `email/engine.js`): duplicate, suppressed, no recipient, no
consent, marketing disabled. Anything else — including an arbitrary SMTP error string, which
cannot be enumerated — is retried. That default is deliberate: a duplicate email is a far smaller
harm than a promise silently dropped.

**2. The job's exit code ignored send failures.** `failures` incremented only when a job *threw*.
Every individual send could fail and the script still exited 0 — cron green, console green,
no mail. The exit code is now `crashed + sendFailures`, so a non-zero exit means "mail did not go
out" rather than "the script reached the end". Deliberate skips are excluded, or the job would be
permanently red and everyone would learn to ignore it.

**3. The storefront could silently show a truncated catalog.** `loadCatalog` requested
`?limit=1000`; the API clamps limit to 100 as a DoS guard and reports the real figure in
`pagination.totalCount`, which the storefront never read. The 101st product would simply not
appear — no error, no warning, HTTP 200. It now pages until `totalCount` is satisfied, warns
loudly if it cannot, and bounds the loop at 50 pages so a paging bug cannot hang the browser.

Locked by tests: `[fe-12]` asserts the storefront pages and checks `totalCount`; `[db-11]` forces
a real SMTP failure (loopback port 1, which refuses instantly) and asserts `notified_at` returns
to NULL and the error reaches `email_log`. Mocking would have proven nothing there — the thing
under test is the SQL that releases the claim.

### Original write-up of two of those defects, kept for context

1. **`runBackInStock` sets `notified_at` before the send is attempted**, in the same
   `UPDATE … RETURNING`, and never rolls it back. A failed send is marked delivered and never
   retried — a customer who explicitly asked to be told would never be told.
2. **The scheduled-email job's exit code ignores send failures.** `failures` increments only when
   a job *throws*; per-send outcomes are counted into `sent` and discarded. `exit=0` means "the
   job ran", not "the mail went out".

Neither caused this incident, but together they meant a genuine SMTP outage would have looked
identical to success in every place anyone would look. Both are fixed — see above.

### Also worth knowing

`npm run email:log` (and `-- --failed`) reads `email_log` and answers "why did that email not
arrive?" — status, template, masked recipient and the SMTP error. It is the only tool that
distinguishes *not sent* from *sent but not delivered*, which are entirely different problems.

## Round 18 — `render.yaml` Was Never In Effect, and Nothing Scheduled Had Ever Run

**The finding: the live Render service was created by hand in the dashboard, so `render.yaml`
has never governed anything.** A blueprint file only applies to services created *from* it. The
proof was in the region — the file says `region: ohio`, the running service is in **Oregon** —
plus a dashboard showing one service under "Ungrouped Services" and a deploy log going straight
from `==> Deploying...` to `==> Running 'npm start'` with no migrate step.

Consequences, all live at the time:

- Migration 015 never reached production, so 1.2.0 served a schema without `email_log`,
  `stock_notifications`, `email_subscriptions` or `contact_messages`. The three storefront
  capture forms were returning errors, and order-confirmation dedupe was silently disabled —
  meaning a browser-confirmed *and* webhook-confirmed order could mail the customer twice.
- **None of the three cron services existed.** No expiry sweep (abandoned checkouts held stock
  permanently), no payment reconciliation (the safety net for "customer paid, webhook throttled",
  which ends with the order cancelled and the money captured), no scheduled email.

Render's free plan offers neither cron services nor a pre-deploy command, so these were replaced
rather than fixed in place. `render.yaml` is kept intact for the eventual upgrade and now opens
with a header stating plainly that it is inert, how that was determined, and what to do on
upgrade. Full setup lives in "Running on the free plan" above.

**`.github/workflows/migrate-on-deploy.yml`** replaces `preDeployCommand`. It fails loudly when
`DATABASE_URL` is absent instead of skipping — a migration step that silently does nothing is the
exact failure being fixed. It runs only on pushes touching `migrations/`, so it costs a few
Actions minutes a month.

**`src/routes/jobs.routes.js`** replaces the three cron services: one token-guarded endpoint a
free external scheduler calls every 10 minutes, which also keeps the instance warm.

Two decisions in it are load-bearing:

- **It spawns child processes rather than importing the scripts.** `release-expired-orders.js`
  and `reconcile-payments.js` call `main()` at import time and then `db.pool.end()` and
  `process.exit()` — requiring either from the web process would close the pool the API is
  serving from and shut the server down. (`send-scheduled-emails.js` *is* import-safe, which is
  precisely the kind of asymmetry that becomes a 3am outage.) Spawning is also what Render's cron
  does, so exit codes and pool lifetimes stay exactly as designed.
- **The token is read from a header, never a query string.** morgan logs `:url` on every request,
  so `?token=…` would write the credential into the log on every run. A test asserts `req.query`
  never appears in that file.

It fails closed: with `JOBS_TRIGGER_TOKEN` unset or under 32 characters the endpoint answers 503
and runs nothing. Eight tests cover the guard; **none of them ever POST to `/run` with a valid
token**, because that spawns the real scripts, which load the real `.env` and would operate on
the production database — the suite's db mock does not reach into a child process. There is a
comment saying so above them.

`.github/workflows/keep-alive.yml` now carries a warning to disable it before the repository goes
private: at every 10 minutes it is ~4,300 runs a month against a 2,000-minute free allowance, so
it would starve CI and the migration workflow. The external scheduler above replaces it.

`scripts/jobs-trigger.js` (`npm run jobs:status` / `npm run jobs:run`) exists because the two
questions this setup raises — "is the schedule actually firing?" and "run it now, I am not
waiting" — otherwise mean hand-assembling a curl with the token in it, which is how secrets end up
in shell history and screenshots. It reads the token from `.env` like every other script here.

**Proven end to end against production on 2026-08-29:** `jobs:status` first reported
`NO RUN HAS EVER HAPPENED` — correctly, because no scheduler was configured yet — and a manual
`run expiry-sweep` then completed with `exit=0` in 5.7s, releasing stock that had been locked by
abandoned checkouts since the beginning. That single run exercised the whole chain: token auth,
routing, child-process spawn, the real script against the real database, exit code capture, and
status reporting.

One trap that cost a debugging cycle, recorded so it is not repeated: the CLI originally used
global `fetch`, whose socket stays in a connection pool after the response. Calling
`process.exit()` with that pool open aborts the process on Windows with a libuv assertion printed
*after* the real output, so a correct run looked like a crash. It now uses the built-in `https`
module with `agent: false`. When that swap was made, `if (!res.ok)` was left at the call site while
the replacement helper had no `ok` property — so every success reported "Unexpected response 200".
`ok` is now computed inside the helper, where a future change of HTTP client cannot silently drop
it.

## Round 17 — Running the 1.2.0 Pre-Deploy Gate Found Eight Defects, and the Gate Itself Was One

**The headline: `npm run verify:full` had never successfully run.** Not "was not run" — *could
not* run. Everything below was found by fixing that first and then letting the suite work.

### 1. The gate could not start (`scripts/verify-full.js`)

It checked `process.env.TEST_DATABASE_URL` and **never called `require('dotenv').config()`**, so
it inspected a bare environment, found nothing, and refused to run — while printing instructions
telling you to put `TEST_DATABASE_URL` in the `.env` file it had just declined to read. Every
other script that reads env config loads dotenv; the one guarding them did not. That is why the
value had been sitting correctly in `.env` the whole time and the gate still said it was missing.

### 2. `vendor/**` needed `-text`, or Windows breaks the Chart.js SRI hash

`core.autocrlf=true` (the Git for Windows default) rewrote `vendor/chart.umd.js` on checkout —
205475 bytes becomes 205489, exactly 14 line endings — which changes its SHA-384 so it no longer
matched the `integrity` attribute in `admin.html`.

**The trap, and please remember it:** this looks like a production bug ("the browser refuses the
script and the dashboard charts vanish") but production was always fine — Netlify builds from the
LF blob in git, where the hash matches. Only the Windows working copy was wrong. **Rewriting the
`integrity` attribute to match the local file would have made the test pass and broken the admin
dashboard for every real visitor.** The fix is `vendor/** -text` in `.gitattributes`.

Diagnosing any future hash failure — compare the working copy against the committed blob:

```bash
openssl dgst -sha384 -binary vendor/chart.umd.js | openssl base64 -A
git show HEAD:vendor/chart.umd.js | openssl dgst -sha384 -binary | openssl base64 -A
```

Different values mean line-ending conversion, not tampering.

### 3–5. Migration 015's settings were seeded, documented, and unusable

`setSetting()` refuses any key absent from `DEFAULTS` in `src/utils/settings.js`. All six settings
migration 015 seeds were missing from it, so `PUT /api/admin/settings/admin_alert_email` answered
`400 Unknown setting` and `GET /settings` never returned them. The release notes listed "set
`admin_alert_email` in the admin console" as a required step; it was not possible to do.

Two more surfaced from the same area:

- **`email_marketing_enabled` was read by nothing.** An admin could switch marketing off, watch it
  save, and every campaign kept sending. `sendMail()` now consults it before the consent check and
  records `skipped_marketing_disabled`, so the log distinguishes "this list is switched off" from
  "this person never opted in".
- **Booleans were stored as raw input.** `setSetting` accepts `'0'` for false, but `templates.js`
  and `engine.js` read the row directly and test `value !== 'false'` — so `'0'` read as *off* in
  the settings API and *on* in the mail engine. Booleans and emails are now stored canonically.

`admin_alert_email` is validated on write because it becomes a `To:` header: CR, LF, `<`, `>`,
comma and semicolon are refused. A malformed address otherwise fails at the moment an alert is
being sent, which is precisely when nobody notices — the thing that was lost *was* the alert.

### 6. `test:db` validated a table list frozen at migration 011

It reported `ALL CHECKS PASSED — 21/21 found` against a production database that could be missing
the entire refunds ledger and the entire email system. A check that cannot fail is worse than no
check. The list is now grouped by migration (see the table in "Verifying" above).

### 7. CI never ran `test:frontend`

CI invokes the suites one by one rather than `npm test`, and that step was simply never added. So
the CSP assertions, the XSS-escaping checks, the accessible-name checks, the capability-gating
checks — and **the SRI check that catches defect #2** — were absent from the gate while every
other suite was present. It existed, it worked, and no pipeline ran it. `.github/workflows/ci.yml`
now runs it.

> **If you add a test suite, add it to `ci.yml` as well.** A list of steps kept in sync by hand
> drifts silently, and this is what that drift looked like.

### 8. The settings screen, and a data-loss bug its own test caught

The admin console had nine views and no settings screen — `admin.html` contained the string
"settings" zero times, while migration 015's comment described these values as editable in "the
admin console's settings screen". There now is one (a tenth view, gated on `settings:write`).

It renders whatever the server reports as `editable` rather than a hardcoded list, so a setting
added to `DEFAULTS` appears with no frontend change — a hardcoded list is how the six went missing
in the first place. Controls are built with DOM calls, not interpolated HTML strings: values are
assigned as properties (no attribute-escaping question) and the a11y suite's static scan is not
fed a `for` attribute containing a template placeholder.

`test/browser-settings.test.js` renders the real screen against a stubbed API. It earned its place
immediately by catching a bug in that screen before it shipped: a setting present in `DEFAULTS` but
absent from `SETTING_META` fell through to a **number** input, which silently discards a value it
cannot parse — so a string setting rendered blank, counted as changed the instant the screen
loaded, and would have been overwritten with `''` on the next save. Unknown types now render as
text.

### Verified

`verify:full` green: 60 unit + 17 coupons + 24 http + 83 security + 51 frontend + 35 integration
= **270 tests**, both browser suites, live Neon and Razorpay connectivity, nothing skipped.
34 tests were added across the four suites.

### Still outstanding — these need a human

1. **Rotate the Neon test-database password.** A live connection string was committed in
   `APPLY-THIS.md`. The file is redacted now, but the value remains in pushed git history, and
   redaction is not unpublication.
2. **Production is behind on migration 015.** `render.yaml` runs `npm run migrate` as its
   `preDeployCommand`, so the next deploy applies it. `test:db` reports this state explicitly.
3. `REQUIRE_TOKEN_VERSION=true` seven days after deploying.
4. The manual ₹1 Razorpay end-to-end test — `test:razorpay` proves the keys authenticate; it
   cannot prove the webhook lands.
5. **Note on permissions:** `staff` holds `ANALYTICS_READ`, so a staff account can *read* the six
   email settings via `GET /api/admin/settings`. Only `admin` (`SETTINGS_WRITE`) can change them.

## Round 16 — I Broke position:sticky While Fixing the Checkout Overflow

**Root cause of #31 not working, and it was my own regression.**

The Round 15 checkout fix put `overflow-x:hidden` on `<html>` and `<body>`.
That is a well-known CSS trap: **any ancestor with `overflow` other than
`visible` becomes the scroll container for `position:sticky` descendants**, so
sticky elements stop sticking to the viewport and scroll away with the page.

The #31 code (the mobile guard in `handleHeaderScroll` and the CSS override)
was present and correct the whole time. It could never work, because the
header's `position:sticky` had already been disabled by a rule added several
hundred lines earlier for an unrelated reason.

This affected **six** sticky elements, not just the header: `.site-header`,
`.shop-sidebar`, `.cart-summary`, `.bk-summary`, `.policy-nav` and
`.admin-nav`. All of them silently stopped sticking.

Fixed by switching to `overflow-x: clip`, which prevents sideways scrolling
**without** creating a scroll container, so sticky keeps working. It is only a
safety net now in any case — the actual overflow cause was removed in Round 15
with `min-width:0` on the layout containers.

**Lesson recorded here deliberately:** a CSS rule added for one page can
silently disable a layout behaviour used on every page. The checkout fix was
verified against the checkout and nowhere else, which is exactly why this got
through.

### #33 — the flight animation, properly this time

Changing the CSS transition duration was not enough: the motion was still a
straight line, which reads as mechanical however slow it is. Replaced with a
frame-by-frame **quadratic Bézier arc** driven by `requestAnimationFrame` — the
chip lifts away from the button, arcs across, and settles into the cart, the
way a thrown object moves. 1.5s with `easeInOutCubic` for a gentle departure
and arrival, shrinking to 45%, and holding full opacity for the first 75% of
the flight so it stays readable. The competing CSS transition was removed,
since it would have flattened the curve back to a straight line.

Verified by simulating the path frame by frame: it arcs above both endpoints,
lands exactly on the cart, and the easing curve is correct.

## Round 15 — Tasks 31-36, and admitting the #27 fix was wrong

### #32 — the previous checkout "fix" made things worse

The earlier attempt added `overflow-x:hidden` to `<html>` plus
`#page-checkout *{ max-width:100% }`. Both were wrong, and together they caused
the new symptom of form boxes cut off on the right:

* `overflow-x:hidden` does not remove an overflow, it **clips** it. Content that
  was previously reachable by scrolling simply disappeared.
* `max-width:100%` on every descendant is measured against a parent that was
  *already* too wide, so it trimmed children instead of fitting them.

The actual cause was never addressed: grid and flex children default to
`min-width:auto`, which means **they refuse to shrink below their content's
intrinsic width** and push the track past the container. `.checkout-layout` is
a grid, so its children forced the page wider than the phone.

`min-width:0` on the layout containers is the real fix — it permits the shrink,
so nothing overflows and nothing needs clipping. Applied to the checkout and to
the other grid/flex containers site-wide, since the same trap applies to all of
them.

### Other tasks

**#31** — the header hid on scroll-down. That reclaims space on a desktop, but
on a phone it removes menu, search and cart from reach mid-browse. Now pinned
below 900px, with the desktop behaviour untouched.

**#33** — plus button enlarged (42→52px) with a bold glyph and a gold fill that
wipes upward on hover rather than fading. Both controls dropped toward the
image edge so they read as an anchored pair. The flight was 0.6s with an
overshoot curve, which looked like a rocket; it is now 1.15s on an ease-out arc
so the eye can actually follow the count to the cart. The JS timing and the
transform centring were updated to match, otherwise the chip would have jumped
on its first frame.

**#34** — Razorpay Order ID, Payment ID and Refund ID now appear in the admin
order view for dispute evidence. More importantly, a genuine logic bug was
fixed: "money was collected" was inferred from the order *status*, so a COD
order at 'processing' was treated as paid and could not be cancelled — even
though nothing has been captured and there is nothing to refund. The gate is
now the presence of a real `razorpay_payment_id`. "Refunded" is likewise hidden
when there is no captured payment, since it could only ever error.

**#35** — Add to Cart and Buy Now are equal-weight actions and now render at
equal width via `flex:1 1 0`, so the longer label cannot claim more space. On
mobile the quantity stepper and wishlist share a row with the two actions
full-width beneath.

**#36** — the two floating buttons were different sizes (64px vs 54px). Both
are now 56px with an even 14px gap, and 50px with a 12px gap on mobile.

### Full re-audit performed

Systematic rather than spot-checked: syntax across all files; structure
unchanged (24 sections, 14 pages, 4 modals, 2 drawers); every onclick handler
resolves; no duplicate IDs or function declarations; tags balanced; **73
backend routes cross-checked against 43 frontend calls with no mismatch**; 174
SQL statements checked against the 21-table schema with no unknown column; and
the cart, discount, rate-limiter and COD-cancel logic executed against real
edge cases. 60/60 tests pass.

## Round 14c — A Third Audit Found the Worst Bug Yet

Pushed the audit further rather than re-asserting the work was fine. It found a
defect that would have cost real sales:

**A variant product could be quick-added from the shop grid with no variant
selected, and checkout would then reject the entire order.**

The guard in `quickAdjust` tested `p.variantOptions` — but that field is only
populated by the product DETAIL fetch. On the shop grid and in Quick View it is
always `undefined`, so the guard silently never fired. The item went into the
cart, the customer proceeded, and only at checkout did the server correctly
refuse with "Please choose an option" — by which point they have entered an
address and chosen a payment method. That is exactly the kind of failure that
gets abandoned rather than retried.

Fixed at the source: the public list endpoint now returns `has_variants`
(a cheap EXISTS subquery), which is mapped onto every product, so the grid
knows before the customer taps. Both the quick-add and Quick View paths now
route to the product page to choose an option, with an explanatory message
rather than a silent redirect. Quick View also gained the stock check it never
had.

Also verified during this pass, and confirmed NOT broken: the cart icon still
opens the drawer (only the automatic open on add was removed); every
`addToCart` call site remains compatible with the widened signature; `.p-media`
is `position:relative` so the new absolutely-positioned controls anchor
correctly. One genuine leftover was corrected — `.list-view .p-desc` styled an
element removed earlier when the duplicate product name was fixed, so it now
targets the material line instead.

## Round 14b — Self-Audit Caught Two More Real Bugs

Re-tested the new code from several angles rather than assuming it worked. Two
genuine defects surfaced, both of which would have shipped silently:

**1. The fly-to-cart chip launched from the page corner.** `quickAdjust` called
`addToCart` (which triggers `updateCartUI` -> `syncAllQuickAddControls`, and
that REPLACES the tapped button's DOM node) and only then read the button's
position for the animation. A detached element reports a zero rect, so every
chip would have flown from (0,0) instead of the button. Fixed by capturing the
coordinates *before* the cart update and passing a plain `{x,y}` rather than an
element — the function signature now makes the constraint explicit.

**2. Every discount tag showed the SAME animation.** The requirement was
explicitly to vary it. The old `((h<<5)-h)` hash has poor low-bit distribution:
for similar-length ids the trailing bits repeat, so `hash % 4` kept selecting
the same bucket. Verified: 8 test products all resolved to one style. Replaced
with FNV-1a plus an xorshift avalanche, which mixes high bits down into the low
ones. Now measured across 200 realistic UUIDs: 53/53/50/44 across the four
styles.

Also removed a helper left orphaned by the sync refactor, and a redundant
`position:absolute` on `.dt-sweep`.

### Render outage fix — verified from five angles

| Check | Result |
|---|---|
| 200 health probes (Render does ~180/window) | 200/200 never throttled |
| Health probe **with query string** | 10/10 — `req.path` excludes the query |
| 50 webhook posts | 50/50 — payment confirmations never dropped |
| Normal endpoint at `max=3` | 3 pass / 7 throttled — protection intact |
| Admin endpoint | still limited — the exemption is not over-broad |

The query-string case matters specifically: had the skip been written against
`req.originalUrl` instead of `req.path`, a probe with any query parameter would
have bypassed the exemption and re-triggered the outage.

## Round 14 — CRITICAL: Rate Limiter Was Taking the Server Down (+ tasks 26-30)

### The outage cause — read this first

The Render logs showed `/api/health` returning **200 then 429**, all from
`"Render/1.0"`. That is Render's own health probe being blocked by our rate
limiter.

The arithmetic: Render probes `healthCheckPath` roughly every 5 seconds =
**180 requests per 15-minute window**, against a `RATE_LIMIT_MAX` of **200**.
The platform's own monitoring consumed ~90% of the allowance before a single
customer arrived, so any real traffic pushed it over — at which point
`/api/health` returned 429, **Render saw a failing health check, marked the
service unhealthy and cycled it.** The "server keeps going down" was the rate
limiter throttling the platform's monitor, not a crash or a resource limit.

Fixed by exempting machine endpoints from rate limiting entirely (verified
against a live Express instance: 20/20 health checks pass while a normal
endpoint still throttles correctly at its limit), and raising the default
ceiling to 600. The webhook is exempt for a related but distinct reason: a
throttled Razorpay webhook means a captured payment is never recorded, and its
authenticity is already enforced by HMAC signature verification — a far
stronger control than an IP rate limit.

### Tasks 26-30

**#27 — checkout overflow (root cause found).** `overflow-x:hidden` was on
`<body>` only. On mobile that does not stop `<html>` scrolling sideways, so any
over-wide child shifted the page and left the header and footer rendering
narrower than the content — exactly what the screenshot showed. The guard is
now on both `html` and `body` with an explicit width ceiling, plus a
defensive `#page-checkout *{ max-width:100% }` so inline styles and future
markup are covered without listing each one.

**#28 — quick-add and discount tags.** The hover-revealed "Add to Cart" bar is
replaced by an always-visible quick-add control (the hover bar was effectively
unreachable on touch, which is most traffic). One tap adds; it then becomes a
−/count/+ stepper. The count is read from the cart itself rather than held as
separate UI state, so a card can never disagree with the cart — and every cart
change anywhere re-syncs the visible steppers. Stock is re-checked on each
increment using the same message format as checkout. A `+1` chip arcs into the
cart icon, which shakes; both are decorative, wrapped in try/catch and disabled
under `prefers-reduced-motion`, so they can never interfere with the cart
update that has already completed. Discount tags derive the percentage from
MRP vs price (never stored, so it cannot drift) and rotate through four
animation styles keyed off the product id, so a grid does not repeat one effect.

**#29 — Buy Now.** Adds to the cart then goes to checkout. Deliberately NOT a
separate express path: routing it through the normal cart means stock
reservation, coupon rules, variant handling and server-side price
recalculation are the identical code a normal checkout uses. A parallel
checkout path would be a second place for stock bugs to live, which is exactly
where overselling comes from.

**#30 — cart no longer auto-opens.** With quick-add on every card, opening the
drawer on each tap interrupted browsing. The icon animation acknowledges the
add instead.

**#26 — option values are now editable.** A new size or colour can be added to
an existing option inline, without deleting and rebuilding the option (which
would orphan every variant built on it). Duplicate values are caught
case-insensitively before the request, mirroring the server's UNIQUE constraint.

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
