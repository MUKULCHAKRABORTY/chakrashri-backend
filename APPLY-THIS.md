# Patch 1.1.2 — your verify run was green and still incomplete

Your 1.1.1 run passed everything it executed. Look at this line, though:

```
> chakrashri-backend@1.1.1 test:db-integration
[db-integration] No DATABASE_URL set — skipping database integration tests.
```

**Twenty-nine tests did not run, and `npm run verify` still reported success.**
Those are the ones that prove oversell is impossible when two people check out
the last unit at the same moment, that a refund returns stock exactly once, that
a partial refund does not invent returned units, and that the audit log cannot be
edited or deleted. Your green run was 209 tests, not 238.

That is the same defect I fixed in the browser test one release ago — a suite
that removes itself from the gate and nobody notices — and I did not check
whether anything else in the suite did it too. It did.

## Apply

Extract the zip anywhere, then copy the **contents** of `chakrashri-patch-1.1.2`
into `C:\Users\chakr\Downloads\chakrashri-backend\chakrashri-backend`, keeping the
folder structure and overwriting when prompted. Eleven files replaced, one new
(`scripts/verify-full.js`). Your `.env`, `node_modules` and database are untouched.

In PowerShell, from inside the extracted folder:

```powershell
Copy-Item -Path .\* -Destination C:\Users\chakr\Downloads\chakrashri-backend\chakrashri-backend -Recurse -Force
```

Then `npm install`, and read the next section before running anything.

## The one thing you need to set up

The 29 tests **create and delete rows**. They must never touch production, so
they now read `TEST_DATABASE_URL` rather than `DATABASE_URL` — a variable you
have to set on purpose. Without it they skip, loudly, and say what did not run.

A **Neon branch** is the easiest throwaway: instant, free, isolated, discardable.

```
1. In the Neon console, create a branch of your project (or a second database
   named chakrashri_test). Copy its connection string.

2. Apply the migrations to it once. `npm run migrate` reads DATABASE_URL, so
   point it there for this one command only:

   cmd:  set "DATABASE_URL=postgresql://neondb_owner:npg_yRxerNMh4i9w@ep-misty-glitter-aytpft51-pooler.c-5.us-east-2.aws.neon.tech/chakrashri_test?sslmode=verify-full&channel_binding=require" && npm run migrate

3. Add to .env:

   TEST_DATABASE_URL=postgresql://.../chakrashri_test?sslmode=verify-full

4. npm run verify:full
```

## `verify` and `verify:full` are different claims

`npm run verify` allows a skip and tells you about it. `npm run verify:full` is
new and forbids one: a missing browser binary or a missing test database becomes
a **failure**, not a notice. Its green means every suite actually ran. **Use
`verify:full` as the pre-deploy gate.** CI now enforces the same thing.

## Also fixed: the safety guard was not safe

The guard that stops these destructive tests running against production checked
the whole connection string against `/test|localhost|127\.0\.0\.1|ci/i`. Two
problems, and the second is the one that matters:

1. `ci` matched as a bare substring — inside any word. A Neon endpoint id is
   random, so a host like `ep-pre**ci**ous-sun-a1b2c3` would have authorised a
   destructive run against a production database by coincidence. So would the
   region `ap-pa**ci**fic-1`.
2. It searched the **credentials**. A generated password containing `ci` or
   `test` was enough to unlock it. A secret must never be able to grant
   permission.

The guard now decides on the **host and database name only** and requires a
whole-word marker. I tested it against twelve realistic connection strings,
including three that the old guard wrongly approved. Failure messages print host
and database name only — never the password.

While fixing that I introduced a worse bug and caught it in testing: the guard
validated `TEST_DATABASE_URL` while the connection pool, which reads
`DATABASE_URL`, would have connected to **production**. Destructive tests against
live orders, with the console reporting that a test database had been checked.
The approved URL is now assigned before anything opens a connection, and the file
asserts at startup that the pool really is on the database that was checked. I
proved that assertion fires by feeding it a mismatched pool.

## Third silent skip, in the unit suite

Three tests in `[4b] jsonb serialization` began with
`if (!prepareValue) return;` — reporting PASS while asserting nothing if
`pg/lib/utils` (an internal path) ever moved. They pin the array-vs-object trap
that has broken variant creation twice. They now fail with an explanation
instead of falling silent.

## Verified before shipping

- Every skip path in `test/` and `scripts/` audited; all three found are fixed.
- db-integration: no database → loud skip, exit 0; production-shaped URL → refuses,
  exit 0; same with `REQUIRE_DB_TESTS=true` → exit 1; throwaway database → 29 pass.
- Guard rail: 12 connection strings, including the three the old one got wrong.
- Pool-mismatch abort: proved it fires by pre-seeding a mismatched db module.
- jsonb tests: pass normally, fail loudly when `pg/lib/utils` is unavailable.
- Offline suite 60 + 17 + 24 + 73 + 35, browser test passing, 29 integration
  tests against a real PostgreSQL 16. `npm audit`: 0 vulnerabilities.
- Diffed against 1.1.0: exactly the eleven files listed, plus the new script.

## Still outstanding, and still yours

1. **Rotate the five credentials** that were in the `.env` inside the archive you
   sent: `DATABASE_URL`, `JWT_SECRET`, `RAZORPAY_KEY_SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`, SMTP password. This has been open for two releases.
2. Change `?sslmode=require` to `?sslmode=verify-full` in `.env` and on Render.
   The code corrects it at boot and logs that it did; fixing it at the source
   means there is nothing to correct.
3. Set `REQUIRE_TOKEN_VERSION=true` seven days after deploying.
4. The manual end-to-end test: one real ₹1 order through Razorpay, confirm the
   webhook lands, refund it from the admin panel, confirm the ledger, the audit
   entry and the customer email all appear. No automated suite covers that path.
