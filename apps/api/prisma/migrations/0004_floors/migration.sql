-- Floors (or zones) of a location, optional; tables get a number and a name unique per location.

CREATE TABLE floors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL DEFAULT app_org_id(),
    location_id UUID NOT NULL,
    name VARCHAR(40) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    CONSTRAINT floors_location_fkey FOREIGN KEY (location_id, organization_id)
        REFERENCES locations (id, organization_id) ON DELETE CASCADE,
    CONSTRAINT floors_location_name_key UNIQUE (location_id, name),
    -- Target of the tables FK: a table can only sit on a floor of its own location.
    CONSTRAINT floors_id_location_org_key UNIQUE (id, location_id, organization_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON floors TO practimesa_app;
ALTER TABLE floors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON floors TO practimesa_app
  USING (organization_id = app_org_id()) WITH CHECK (organization_id = app_org_id());

ALTER TABLE dining_tables ADD COLUMN floor_id UUID, ADD COLUMN number INT;

-- Existing tables are numbered by name within their location.
UPDATE dining_tables t SET number = n.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY location_id ORDER BY name, id) AS rn FROM dining_tables) n
 WHERE n.id = t.id;

ALTER TABLE dining_tables
  ALTER COLUMN number SET NOT NULL,
  ADD CONSTRAINT dining_tables_number_check CHECK (number > 0),
  ADD CONSTRAINT dining_tables_location_number_key UNIQUE (location_id, number),
  ADD CONSTRAINT dining_tables_location_name_key UNIQUE (location_id, name),
  -- NO ACTION: a floor with tables cannot be deleted.
  ADD CONSTRAINT dining_tables_floor_fkey FOREIGN KEY (floor_id, location_id, organization_id)
      REFERENCES floors (id, location_id, organization_id);
