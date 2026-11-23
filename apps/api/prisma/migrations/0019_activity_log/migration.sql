-- Activity log (Q41, Q57): stock received and counted, cash registers opened and closed.
-- Append-only for the app role: it can read and insert, never update or delete (anti-fraud).
CREATE TABLE activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL DEFAULT app_org_id() REFERENCES organizations(id) ON DELETE CASCADE,
    location_id UUID NOT NULL,
    user_id UUID NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('STOCK_RECEIVE', 'STOCK_COUNT', 'REGISTER_OPEN', 'REGISTER_CLOSE')),
    -- No FK: the history outlives a deleted ingredient (its name is kept in details).
    ingredient_id UUID,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT activity_log_location_fkey FOREIGN KEY (location_id, organization_id)
        REFERENCES locations(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT activity_log_user_fkey FOREIGN KEY (user_id, organization_id)
        REFERENCES users(id, organization_id)
);
CREATE INDEX idx_activity_log_location ON activity_log(location_id, created_at DESC);
CREATE INDEX idx_activity_log_ingredient ON activity_log(ingredient_id, created_at DESC);

GRANT SELECT, INSERT ON activity_log TO practimesa_app;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON activity_log TO practimesa_app
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());
