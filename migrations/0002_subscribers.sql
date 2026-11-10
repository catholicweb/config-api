-- Organizer notification subscriptions (src/registration-notify.js). The worker also
-- creates this table on first use, so applying it by hand is optional:
--   npx wrangler d1 execute parroquia-registrations --remote --file=migrations/0002_subscribers.sql
CREATE TABLE IF NOT EXISTS registration_subscribers (
  site       TEXT NOT NULL,
  email_hmac TEXT NOT NULL,   -- HMAC(email), the row key
  iv         TEXT NOT NULL,   -- AES-GCM IV (base64)
  data       TEXT NOT NULL,   -- AES-GCM ciphertext of { email }
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site, email_hmac)
);
