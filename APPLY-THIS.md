# Patch 1.1.1 — what broke, what changed, how to apply

`npm run verify` on your machine stopped at `test:browser` with
`Executable doesn't exist … chrome-headless-shell.exe`. Nothing in the
application was wrong: 258 tests passed, and the browser test could not *start*
because Playwright's Chromium binary is a separate download that `npm install`
does not perform.

But the crash was a defect in the test harness, and it mattered more than the
missing download: `test:db-integration`, `test:db` and `test:razorpay` never ran,
so that green-looking run had actually verified far less than it appeared to.

## Apply

Extract this over your project folder, keeping the directory structure. It
replaces nine files and touches nothing else.

```
npm install                # picks up the version bump
npm run setup:browser      # one-time per machine: downloads Chromium
npm run verify
```

`npm run setup:browser` is new — it is just `npx playwright install chromium`.

## What changed, and why

**1. `test/browser-cards.test.js` — the crash.**
The old guard handled "playwright package not installed" but not "package
installed, browser binary missing", and the launch failure happened inside an
async function with no catch. Node turns that into an unhandled rejection and
kills the process, which killed the whole `npm run verify` chain.

Now it detects both, prints the exact command, exits 0, and lets the rest of the
suite run. A launch failure for any *other* reason is still re-thrown as a real
failure — a check that cannot fail is worse than no check.

Set `REQUIRE_BROWSER_TESTS=true` to turn the skip back into a failure. CI now
does exactly that, so a silently broken browser install cannot hide there.

**2. `src/config/db.js` — a scheduled TLS downgrade (TLS-01).**
Your migration run printed this, and it is not cosmetic:

> The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for
> 'verify-full'. In the next major version … weaker security guarantees.

`sslmode=require` means "encrypted and certificate-verified" today. After a
routine `npm update` to pg v9 it will mean "encrypted, but any certificate is
accepted" — a man-in-the-middle window between Render and Neon that opens with
no code change, no error and no failing test.

`require` and `verify-ca` are now rewritten to `verify-full` at boot, which is
exactly what they already do today, so nothing changes now and nothing breaks
later. One log line reports it. `sslmode=prefer` is warned about but never
rewritten (it permits a plaintext fallback that local development relies on),
and `localhost` connections are left alone (a dev Postgres often has a
self-signed certificate that `verify-full` is right to reject).
`DB_SSL_NORMALIZE=false` disables the rewrite.

**Please also set it at the source:** change `?sslmode=require` to
`?sslmode=verify-full` in `.env` and in the Render dashboard, so the code has
nothing to correct.

The same file's comment used to say `DB_SSL` controlled certificate validation.
It does not — a parsed `sslmode` overrides that property entirely — and a
misleading comment on a security control is worse than none. The comment is
fixed; the `ssl:` line itself is unchanged, byte for byte.

**3. `scripts/test-db-connection.js` — a consumer of the value above.**
It string-matched `sslmode=require`, so the moment you set `verify-full` it
would have reported a false failure and advised you to undo the stronger
setting. It now accepts every mode that mandates TLS.

**4. `test/http.test.js` — two red error lines on a green run.**
Two queries were unstubbed; the routes correctly fail-softed and both tests
passed, but every run printed `"level":"error"` with a stack trace. A suite that
prints errors on success teaches people to scroll past errors. Both are now
stubbed, which turns the noise into real coverage: a webhook naming an unknown
order must return 200, not 500, because Razorpay retries anything else.

**5. `test/security.test.js` — 11 new tests** covering the TLS change, including
the regression it must not cause (a local test database must never be forced
into `verify-full`).

## Verified before shipping

- Reproduced your exact error by pointing `PLAYWRIGHT_BROWSERS_PATH` at an empty
  directory; confirmed the skip, confirmed `REQUIRE_BROWSER_TESTS=true` fails,
  confirmed the real test still runs and passes.
- Confirmed five realistic non-binary launch errors are still re-thrown, not
  swallowed.
- Full offline suite: 60 + 17 + 24 + 73 + 35 tests, 0 failed, plus the browser
  test passing.
- Migrations applied twice against a fresh PostgreSQL 16, then 29 integration
  tests against it, 0 failed.
- Diffed against the previous release: exactly these nine files changed.
- `npm audit`: 0 vulnerabilities.

## Still outstanding, and still yours

1. **Rotate the five credentials** that were in the `.env` inside the archive
   you sent: `DATABASE_URL`, `JWT_SECRET`, `RAZORPAY_KEY_SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`, and the SMTP password.
2. Set `REQUIRE_TOKEN_VERSION=true` seven days after deploying.
3. Change `sslmode=require` to `sslmode=verify-full` in `.env` and on Render.
