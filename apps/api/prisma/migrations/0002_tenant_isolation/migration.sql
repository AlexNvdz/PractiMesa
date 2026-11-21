-- Tenant isolation:
--  1. organization_id on every tenant table, defaulted from the session (app.org_id).
--  2. Composite FKs (id, organization_id) so a row can never reference another org's row
--     (FK checks ignore RLS, so RLS alone would not stop cross-org references).
--  3. order_number numbered per location (was one global SERIAL).
--  4. Role practimesa_app + RLS on every tenant table. The API switches to this role per
--     transaction (set_config('role', ...)); the owner/system path bypasses RLS.

CREATE FUNCTION app_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- 1. organization_id on tables that lacked it (backfilled from their parent)
-- ---------------------------------------------------------------------------
ALTER TABLE dining_tables     ADD COLUMN organization_id UUID;
ALTER TABLE cash_registers    ADD COLUMN organization_id UUID;
ALTER TABLE location_products ADD COLUMN organization_id UUID;
ALTER TABLE location_stock    ADD COLUMN organization_id UUID;
ALTER TABLE product_recipes   ADD COLUMN organization_id UUID;
ALTER TABLE order_items       ADD COLUMN organization_id UUID;

UPDATE dining_tables t     SET organization_id = l.organization_id FROM locations l WHERE l.id = t.location_id;
UPDATE cash_registers t    SET organization_id = l.organization_id FROM locations l WHERE l.id = t.location_id;
UPDATE location_products t SET organization_id = l.organization_id FROM locations l WHERE l.id = t.location_id;
UPDATE location_stock t    SET organization_id = l.organization_id FROM locations l WHERE l.id = t.location_id;
UPDATE product_recipes t   SET organization_id = p.organization_id FROM products p  WHERE p.id = t.product_id;
UPDATE order_items t       SET organization_id = o.organization_id FROM orders o    WHERE o.id = t.order_id;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dining_tables', 'cash_registers', 'location_products', 'location_stock', 'product_recipes', 'order_items'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN organization_id SET NOT NULL', t);
  END LOOP;
  -- Inserts made in a tenant context get the org automatically.
  FOREACH t IN ARRAY ARRAY['locations', 'users', 'categories', 'products', 'location_products', 'ingredients',
                           'location_stock', 'product_recipes', 'dining_tables', 'cash_registers', 'customers',
                           'orders', 'order_items', 'reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN organization_id SET DEFAULT app_org_id()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Composite keys and FKs
-- ---------------------------------------------------------------------------
ALTER TABLE locations      ADD CONSTRAINT locations_id_org_key      UNIQUE (id, organization_id);
ALTER TABLE users          ADD CONSTRAINT users_id_org_key          UNIQUE (id, organization_id);
ALTER TABLE categories     ADD CONSTRAINT categories_id_org_key     UNIQUE (id, organization_id);
ALTER TABLE products       ADD CONSTRAINT products_id_org_key       UNIQUE (id, organization_id);
ALTER TABLE ingredients    ADD CONSTRAINT ingredients_id_org_key    UNIQUE (id, organization_id);
ALTER TABLE customers      ADD CONSTRAINT customers_id_org_key      UNIQUE (id, organization_id);
ALTER TABLE dining_tables  ADD CONSTRAINT dining_tables_id_org_key  UNIQUE (id, organization_id);
ALTER TABLE cash_registers ADD CONSTRAINT cash_registers_id_org_key UNIQUE (id, organization_id);
ALTER TABLE orders         ADD CONSTRAINT orders_id_org_key         UNIQUE (id, organization_id);

ALTER TABLE products DROP CONSTRAINT products_category_id_fkey,
  ADD CONSTRAINT products_category_fkey FOREIGN KEY (category_id, organization_id)
    REFERENCES categories (id, organization_id) ON DELETE SET NULL (category_id);

ALTER TABLE location_products DROP CONSTRAINT location_products_location_id_fkey, DROP CONSTRAINT location_products_product_id_fkey,
  ADD CONSTRAINT location_products_location_fkey FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT location_products_product_fkey  FOREIGN KEY (product_id, organization_id)  REFERENCES products (id, organization_id)  ON DELETE CASCADE;

ALTER TABLE location_stock DROP CONSTRAINT location_stock_location_id_fkey, DROP CONSTRAINT location_stock_ingredient_id_fkey,
  ADD CONSTRAINT location_stock_location_fkey   FOREIGN KEY (location_id, organization_id)   REFERENCES locations (id, organization_id)   ON DELETE CASCADE,
  ADD CONSTRAINT location_stock_ingredient_fkey FOREIGN KEY (ingredient_id, organization_id) REFERENCES ingredients (id, organization_id) ON DELETE CASCADE;

ALTER TABLE product_recipes DROP CONSTRAINT product_recipes_product_id_fkey, DROP CONSTRAINT product_recipes_ingredient_id_fkey,
  ADD CONSTRAINT product_recipes_product_fkey    FOREIGN KEY (product_id, organization_id)    REFERENCES products (id, organization_id)    ON DELETE CASCADE,
  ADD CONSTRAINT product_recipes_ingredient_fkey FOREIGN KEY (ingredient_id, organization_id) REFERENCES ingredients (id, organization_id) ON DELETE CASCADE;

ALTER TABLE dining_tables DROP CONSTRAINT dining_tables_location_id_fkey,
  ADD CONSTRAINT dining_tables_location_fkey FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id) ON DELETE CASCADE;

ALTER TABLE cash_registers DROP CONSTRAINT cash_registers_location_id_fkey, DROP CONSTRAINT cash_registers_opened_by_fkey,
  ADD CONSTRAINT cash_registers_location_fkey  FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT cash_registers_opened_by_fkey FOREIGN KEY (opened_by, organization_id)   REFERENCES users (id, organization_id);

ALTER TABLE orders DROP CONSTRAINT orders_location_id_fkey, DROP CONSTRAINT orders_cash_register_id_fkey,
  DROP CONSTRAINT orders_table_id_fkey, DROP CONSTRAINT orders_customer_id_fkey,
  ADD CONSTRAINT orders_location_fkey      FOREIGN KEY (location_id, organization_id)      REFERENCES locations (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT orders_cash_register_fkey FOREIGN KEY (cash_register_id, organization_id) REFERENCES cash_registers (id, organization_id),
  ADD CONSTRAINT orders_table_fkey         FOREIGN KEY (table_id, organization_id)         REFERENCES dining_tables (id, organization_id),
  ADD CONSTRAINT orders_customer_fkey      FOREIGN KEY (customer_id, organization_id)      REFERENCES customers (id, organization_id);

ALTER TABLE order_items DROP CONSTRAINT order_items_order_id_fkey, DROP CONSTRAINT order_items_product_id_fkey,
  ADD CONSTRAINT order_items_order_fkey   FOREIGN KEY (order_id, organization_id)   REFERENCES orders (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT order_items_product_fkey FOREIGN KEY (product_id, organization_id) REFERENCES products (id, organization_id);

ALTER TABLE reservations DROP CONSTRAINT reservations_location_id_fkey, DROP CONSTRAINT reservations_customer_id_fkey,
  DROP CONSTRAINT reservations_table_id_fkey,
  ADD CONSTRAINT reservations_location_fkey FOREIGN KEY (location_id, organization_id) REFERENCES locations (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT reservations_customer_fkey FOREIGN KEY (customer_id, organization_id) REFERENCES customers (id, organization_id),
  ADD CONSTRAINT reservations_table_fkey    FOREIGN KEY (table_id, organization_id)    REFERENCES dining_tables (id, organization_id);

-- ---------------------------------------------------------------------------
-- 3. order_number per location
-- ---------------------------------------------------------------------------
ALTER TABLE locations ADD COLUMN last_order_number INT NOT NULL DEFAULT 0;
ALTER TABLE orders ALTER COLUMN order_number DROP DEFAULT;
DROP SEQUENCE orders_order_number_seq;
-- Placeholder only: the trigger always overwrites it.
ALTER TABLE orders ALTER COLUMN order_number SET DEFAULT 0;
ALTER TABLE orders ADD CONSTRAINT orders_location_number_key UNIQUE (location_id, order_number);

CREATE FUNCTION assign_order_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Row lock on the location serializes numbering per location.
  UPDATE locations SET last_order_number = last_order_number + 1
   WHERE id = NEW.location_id
   RETURNING last_order_number INTO NEW.order_number;
  RETURN NEW;
END $$;

CREATE TRIGGER orders_assign_number BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION assign_order_number();

-- ---------------------------------------------------------------------------
-- 4. App role + RLS
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'practimesa_app') THEN
    CREATE ROLE practimesa_app NOLOGIN;
  END IF;
  -- The connecting user must be able to SET ROLE to it.
  EXECUTE format('GRANT practimesa_app TO %I', current_user);
END $$;

GRANT USAGE ON SCHEMA public TO practimesa_app;
-- New tenant tables must be granted explicitly (no default privileges on purpose).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  locations, users, categories, products, location_products, ingredients, location_stock,
  product_recipes, dining_tables, cash_registers, customers, orders, order_items, reservations
  TO practimesa_app;
GRANT SELECT, UPDATE ON organizations TO practimesa_app;
-- webhook_events and _prisma_migrations: no grants, system path only.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations', 'users', 'categories', 'products', 'location_products', 'ingredients',
                           'location_stock', 'product_recipes', 'dining_tables', 'cash_registers', 'customers',
                           'orders', 'order_items', 'reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO practimesa_app USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id())',
      t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations TO practimesa_app
  USING (id = app_org_id()) WITH CHECK (id = app_org_id());
