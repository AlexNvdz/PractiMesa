-- Refresh tokens: system path only (login/refresh happen before a tenant context exists).
-- No grant to practimesa_app, so request code under RLS cannot read them.
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, -- sha256 of the opaque token; the token itself is never stored
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Emails are matched case-insensitively at login.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
