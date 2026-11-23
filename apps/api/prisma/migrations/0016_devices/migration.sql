-- Authorized devices (Q29): a browser where the owner or an admin signed in and ticked
-- "Recordar este dispositivo". Workers sign in with username + PIN only there, at its location.
-- The browser keeps an opaque token in an httpOnly cookie; only its sha256 is stored.
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL DEFAULT app_org_id() REFERENCES organizations(id) ON DELETE CASCADE,
    location_id UUID NOT NULL,
    name VARCHAR(80) NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by UUID NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT devices_id_org_key UNIQUE (id, organization_id),
    CONSTRAINT devices_location_fkey FOREIGN KEY (location_id, organization_id)
        REFERENCES locations(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT devices_created_by_fkey FOREIGN KEY (created_by, organization_id)
        REFERENCES users(id, organization_id)
);
CREATE INDEX idx_devices_org ON devices(organization_id);

GRANT SELECT, INSERT, UPDATE ON devices TO practimesa_app;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON devices TO practimesa_app
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());

-- PIN sessions belong to a device (Q33): revoking the device ends them.
ALTER TABLE refresh_tokens ADD COLUMN device_id UUID REFERENCES devices(id) ON DELETE CASCADE;

-- 5 wrong PINs lock the user for 5 minutes (Q32).
ALTER TABLE users ADD COLUMN pin_failed_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pin_locked_until TIMESTAMPTZ;
