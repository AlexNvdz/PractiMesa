-- Platform invitations (Q28): one-time sign-up link with plan and location limit chosen by the platform.
-- System path only (no grant to practimesa_app). The token is never stored, only its sha256.
CREATE TABLE invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_hash TEXT NOT NULL UNIQUE,
    plan_tier VARCHAR(20) NOT NULL CHECK (plan_tier IN ('SINGLE', 'MULTI')),
    max_locations INT NOT NULL CHECK (max_locations BETWEEN 1 AND 5 AND (plan_tier = 'MULTI' OR max_locations = 1)),
    note VARCHAR(300), -- internal, never shown to the invitee
    created_by UUID REFERENCES platform_admins(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL, -- business created with it
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Owner phone from sign-up.
ALTER TABLE users ADD COLUMN phone VARCHAR(30);
