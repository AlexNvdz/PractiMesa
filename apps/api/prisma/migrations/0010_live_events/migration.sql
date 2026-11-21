-- Live updates (Q17): every committed change to an order or a table is announced on the live_events
-- channel; the API listens and forwards it over SSE to the terminals of that location. NOTIFY is delivered
-- only on commit, and identical payloads of one transaction arrive once. Only ids travel (8000-byte limit):
-- the terminal refetches what changed through the API, under RLS.
CREATE FUNCTION notify_live_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data record;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := OLD; ELSE row_data := NEW; END IF;
  PERFORM pg_notify('live_events', json_build_object(
    'type', TG_ARGV[0], 'id', row_data.id,
    'organization_id', row_data.organization_id, 'location_id', row_data.location_id)::text);
  RETURN NULL;
END $$;

CREATE TRIGGER orders_live_event AFTER INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION notify_live_event('order');

CREATE TRIGGER dining_tables_live_event AFTER INSERT OR UPDATE OR DELETE ON dining_tables
  FOR EACH ROW EXECUTE FUNCTION notify_live_event('table');
