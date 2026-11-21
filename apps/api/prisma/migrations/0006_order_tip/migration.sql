-- Voluntary tip (Ley 1935 de 2018): kept apart from the consumption total, which is what gets invoiced.
ALTER TABLE orders ADD COLUMN tip_cop NUMERIC(12, 2) NOT NULL DEFAULT 0 CONSTRAINT orders_tip_check CHECK (tip_cop >= 0);
