-- Order items remember the round (kitchen ticket) they were sent in and the tax rate charged,
-- so later product price/tax changes do not alter open accounts or invoices.
ALTER TABLE order_items
  ADD COLUMN round INT NOT NULL DEFAULT 1 CONSTRAINT order_items_round_check CHECK (round > 0),
  ADD COLUMN tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 0;
