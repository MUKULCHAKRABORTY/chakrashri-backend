-- ---------------------------------------------------------------------------
-- 017 — one recovery email per abandoned booking
-- ---------------------------------------------------------------------------
-- WHY THIS COLUMN EXISTS
--
-- A booking is created before it is paid for. If the customer closes the tab at
-- the payment step the row simply sits there, unpaid and unconfirmed, and until
-- now nothing told them — the order path has had an abandoned-checkout email
-- for a while, and the booking path, which is the more expensive purchase of
-- the two, had nothing at all.
--
-- The scheduled job runs every fifteen minutes and sees the same unpaid booking
-- on every tick. Without a marker it would mail the customer four times an hour
-- for as long as the row exists, which is worse than saying nothing. The job
-- CLAIMS the row by stamping this column inside the same UPDATE that selects
-- it (FOR UPDATE SKIP LOCKED), so two workers cannot both claim it, and clears
-- the stamp again if the send fails for a retryable reason — exactly the
-- pattern orders.recovery_email_sent_at already uses.
--
-- NULLABLE with no default on purpose: NULL means "not yet emailed", which is
-- the correct state for every booking that exists today.

ALTER TABLE puja_bookings      ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS recovery_email_sent_at TIMESTAMPTZ;

-- The job's own WHERE clause, as an index. Partial on the two conditions that
-- actually narrow it: an unpaid booking that has not been mailed yet is a tiny
-- fraction of the table, and it is the only slice this query ever reads.
CREATE INDEX IF NOT EXISTS idx_puja_bookings_recovery
  ON puja_bookings (created_at)
  WHERE payment_status = 'unpaid' AND recovery_email_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_astro_bookings_recovery
  ON astrology_bookings (created_at)
  WHERE payment_status = 'unpaid' AND recovery_email_sent_at IS NULL;
