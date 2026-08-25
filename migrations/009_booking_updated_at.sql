-- Chakrashri schema, migration 009
-- Fixes a real bug: the Razorpay webhook handler writes `updated_at = now()`
-- on puja_bookings / astrology_bookings, but neither table ever had that
-- column — so every booking-payment webhook failed with Postgres error 42703
-- ("column does not exist"). The browser-side /verify-payment path worked
-- (it doesn't touch updated_at), which is why payments still completed for
-- customers who stayed on the page — but the server-to-server webhook, which
-- exists precisely to catch the cases where the customer closes their
-- browser mid-payment, was silently failing every time.

ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Refund tracking for bookings, mirroring what `orders` already has, so a
-- refunded booking records the real Razorpay refund id rather than just
-- flipping a status with no money actually moving.
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS refund_id VARCHAR(80);
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS refunded_amount_paise BIGINT;
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS refund_id VARCHAR(80);
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS refunded_amount_paise BIGINT;

-- Shipping addresses: the admin order view showed raw values with no labels
-- and had no email. Email is captured per-address so an order can be sent to
-- a different recipient than the account holder (gifts, office deliveries).
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS email VARCHAR(180);
