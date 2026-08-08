-- Chakrashri schema, migration 004
-- Booking services catalog: puja and astrology offerings previously existed
-- ONLY as hardcoded arrays in the frontend JavaScript (PUJA_SERVICES,
-- ASTRO_SERVICES), with no backend representation and no payment integration
-- at all — confirmBooking() functions just showed a fake success message
-- with a randomly generated ID and never called the API. This table makes
-- pricing a real, server-side source of truth (the client can never be
-- trusted to say how much a booking costs) and lets it be managed through
-- the admin dashboard instead of being a code change.

CREATE TABLE IF NOT EXISTS booking_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type VARCHAR(20) NOT NULL, -- 'puja' | 'astrology'
  name VARCHAR(150) NOT NULL,
  description TEXT,
  price_paise BIGINT NOT NULL,
  duration_label VARCHAR(60),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_services_type ON booking_services(service_type);

-- Postgres has no "ADD CONSTRAINT IF NOT EXISTS" (unlike ADD COLUMN, which
-- does support IF NOT EXISTS since PG 9.6 and is used plainly below) — this
-- DO block is the standard idiom to make an ADD CONSTRAINT safe to re-run.
DO $$ BEGIN
  ALTER TABLE booking_services ADD CONSTRAINT chk_booking_services_type
    CHECK (service_type IN ('puja','astrology'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE booking_services ADD CONSTRAINT chk_booking_services_price_positive
    CHECK (price_paise > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Link bookings to a real priced service, and give both booking tables the
-- same payment-tracking columns `orders` already has — without these, there
-- was no way to even record that a booking had a Razorpay transaction
-- attached to it, let alone verify one.
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES booking_services(id);
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(80);
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(80);
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS razorpay_signature TEXT;
ALTER TABLE puja_bookings ADD COLUMN IF NOT EXISTS preferred_mode VARCHAR(20);

ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES booking_services(id);
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(80);
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS razorpay_payment_id VARCHAR(80);
ALTER TABLE astrology_bookings ADD COLUMN IF NOT EXISTS razorpay_signature TEXT;

CREATE INDEX IF NOT EXISTS idx_puja_bookings_rzp_order ON puja_bookings(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_astrology_bookings_rzp_order ON astrology_bookings(razorpay_order_id);

-- Featured image for blog posts — the admin dashboard's new blog editor needs
-- somewhere to store this; previously blog posts existed only as a hardcoded
-- local array in the frontend with no backend table use at all.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS featured_image_url TEXT;

-- Seed the real catalog with the same puja/astrology services and prices that
-- were previously only hardcoded in the frontend, so the store isn't left
-- with an empty booking catalog after this migration. Guarded so re-running
-- the migration script doesn't duplicate rows.
INSERT INTO booking_services (service_type, name, description, price_paise, duration_label, sort_order)
SELECT * FROM (VALUES
  ('puja', 'Satyanarayan Puja', 'A home puja invoking Lord Vishnu, usually performed to mark a happy occasion or fulfil a vow.', 210000, '~2 hrs', 1),
  ('puja', 'Griha Pravesh Puja', 'The traditional house-warming ceremony performed before or on moving into a new home.', 510000, '~3 hrs', 2),
  ('puja', 'Rudrabhishek Puja', 'Ritual bathing of the Shiva lingam with milk, honey and water, accompanied by Rudra mantra chanting.', 310000, '~2.5 hrs', 3),
  ('puja', 'Navgraha Shanti Puja', 'A puja to pacify the nine planetary deities, often recommended after a difficult dasha period.', 410000, '~3 hrs', 4),
  ('puja', 'Ganesh Puja (Any Occasion)', 'A short puja to Lord Ganesha, ideal before starting a new venture or occasion.', 150000, '~1.5 hrs', 5),
  ('puja', 'Online Puja Sankalp', 'A priest performs your sankalp on your behalf at a temple, while you join live on video.', 110000, '~1 hr', 6),
  ('puja', 'Vastu Shanti Puja', 'A remedial puja to correct vastu doshas identified in a home or office.', 610000, '~3.5 hrs', 7),
  ('puja', 'Mrityunjaya Jaap (11,000 Mantras)', 'An extended Maha Mrityunjaya mantra recitation, traditionally requested for health and protection.', 910000, 'Full day', 8),
  ('astrology', 'Detailed Kundli Report', 'A full birth chart with planetary positions, dasha timeline and a written analysis.', 79900, 'Delivered in 24 hrs', 1),
  ('astrology', 'Kundli Milan (Marriage Matching)', '36-guna compatibility scoring between two birth charts for marriage proposals.', 99900, 'Delivered in 24 hrs', 2),
  ('astrology', 'Live Call With Astrologer', 'A one-on-one voice consultation with a practising Vedic astrologer.', 149900, '30 minutes', 3),
  ('astrology', 'Gemstone Recommendation', 'A personalised gemstone and metal recommendation based on your chart.', 69900, 'Delivered in 24 hrs', 4),
  ('astrology', 'Career & Life Path Reading', 'A focused reading on career timing, favourable periods, and life-path themes.', 119900, 'Delivered in 48 hrs', 5),
  ('astrology', 'Vastu Consultation (Home/Office)', 'A guided vastu review of your home or office layout with practical remedies.', 199900, '45-minute call', 6)
) AS seed(service_type, name, description, price_paise, duration_label, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM booking_services);
