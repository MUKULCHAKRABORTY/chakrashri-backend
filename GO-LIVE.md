# Go-live readiness

`npm run verify:full` proves the code is correct. It proves nothing about
whether this system survives contact with production. These are the five things
it cannot answer, what is already true, and exactly what to run.

Nothing here is theoretical. Every command is copy-pasteable and every claim
says whether it was verified or is still open.

---

## 1. Production configuration and secrets

**Status: automated, one advisory open.**

```bash
npm run check:config
```

Reviews configuration without printing a single secret value. Every value is
reduced to a length, a character-class count and an entropy estimate before
anything reaches the terminal, so the output is safe to paste into a ticket.

It checks three things:

- **Coverage.** Every variable the code reads without a fallback is mandatory.
  If `render.yaml` does not declare it, the service boots misconfigured and the
  symptom appears weeks later on whichever path reads it first.
- **Strength.** Entropy, not character count — a 15-character secret using all
  four character classes is stronger than a 32-character lowercase one, and a
  rule written in characters says the opposite.
- **Staleness.** A test-mode payment key, a `localhost` URL, or a placeholder
  left over from `.env.example` authenticates happily and takes no real money.

**Current local result:** 0 blocking, 1 advisory. Every mandatory variable is
declared in `render.yaml`, `.env` is gitignored, and every secret clears its
entropy floor comfortably. Eighteen optional variables are undocumented in
`.env.example`, which costs nothing today and costs an afternoon on the day
somebody rebuilds the environment from scratch.

**BEFORE GO-LIVE — this is the step that matters.** The command above reads your
LOCAL `.env`. Production values live in the Render dashboard and have never been
reviewed by anything. Copy them into a scratch env file on a machine you trust,
run the strict pass, then delete the file:

```bash
npm run check:config -- --production
```

Strict mode additionally fails on a test-mode Razorpay key, a `localhost` URL,
and an unencrypted database fallback.

**Known open item:** `RAZORPAY_KEY_ID` is currently `rzp_test_`. Going live means
swapping to the live key **and** regenerating `RAZORPAY_WEBHOOK_SECRET` in the
Razorpay dashboard, because test and live webhooks are signed with different
secrets. A live key with a test webhook secret rejects every real webhook, and
the failure is silent from the customer's side.

---

## 2. Load testing

**Status: not run, and running it today would measure the wrong thing.**

Be clear about what the current hosting is. Render's free tier gives one small
shared-CPU instance that **sleeps after 15 minutes of inactivity** and takes 30
to 60 seconds to wake. The entire cold-start architecture in this codebase — the
catalogue snapshot, the waiting screen, the intent queue — exists to make that
survivable, not to make it fast.

A production-like load test against that instance would report what is already
known: one instance, limited CPU, and a queue behind it. It would also risk
tripping Render's abuse detection on your own account.

**So the honest sequence is: upgrade first, then measure.**

When you move to a paid instance, run this. It needs `autocannon`, which is not
a dependency of this project and should be installed globally rather than added
to it:

```bash
npm install -g autocannon
```

Read-heavy path, which is what real traffic mostly is:

```bash
autocannon -c 50 -d 60 -m GET https://chakrashri-api.onrender.com/api/products?limit=24
```

The catalogue endpoint under sustained concurrency:

```bash
autocannon -c 100 -d 120 -m GET https://chakrashri-api.onrender.com/api/products/meta/top-categories
```

What to look for, in order of importance:

| signal | meaning |
|---|---|
| any non-2xx | the interesting number; a 500 under load is a real defect |
| p99 latency | the experience of your slowest customers, not the average |
| latency growth over the run | connection-pool exhaustion, which `DB_POOL_MAX` governs |

**Do not load-test checkout or payments.** Every order creates real rows, and
against a live Razorpay key it creates real payment intents. Checkout
concurrency is already covered where it counts: `[db-2]` runs ten simultaneous
checkouts against five units of stock and proves exactly five sell.

---

## 3. Backup and restore drill

**Status: not drilled. This is the highest-risk open item.**

An untested backup is not a backup. Neon provides point-in-time restore, but
nobody here has ever performed one, so the recovery time is unknown and the
procedure is unrehearsed.

Drill it on a branch. This never touches production data:

1. In the Neon console, note the current time and the retention window your plan
   actually provides. Write both down — the window is the real limit on how long
   you can take to notice a problem.
2. Create a branch from a timestamp about an hour ago. Neon branches are
   copy-on-write, so this is fast and cheap.
3. Point a scratch environment at the branch and confirm the schema is intact:

```bash
TEST_DATABASE_URL="<the branch connection string>" npm run test:db
```

4. Confirm the data is really there, not just the tables:

```bash
TEST_DATABASE_URL="<the branch connection string>" npm run test:db-integration
```

5. Write down how long steps 2 to 4 took. That number is your realistic recovery
   time, and it is the only honest input to any promise you make a customer.
6. Delete the branch.

Do this once before go-live and once a quarter afterwards. A restore procedure
nobody has run in a year is a procedure nobody can run.

---

## 4. Monitoring and alerting

**Status: business events alert a human. Infrastructure failures largely do not.**

What already works, verified in the code:

| event | reaches a human |
|---|---|
| new paid order | yes, admin email |
| payment needing review | yes, admin email |
| low stock, including per-variant | yes, in the daily digest |
| daily trading summary | yes |
| a scheduled email that failed to send | recorded in `email_log`, retryable, **no alert** |
| the API being down | only if a GitHub Action fails and you read the notification |
| an unhandled 500 in production | **nothing** |

The gap is real. Structured JSON logs go to stdout, Render's free tier retains
them briefly, and nobody is watching. `scripts/reconcile-payments.js` is the
safety net for "customer paid, we never recorded it" and it is declared in
`render.yaml`, but the cron services in that file **do not exist on the free
plan** — the external scheduler calls the HTTP trigger instead.

**Verify the scheduler is actually firing, right now:**

```bash
npm run jobs:status
```

This exits non-zero if no run has ever happened. If it does, the reconciler and
every scheduled email have been silently dead, and that is the single most
expensive failure mode in this system.

**Verified on 4 September 2026:** the scheduler is firing. The last run
completed in 5.5 seconds with all three jobs green, including
`payment-reconcile`. Re-run this check after any change to the external
scheduler, and after any Render redeploy that could rotate the trigger token.

**Before go-live, add one external uptime monitor.** UptimeRobot's free tier is
enough. Point it at `/api/health` on a 5-minute interval with email alerting.
That is the difference between learning about an outage from a monitor and
learning about it from a customer.

**Verify alerting end to end** rather than assuming the address is right:

```bash
npm run email:log -- --failed
```

Then place one real test order and confirm the admin email actually arrives at
the address in `admin_alert_email`. An alert address nobody has ever received
mail at is not an alert address.

---

## 5. External penetration test

**Status: not done, and it should not be self-assessed.**

What has been verified in-house, and is genuinely covered:

- Role separation, with all 28 mutating endpoints proved to require a capability
  that names a write (`[fe-52]`)
- Payment verification that refuses an authorised-but-uncaptured payment, a
  short capture, a wrong currency, and a payment belonging to another order
- Webhook HMAC over the raw body, with a timing-safe comparison
- SQL injection surface: every query is parameterised, and the one interpolated
  value is a frozen constant no request can influence
- Output escaping in both front ends and in every email template
- Rate limiting per route, secrets redacted from logs, TLS enforced to the
  database, and a Content Security Policy on the static site

What in-house testing structurally cannot provide: an adversary who does not
share the author's assumptions. Every check above was written by the same person
who wrote the code, and tests what they thought to test.

**Scope to hand a tester:**

- The storefront origin and the API origin
- The admin console, with a throwaway admin account created for the engagement
- Explicitly in scope: authentication and session handling, the capability
  model, the payment and webhook path, IDOR on order and booking identifiers,
  and the free-plan job trigger
- Explicitly out of scope: Razorpay's own infrastructure, Neon, Render, Netlify

Book it against a staging deployment with a test-mode Razorpay key, never
against live payments.

---

## The honest summary

| item | state |
|---|---|
| production config and secrets | automated, re-runnable, one advisory |
| load testing | blocked on upgrading from the free tier; scripts ready |
| backup and restore | **never drilled — highest open risk** |
| monitoring | business alerts work; no uptime monitor, no error alerting |
| penetration test | not done; scope prepared |

Two things should happen before real money moves through this system: drill the
restore, and add one external uptime monitor. Both take under an hour. Everything
else on this page can follow the first customer.
