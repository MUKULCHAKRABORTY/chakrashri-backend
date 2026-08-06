-- Chakrashri schema, migration 003
-- Password reset tokens. Only a SHA-256 hash of the token is stored, never
-- the raw token itself — same principle as password_hash: if this table
-- were ever exposed (a DB leak, a misconfigured backup, etc.), the hashes
-- alone can't be used to reset anyone's password, since the raw token that
-- hashes to a given value can't be recovered from the hash.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
