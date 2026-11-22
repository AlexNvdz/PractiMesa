-- Catalog per location (Q43). The chain catalog stays organization-wide; a location can add products of its own
-- (products.location_id) and drop chain products it does not sell (location_products.is_listed = false, permanent,
-- unlike is_available, which is "sold out today").
ALTER TABLE products ADD COLUMN location_id UUID;
ALTER TABLE products ADD CONSTRAINT products_location_fkey
  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id) ON DELETE CASCADE ON UPDATE NO ACTION;
CREATE INDEX products_location_idx ON products (location_id);

ALTER TABLE location_products ADD COLUMN is_listed BOOLEAN NOT NULL DEFAULT TRUE;
