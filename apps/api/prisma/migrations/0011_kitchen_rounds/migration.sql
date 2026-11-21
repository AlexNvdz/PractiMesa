-- Kitchen state per round (comanda): the kitchen works ticket by ticket, so round 2 of a table can still
-- be pending while round 1 is served. Every order item belongs to its round row.
CREATE TABLE order_rounds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL DEFAULT app_org_id(),
    order_id UUID NOT NULL,
    round INT NOT NULL CHECK (round > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PREPARING', 'READY', 'DELIVERED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    CONSTRAINT order_rounds_order_round_key UNIQUE (order_id, round, organization_id),
    CONSTRAINT order_rounds_order_fkey FOREIGN KEY (order_id, organization_id)
        REFERENCES orders (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX idx_order_rounds_org_status ON order_rounds (organization_id, status);

-- Existing rounds: still in the kitchen while the account is open, served once paid or cancelled.
INSERT INTO order_rounds (organization_id, order_id, round, status, created_at)
SELECT DISTINCT i.organization_id, i.order_id, i.round,
       CASE WHEN o.payment_status = 'PAID' OR o.status = 'CANCELLED' THEN 'DELIVERED' ELSE 'PENDING' END,
       o.created_at
  FROM order_items i JOIN orders o ON o.id = i.order_id;

ALTER TABLE order_items ADD CONSTRAINT order_items_round_fkey FOREIGN KEY (order_id, round, organization_id)
    REFERENCES order_rounds (order_id, round, organization_id) ON DELETE CASCADE;

-- No DELETE: rounds go only with their order.
GRANT SELECT, INSERT, UPDATE ON order_rounds TO practimesa_app;
ALTER TABLE order_rounds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_rounds TO practimesa_app
    USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());

-- A round changing state announces its order over live_events (migration 0010), with the same payload as
-- orders_live_event so a transaction touching both arrives once. Inserts come with an order update already.
CREATE FUNCTION notify_round_live_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('live_events', json_build_object(
    'type', 'order', 'id', o.id, 'organization_id', o.organization_id, 'location_id', o.location_id)::text)
    FROM orders o WHERE o.id = NEW.order_id;
  RETURN NULL;
END $$;

CREATE TRIGGER order_rounds_live_event AFTER UPDATE ON order_rounds
  FOR EACH ROW EXECUTE FUNCTION notify_round_live_event();
