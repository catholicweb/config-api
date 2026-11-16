-- Private credential store (replaces the public-bucket object `auth.enc`).
-- One row holding the SAME AES-GCM-256 blob format ({v, iv, ct}, encrypted under
-- AUTH_KEY) that auth.enc used, plus a version for optimistic concurrency.
-- See src/auth-store.js.
CREATE TABLE IF NOT EXISTS auth_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  blob       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
