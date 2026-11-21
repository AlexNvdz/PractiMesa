-- Electronic invoice (Factus) per order: who it is for (null = consumidor final), retries and DIAN links.
ALTER TABLE orders
  ADD COLUMN invoice_customer JSONB,
  ADD COLUMN factus_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN factus_error TEXT,
  ADD COLUMN factus_qr_url TEXT,
  ADD COLUMN factus_pdf_url TEXT;
