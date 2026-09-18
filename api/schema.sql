-- GAZHP payments database (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  dedupe_key  TEXT NOT NULL UNIQUE,      -- gateway + transaction id; stops double counting
  created_at  TEXT NOT NULL,             -- when we recorded it (ISO timestamp)
  date        TEXT NOT NULL,             -- date paid (YYYY-MM-DD)
  status      TEXT NOT NULL,             -- paid | pending | failed | refunded
  type        TEXT NOT NULL,             -- donation | membership
  tier        TEXT,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL,
  method      TEXT NOT NULL,             -- Stripe, PayPal, Flutterwave, Zelle, Bank transfer…
  ref         TEXT,                      -- gateway transaction / reference code
  recurring   TEXT,                      -- once | month | year
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  country     TEXT,
  profession  TEXT,
  notes       TEXT,
  source      TEXT NOT NULL              -- stripe | paypal | flutterwave | notify | manual | import
);
CREATE INDEX IF NOT EXISTS payments_date  ON payments(date);
CREATE INDEX IF NOT EXISTS payments_email ON payments(email);
CREATE INDEX IF NOT EXISTS payments_ref   ON payments(source, ref);

-- What the donor asked for before being sent to the gateway.
CREATE TABLE IF NOT EXISTS checkouts (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  gateway     TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  tier        TEXT,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL,
  recurring   TEXT NOT NULL,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  country     TEXT,
  profession  TEXT,
  gateway_ref TEXT
);
