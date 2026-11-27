-- Optional group of an ingredient ("Lácteos", "Carnes y pescados"): shown under its name in Inventario and searchable.
ALTER TABLE ingredients ADD COLUMN category VARCHAR(40);
