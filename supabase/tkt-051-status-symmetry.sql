-- TKT-051: Status symmetry between finanzas_ledger and inventario_ledger.
-- 1) Rename inventario_ledger.estado -> status
-- 2) Rebuild CHECK constraint to validate status values on the new column

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventario_ledger'
      AND column_name = 'estado'
  ) THEN
    ALTER TABLE public.inventario_ledger
      RENAME COLUMN estado TO status;
  END IF;
END $$;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t
      ON t.oid = c.conrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'inventario_ledger'
      AND c.contype = 'c'
      AND (
        pg_get_constraintdef(c.oid) ILIKE '%status%'
        OR pg_get_constraintdef(c.oid) ILIKE '%estado%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.inventario_ledger DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_status_check
  CHECK (status IN ('ACTIVO', 'ANULADO'));
