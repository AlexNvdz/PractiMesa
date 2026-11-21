-- Integration credentials per organization (each business has its own Factus Pay account and NIT).
-- Sealed with AES-256-GCM (CREDENTIALS_KEY) and bound to organization + provider.
-- System path only: no grant to practimesa_app, so request code under RLS can never read them.
CREATE TABLE organization_credentials (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('FACTUS_PAY', 'FACTUS')),
    sealed TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (organization_id, provider)
);
