ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS csrf_token TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS webhook_nonces (
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider, nonce)
);

CREATE INDEX IF NOT EXISTS webhook_nonces_expiry_idx ON webhook_nonces(expires_at);
