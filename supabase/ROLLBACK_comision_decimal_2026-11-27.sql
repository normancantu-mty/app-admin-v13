-- ============================================================================
-- REVERSA de 20261127120000_comision_con_decimales.sql (2026-11-27).
-- Regresa las cuatro entidades.comision_* a numeric(5,2).
--
-- OJO: numeric(5,2) solo guarda porcentajes ENTEROS. Una comision de 17.5%
-- (0.1750) quedaria en 18% (0.18) y una de 12.5% en 13%. Esta reversa NO se
-- detiene por eso (es una reversa: se corre cuando hay que regresar), pero el
-- primer SELECT dice exactamente que filas perderian su medio punto.
-- Si se corre, regresar tambien el codigo a la version de antes (master previo).
-- ============================================================================

-- 1) ANTES: quien perderia decimales (si sale vacio, la reversa no cambia ningun dato).
SELECT nombre, rol, comision_base, comision_base_local, comision_hijo_local, comision_logistica
  FROM public.entidades
 WHERE comision_base       <> round(comision_base, 2)
    OR comision_base_local <> round(comision_base_local, 2)
    OR comision_hijo_local <> round(comision_hijo_local, 2)
    OR comision_logistica  <> round(comision_logistica, 2);

-- 2) La reversa.
BEGIN;
ALTER TABLE public.entidades
  ALTER COLUMN comision_base       TYPE numeric(5,2),
  ALTER COLUMN comision_base_local TYPE numeric(5,2),
  ALTER COLUMN comision_hijo_local TYPE numeric(5,2),
  ALTER COLUMN comision_logistica  TYPE numeric(5,2);
ALTER TABLE public.entidades
  ALTER COLUMN comision_base       SET DEFAULT 0.00,
  ALTER COLUMN comision_base_local SET DEFAULT 0.00,
  ALTER COLUMN comision_hijo_local SET DEFAULT 0.00,
  ALTER COLUMN comision_logistica  SET DEFAULT 0.00;
COMMIT;

-- 3) DESPUES: las cuatro deben decir numeric 5,2.
SELECT column_name, data_type, numeric_precision, numeric_scale, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'entidades' AND column_name LIKE 'comision%'
 ORDER BY column_name;
