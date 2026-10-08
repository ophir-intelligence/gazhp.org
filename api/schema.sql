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
  method      TEXT NOT NULL,             -- Stripe, PayPal, DPO Pay, Zelle, Bank transfer…
  ref         TEXT,                      -- gateway transaction / reference code
  recurring   TEXT,                      -- once | month | year
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  country     TEXT,
  profession  TEXT,
  notes       TEXT,
  source      TEXT NOT NULL,             -- stripe | paypal | dpo | notify | manual | import
  designation TEXT,                      -- donations: programme id from DESIGNATIONS in src/config.js ('' = not recorded)
  receipt_sent_at TEXT                   -- when the donor's receipt email went out (NULL = not sent)
);
CREATE INDEX IF NOT EXISTS payments_date  ON payments(date);
CREATE INDEX IF NOT EXISTS payments_email ON payments(email);
CREATE INDEX IF NOT EXISTS payments_ref   ON payments(source, ref);
-- Imports/restores skip a reference that is already recorded from any source.
CREATE INDEX IF NOT EXISTS payments_ref_nocase ON payments(ref COLLATE NOCASE);

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
  gateway_ref TEXT,
  checked_at  TEXT,                      -- last time the cron sweep / return page asked the gateway
  settled_at  TEXT,                      -- outcome is final (paid, expired, cancelled…): stop re-checking
  designation TEXT,                      -- donations: programme id (see payments.designation)
  operator    TEXT                       -- phone-prompt mobile money (POST /momo/start): mtn | airtel | zamtel; '' otherwise
);
CREATE INDEX IF NOT EXISTS checkouts_ref     ON checkouts(gateway, gateway_ref);
CREATE INDEX IF NOT EXISTS checkouts_created ON checkouts(gateway, created_at);

-- Contact-form messages (POST /contact), read in the dashboard.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,             -- ISO timestamp
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,             -- up to 5,000 characters
  profession  TEXT,
  status      TEXT NOT NULL DEFAULT 'new' -- new | read | archived
);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);

-- Abuse protection: per-IP request counters for the public routes
-- (/checkout, /notify, /contact, /momo/start, /momo/status, /manage-giving,
-- /admin/login — limits in RATE_LIMITS in src/index.js), plus a few per-phone /
-- per-email counters. Fixed time windows: key = name | keyed hash | window
-- start. Raw IP addresses, phone numbers and emails are never stored, and the
-- 15-minute cron job deletes each row once its window has ended. Works on the free plan.
CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,
  hits        INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL           -- end of the window (Unix time in ms)
);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at);

-- UPGRADING a database created before checkouts had checked_at / settled_at?
-- Running this file again adds the new tables and indexes (it is safe to
-- re-run), but SQLite can't add columns with "IF NOT EXISTS", so run once:
--   npx wrangler d1 execute gazhp-payments --remote --command "ALTER TABLE checkouts ADD COLUMN checked_at TEXT; ALTER TABLE checkouts ADD COLUMN settled_at TEXT;"
-- UPGRADING a database created before gift designations, receipts and phone-prompt
-- mobile money (October 2026)? Run once, BEFORE deploying the new Worker code
-- (the new code writes these columns, so payments fail until they exist):
--   npx wrangler d1 execute gazhp-payments --remote --command "ALTER TABLE payments ADD COLUMN designation TEXT; ALTER TABLE payments ADD COLUMN receipt_sent_at TEXT; ALTER TABLE checkouts ADD COLUMN designation TEXT; ALTER TABLE checkouts ADD COLUMN operator TEXT;"
-- Payments recorded before the upgrade keep receipt_sent_at empty; no receipt is
-- sent for them unless an admin confirms a pending one or presses "resend".
-- (A brand-new database needs only `npm run db:init`.)
