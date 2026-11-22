-- Only the owner signs in with email + password; supervisors (ADMIN) use username + PIN like everyone else.
ALTER TABLE users DROP CONSTRAINT users_manager_login_check;
UPDATE users SET email = NULL, password_hash = NULL WHERE role = 'ADMIN';
ALTER TABLE users ADD CONSTRAINT users_owner_login_check
  CHECK (role <> 'OWNER' OR (email IS NOT NULL AND password_hash IS NOT NULL));

-- Unlinking a device deletes it, leaving no trace (its PIN sessions go with it: refresh_tokens cascade).
DELETE FROM devices WHERE revoked_at IS NOT NULL;
ALTER TABLE devices DROP COLUMN revoked_at;
GRANT DELETE ON devices TO practimesa_app;

-- One-time link codes: the owner picks location + name, the new device types handle + code.
-- Only the sha256 of the code is stored; it is spent (deleted) on use or ignored after expires_at.
CREATE TABLE device_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL DEFAULT app_org_id() REFERENCES organizations(id) ON DELETE CASCADE,
    location_id UUID NOT NULL,
    name VARCHAR(80) NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    created_by UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT device_codes_location_fkey FOREIGN KEY (location_id, organization_id)
        REFERENCES locations(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT device_codes_created_by_fkey FOREIGN KEY (created_by, organization_id)
        REFERENCES users(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX idx_device_codes_org ON device_codes(organization_id);

GRANT SELECT, INSERT, DELETE ON device_codes TO practimesa_app;
ALTER TABLE device_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_codes TO practimesa_app
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
