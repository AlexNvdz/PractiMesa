-- Business handle (Q26) replaces slug: letters, digits and _, 3-30, stored as typed, unique ignoring case.
-- Storefront subdomain = lower(handle) with _ -> - (no hyphen in handles, so no collisions).
ALTER TABLE organizations RENAME COLUMN slug TO handle;
ALTER TABLE organizations DROP CONSTRAINT organizations_slug_key;
UPDATE organizations SET handle = replace(handle, '-', '_');
ALTER TABLE organizations ALTER COLUMN handle TYPE VARCHAR(30);
ALTER TABLE organizations ADD CONSTRAINT organizations_handle_check CHECK (handle ~ '^[A-Za-z0-9_]{3,30}$');
CREATE UNIQUE INDEX organizations_handle_lower_key ON organizations (lower(handle));

-- Location limit (Q25): SINGLE = 1 always, MULTI up to 5.
ALTER TABLE organizations ADD CONSTRAINT organizations_max_locations_check
  CHECK (max_locations BETWEEN 1 AND 5 AND (plan_tier = 'MULTI' OR max_locations = 1));

-- Suspended by the platform (Q27): nobody of the business can log in or use the API.
ALTER TABLE organizations ADD COLUMN suspended_at TIMESTAMPTZ;

-- Plan, limit, handle and suspension belong to the platform: request code may only update these columns.
-- (FOR UPDATE row locks still work: they need UPDATE on at least one column.)
REVOKE UPDATE ON organizations FROM practimesa_app;
GRANT UPDATE (name, nit) ON organizations TO practimesa_app;

-- SaaS owner accounts (Q27), outside every tenant: no grant to practimesa_app, system path only.
-- Created by script (scripts/platform-admin.ts), there is no sign-up.
CREATE TABLE platform_admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(150) NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX platform_admins_email_lower_key ON platform_admins (lower(email));
