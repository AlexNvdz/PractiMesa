-- Time a table is reserved for (only while status = RESERVED) and the name on a counter (PICKUP) order.
ALTER TABLE dining_tables ADD COLUMN reserved_for TIMESTAMPTZ;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_reserved_for_check
  CHECK (reserved_for IS NULL OR status = 'RESERVED');
ALTER TABLE orders ADD COLUMN customer_name VARCHAR(60);
