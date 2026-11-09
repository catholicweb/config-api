-- Event registrations (src/registration.js). Applied to the D1 database
-- `parroquia-registrations` (binding REGDB):
--   npx wrangler d1 execute parroquia-registrations --remote --file=migrations/0001_registrations.sql
CREATE TABLE IF NOT EXISTS registrations (
  id          TEXT PRIMARY KEY,
  site        TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  event_label TEXT,
  people      INTEGER NOT NULL,
  email_hmac  TEXT NOT NULL,   -- HMAC(email): rate limiting only
  secret_hash TEXT NOT NULL,   -- SHA-256 of the edit secret
  iv          TEXT NOT NULL,   -- AES-GCM IV (base64)
  data        TEXT NOT NULL,   -- AES-GCM ciphertext of { name, phone, email, notes, lang }
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_site_event ON registrations(site, event_key);
CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(email_hmac, created_at);
