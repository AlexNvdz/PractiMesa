-- order_items -> products is NO ACTION (a sold product cannot be deleted). When a whole organization is
-- deleted, Postgres may run that check before the orders -> order_items cascade, so drop the orders first.
CREATE FUNCTION delete_organization_orders() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM orders WHERE organization_id = OLD.id;
  RETURN OLD;
END $$;

CREATE TRIGGER organizations_delete_orders BEFORE DELETE ON organizations
  FOR EACH ROW EXECUTE FUNCTION delete_organization_orders();
