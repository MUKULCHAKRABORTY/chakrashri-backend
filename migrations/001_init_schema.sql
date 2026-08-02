-- Chakrashri production schema
-- Run via: psql $DATABASE_URL -f migrations/001_init_schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ============ USERS ============
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) UNIQUE NOT NULL,
  phone VARCHAR(20) UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'customer', -- customer | admin | staff
  email_verified BOOLEAN NOT NULL DEFAULT false,
  phone_verified BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============ ADDRESSES ============
CREATE TABLE IF NOT EXISTS addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  line1 VARCHAR(200) NOT NULL,
  line2 VARCHAR(200),
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100) NOT NULL,
  pincode VARCHAR(10) NOT NULL,
  country VARCHAR(60) NOT NULL DEFAULT 'India',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ PRODUCTS ============
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(60) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(220) UNIQUE NOT NULL,
  category VARCHAR(80) NOT NULL,
  price_paise BIGINT NOT NULL,          -- store money as integer paise, never float
  mrp_paise BIGINT NOT NULL,
  material VARCHAR(120),
  short_desc TEXT,
  long_desc TEXT,
  badge VARCHAR(40),
  rating NUMERIC(2,1) DEFAULT 4.5,
  review_count INT DEFAULT 0,
  stock_qty INT NOT NULL DEFAULT 0,
  hsn_code VARCHAR(10),                  -- required for GST invoicing
  gst_rate NUMERIC(4,2) DEFAULT 3.00,    -- e.g. 3% on most jewellery/idols; verify per category
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);

CREATE TABLE IF NOT EXISTS product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  sort_order INT DEFAULT 0
);

-- ============ ORDERS ============
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(30) UNIQUE NOT NULL, -- human-readable e.g. CHK-2026-000123
  user_id UUID REFERENCES users(id),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
    -- pending | paid | processing | shipped | delivered | cancelled | refunded | payment_failed
  subtotal_paise BIGINT NOT NULL,
  shipping_paise BIGINT NOT NULL DEFAULT 0,
  gst_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL,
  shipping_address_id UUID REFERENCES addresses(id),
  payment_method VARCHAR(20) NOT NULL,   -- razorpay | cod
  razorpay_order_id VARCHAR(80),
  razorpay_payment_id VARCHAR(80),
  razorpay_signature TEXT,
  courier_name VARCHAR(80),
  tracking_number VARCHAR(80),
  invoice_number VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_razorpay_order ON orders(razorpay_order_id);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  product_name_snapshot VARCHAR(200) NOT NULL, -- freeze name/price at purchase time
  unit_price_paise BIGINT NOT NULL,
  quantity INT NOT NULL,
  line_total_paise BIGINT NOT NULL
);

-- ============ PUJA BOOKINGS ============
CREATE TABLE IF NOT EXISTS puja_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  puja_type VARCHAR(120) NOT NULL,
  preferred_date DATE NOT NULL,
  preferred_time_slot VARCHAR(40) NOT NULL,
  pandit_id UUID,                        -- FK to a future `practitioners` table
  status VARCHAR(30) NOT NULL DEFAULT 'requested', -- requested | confirmed | completed | cancelled
  contact_name VARCHAR(120) NOT NULL,
  contact_phone VARCHAR(20) NOT NULL,
  notes TEXT,
  amount_paise BIGINT,
  payment_status VARCHAR(20) DEFAULT 'unpaid',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ ASTROLOGY CONSULTATIONS ============
CREATE TABLE IF NOT EXISTS astrology_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  astrologer_id UUID,                    -- FK to a future `practitioners` table
  consultation_mode VARCHAR(20) NOT NULL, -- call | video | chat
  preferred_date DATE NOT NULL,
  preferred_time_slot VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'requested',
  contact_name VARCHAR(120) NOT NULL,
  contact_phone VARCHAR(20) NOT NULL,
  birth_details JSONB,                    -- DOB, time, place — sensitive, see notes in README
  amount_paise BIGINT,
  payment_status VARCHAR(20) DEFAULT 'unpaid',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ BLOG ============
CREATE TABLE IF NOT EXISTS blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(220) NOT NULL,
  slug VARCHAR(240) UNIQUE NOT NULL,
  category VARCHAR(80),
  author VARCHAR(120),
  excerpt TEXT,
  content TEXT NOT NULL,
  published_at DATE NOT NULL DEFAULT CURRENT_DATE,
  is_published BOOLEAN NOT NULL DEFAULT true
);

-- ============ WISHLIST ============
CREATE TABLE IF NOT EXISTS wishlist_items (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- ============ AUDIT LOG (admin actions — required once real write-access exists) ============
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
