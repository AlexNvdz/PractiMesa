-- Voided lines and cancelled orders keep who did it, when and why (anti-fraud, Q55).
-- A voided line stays on the order but no longer counts toward totals, stock, invoice or kitchen.
ALTER TABLE order_items
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by UUID,
  ADD COLUMN void_reason VARCHAR(20),
  ADD COLUMN void_note VARCHAR(120),
  ADD CONSTRAINT order_items_voided_by_fkey FOREIGN KEY (voided_by, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT order_items_void_check CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL AND void_note IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL
        AND void_reason IN ('MISTAKE', 'NOT_WANTED', 'DELAY', 'OTHER') AND (void_reason <> 'OTHER' OR void_note IS NOT NULL)));

ALTER TABLE orders
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by UUID,
  ADD COLUMN cancel_reason VARCHAR(20),
  ADD COLUMN cancel_note VARCHAR(120),
  ADD CONSTRAINT orders_cancelled_by_fkey FOREIGN KEY (cancelled_by, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT orders_cancel_reason_check CHECK (cancel_reason IN ('MISTAKE', 'NOT_WANTED', 'DELAY', 'OTHER') AND (cancel_reason <> 'OTHER' OR cancel_note IS NOT NULL));
