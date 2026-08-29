-- Chakrashri schema, migration 015
--
-- Everything the email system needs, plus the three capture surfaces the
-- storefront was pretending to have.
--
-- CONTEXT: index.html shipped three forms that showed a cheerful confirmation
-- toast and then threw the input away — "We'll email you when this is back in
-- stock", "Thanks for subscribing!", "Message sent — we'll get back to you
-- within a day." None of them had an endpoint, a table, or an email behind
-- them. A promise the software cannot keep is worse than no feature: the
-- customer stops waiting for a restock that will never be announced, and a
-- support request quietly evaporates.
--
-- Every statement is additive and re-runnable. All new tables, so this can be
-- applied before the code that uses it.

-- ===========================================================================
-- (A) EMAIL LOG — did that email actually go out?
-- ===========================================================================
-- Two jobs, and the second is the important one.
--
--   1. Support. "I never got my order confirmation" is currently unanswerable.
--   2. IDEMPOTENCY. Three independent paths can confirm a payment (browser
--      verify, webhook, reconciler). Without a dedupe key, an order confirmed
--      by the browser AND then by a webhook retry sends the customer two
--      confirmation emails. dedupe_key makes the second send a no-op at the
--      database level rather than relying on every caller remembering.
--
-- PERSONAL DATA: this table stores recipient addresses. That is deliberate —
-- an email log without the recipient cannot answer the question it exists for,
-- and for newsletter and contact senders it is the only record we hold. It is
-- included in the customer data export (DPDP Act 2023, s.11) and must be
-- deleted alongside the account it belongs to.
CREATE TABLE IF NOT EXISTS email_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template VARCHAR(60) NOT NULL,
  recipient VARCHAR(180) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject VARCHAR(240) NOT NULL,
  -- 'sent' | 'failed' | 'skipped_no_consent' | 'skipped_not_configured' | 'suppressed'
  status VARCHAR(30) NOT NULL,
  error TEXT,
  -- One row per real-world event, e.g. 'order_shipped:<order_id>'. NULL means
  -- "this event may legitimately repeat" (a password reset, a resent
  -- verification), so those are never blocked.
  dedupe_key VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index, not a column constraint: NULL dedupe_keys must be
-- allowed to repeat freely, and a plain UNIQUE would permit unlimited NULLs but
-- read as if it did not.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_log_dedupe
  ON email_log (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log (lower(recipient), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_failed ON email_log (created_at DESC) WHERE status = 'failed';

-- ===========================================================================
-- (B) EMAIL SUBSCRIPTIONS — consent, and the ability to withdraw it
-- ===========================================================================
-- Keyed on the ADDRESS, not on a user id, because someone can subscribe to the
-- newsletter without ever creating an account — and if they later register with
-- the same address, their earlier choice must still be honoured.
--
-- Double opt-in ('pending' until the confirmation link is clicked) is the
-- compliant pattern and also the practical one: it stops a stranger signing
-- someone else's address up, and it keeps the list clean enough that mailbox
-- providers keep delivering to the inbox.
--
-- DPDP Act 2023 requires that withdrawing consent be as easy as giving it, so
-- unsubscribe_token is a permanent one-click credential — no login, no form.
CREATE TABLE IF NOT EXISTS email_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(180) NOT NULL,
  -- 'pending' | 'confirmed' | 'unsubscribed'
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- Only a SHA-256 hash is stored, exactly as password_reset_tokens and
  -- email_verification_tokens do: a leak of this table must not let anyone
  -- confirm a subscription on someone else's behalf.
  confirm_token_hash TEXT,
  confirm_expires_at TIMESTAMPTZ,
  -- NOT hashed, on purpose. This one has to survive in a link inside an email
  -- the recipient keeps for years, and it grants exactly one power: removing
  -- yourself from a list. Making unsubscribing hard to protect a mailing list
  -- is the wrong trade in both law and taste.
  unsubscribe_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  source VARCHAR(40),            -- 'footer_form' | 'checkout' | 'import' | ...
  consent_text TEXT,             -- exactly what they agreed to, frozen at the moment they agreed
  consent_ip VARCHAR(45),        -- evidence of consent; not used for anything else
  confirmed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness. Without lower(), Ravi@x.com and ravi@x.com are
-- two subscriptions, and unsubscribing one leaves the other sending.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_subscriptions_email
  ON email_subscriptions (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_subscriptions_unsub
  ON email_subscriptions (unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_email_subscriptions_confirmed
  ON email_subscriptions (status) WHERE status = 'confirmed';

-- ===========================================================================
-- (C) SUPPRESSION LIST — the list that outranks every other list
-- ===========================================================================
-- A hard bounce, a spam complaint, or an explicit "never contact me again"
-- lands here, and NOTHING sends to an address on it, transactional included
-- where the reason is a hard bounce (the address does not exist; continuing to
-- send to it damages the sending domain's reputation for everyone else).
--
-- Kept separate from email_subscriptions because it is a different decision:
-- unsubscribing is a preference, suppression is a fact about the mailbox.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email VARCHAR(180) PRIMARY KEY,
  -- 'hard_bounce' | 'complaint' | 'manual'
  reason VARCHAR(30) NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- (D) BACK-IN-STOCK NOTIFICATIONS
-- ===========================================================================
-- The storefront's "notify me" button promised this and did nothing.
--
-- variant_id is nullable and part of the uniqueness key: a customer waiting for
-- the 6-inch brass diya must not be told the 4-inch one is back. Variants have
-- independent stock, so they need independent waitlists.
CREATE TABLE IF NOT EXISTS stock_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  email VARCHAR(180) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Set when the restock email goes out. A row is never deleted on send, so the
  -- same person is not re-notified on the next restock without asking again.
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- COALESCE, because NULL != NULL in a unique index: without it, one person
-- could join the base-product waitlist an unlimited number of times.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_notifications_pending
  ON stock_notifications (product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email))
  WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_stock_notifications_pending
  ON stock_notifications (product_id) WHERE notified_at IS NULL;

-- ===========================================================================
-- (E) CONTACT MESSAGES
-- ===========================================================================
-- Stored rather than emailed, by decision: an email that bounces is a customer
-- who never hears back and no record that they wrote. The admin console reads
-- this table; the daily digest counts what is still unread.
CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL,
  phone VARCHAR(20),
  subject VARCHAR(200),
  message TEXT NOT NULL,
  -- 'new' | 'read' | 'replied' | 'archived'
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  admin_notes TEXT,
  -- Rate limiting is per-IP at the route; this is here so a flood can be traced
  -- and cleaned up after the fact.
  submitted_ip VARCHAR(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_new
  ON contact_messages (created_at DESC) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS idx_contact_messages_listing
  ON contact_messages (status, created_at DESC);

-- ===========================================================================
-- (F) ABANDONED-CHECKOUT RECOVERY BOOKKEEPING
-- ===========================================================================
-- One column, not a table. The recovery email must be sent at most once per
-- order, and the expiry sweep that cancels abandoned orders runs every ten
-- minutes — so without a marker, an order sitting pending for 25 minutes would
-- be mailed about on every one of those runs.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;

-- ===========================================================================
-- (G) DEFAULT SETTINGS
-- ===========================================================================
-- Everything that decides WHEN mail is sent is a setting rather than a
-- redeploy. The defaults reproduce sensible behaviour, and each row explains
-- itself so the admin console's settings screen is self-documenting.
INSERT INTO site_settings (key, value) VALUES
  ('admin_alert_email', ''),
  ('email_admin_alerts_enabled', 'true'),
  ('email_marketing_enabled', 'true'),
  ('abandoned_cart_email_after_minutes', '20'),
  ('booking_reminder_hours_before', '24'),
  ('low_stock_alert_threshold', '5')
ON CONFLICT (key) DO NOTHING;

-- ===========================================================================
-- NOTE ON WHAT IS DELIBERATELY ABSENT
-- ===========================================================================
-- No open/click tracking pixel. It is the obvious next feature and it is a
-- surveillance surface that has to be disclosed under DPDP, degrades
-- deliverability with privacy-forward mailbox providers, and answers a question
-- ("did they read it?") this business does not currently need. Delivery success
-- is recorded in email_log; that is the part that matters operationally.
