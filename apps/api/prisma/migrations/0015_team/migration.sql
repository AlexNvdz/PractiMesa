-- Team (Q30-Q31): workers sign in with username + PIN and have no email or password;
-- owners and admins keep email + password (and may also have a PIN).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_manager_login_check
  CHECK (role NOT IN ('OWNER', 'ADMIN') OR (email IS NOT NULL AND password_hash IS NOT NULL));

-- Names apart, so the team form can suggest the username ("Alex Andrés" + "Navarro Díaz" -> alex.navarro).
-- full_name stays as the display name.
ALTER TABLE users ADD COLUMN given_names VARCHAR(80);
ALTER TABLE users ADD COLUMN family_names VARCHAR(80);

-- Username: lowercase letters, digits and dots, unique within the business.
ALTER TABLE users ADD COLUMN username VARCHAR(30);
ALTER TABLE users ADD CONSTRAINT users_username_check CHECK (username ~ '^[a-z0-9.]{3,30}$');
CREATE UNIQUE INDEX users_org_username_key ON users (organization_id, username);

-- PIN (4-6 digits) stored as an argon2id hash; not unique on purpose (Q32).
ALTER TABLE users ADD COLUMN pin_hash TEXT;

-- Deactivated users cannot sign in or use the API; their history stays.
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
