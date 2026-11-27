-- ============================================================================
-- COMISIONES CON DECIMALES (17.5% / 12.5%). Escrito el 2026-11-27 por el ejecutor
-- del Socio (rama fix/comision-decimal-2026-11-27). SIN APLICAR.
--
-- Norman, de voz, 27-nov, sobre los distribuidores de Gilberto: «dejalos asi como
-- con puntos... que sea la excepcion». 17.5% cuando vende el distribuidor y 12.5%
-- cuando vende un local suyo.
--
--   * Las cuatro `entidades.comision_*` guardan FRACCION (20% = 0.20) en
--     numeric(5,2): solo cabian porcentajes enteros (0.175 -> 0.18).
--   * Pasan a numeric(7,4): cuatro decimales de fraccion = porcentaje con dos
--     (17.5% = 0.1750, 12.25% = 0.1225). Misma parte entera (3 digitos) que
--     numeric(5,2), asi que TODO valor que cabia antes cabe exacto despues: el
--     cambio no puede perder ni redondear un dato.
--   * Medido en produccion el 2026-11-27 (solo SELECT): ninguna vista, regla,
--     CHECK, politica RLS ni trigger depende de estas columnas; la unica funcion
--     que las escribe (`crear_entidad_atomica`) castea a `numeric` sin escala,
--     asi que no se toca. Las 8 vistas sobre `entidades` no leen estas columnas.
--   * Compatible en los dos sentidos: el codigo de antes manda 2 decimales y se
--     guardan igual; el codigo nuevo SIN esta migracion veria su 0.175 redondeado
--     por Postgres a 0.18. Por eso el ORDEN es: primero esta migracion, despues
--     el codigo.
--   * NO agrega ningun CHECK nuevo (el ERP avisa, nunca bloquea).
-- Reversa: supabase/ROLLBACK_comision_decimal_2026-11-27.sql (dice antes que filas
-- perderian su medio punto).
-- ============================================================================

BEGIN;

-- Seguro: si algun objeto llegara a depender de estas columnas, el ALTER fallaria
-- con un error poco claro. Aqui se detiene diciendo cual.
DO $$
DECLARE
  v_deps text;
BEGIN
  SELECT string_agg(DISTINCT r.ev_class::regclass::text, ', ')
    INTO v_deps
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.refobjid = 'public.entidades'::regclass
     AND a.attname IN ('comision_base', 'comision_base_local', 'comision_hijo_local', 'comision_logistica')
     AND r.ev_class <> 'public.entidades'::regclass;
  IF v_deps IS NOT NULL THEN
    RAISE EXCEPTION 'comision con decimales: hay vistas que dependen de las columnas (%). Hay que recrearlas en esta migracion.', v_deps;
  END IF;
END $$;

ALTER TABLE public.entidades
  ALTER COLUMN comision_base       TYPE numeric(7,4),
  ALTER COLUMN comision_base_local TYPE numeric(7,4),
  ALTER COLUMN comision_hijo_local TYPE numeric(7,4),
  ALTER COLUMN comision_logistica  TYPE numeric(7,4);

-- El default era 0.00 (numeric(5,2)); se deja en el mismo cero con la escala nueva.
ALTER TABLE public.entidades
  ALTER COLUMN comision_base       SET DEFAULT 0,
  ALTER COLUMN comision_base_local SET DEFAULT 0,
  ALTER COLUMN comision_hijo_local SET DEFAULT 0,
  ALTER COLUMN comision_logistica  SET DEFAULT 0;

COMMENT ON COLUMN public.entidades.comision_base IS
  'Comision del DST cuando vende el, en FRACCION (0.1750 = 17.5%). numeric(7,4) desde 20261127120000.';
COMMENT ON COLUMN public.entidades.comision_hijo_local IS
  'Comision del DST cuando vende SU local, en FRACCION (0.1250 = 12.5%). numeric(7,4) desde 20261127120000.';
COMMENT ON COLUMN public.entidades.comision_base_local IS
  'Comision del LOC, en FRACCION (0.1250 = 12.5%). numeric(7,4) desde 20261127120000.';
COMMENT ON COLUMN public.entidades.comision_logistica IS
  'Columna muerta (no la lee nadie, ver COLUMNA_MUERTA en lib/bot-entidad.ts). numeric(7,4) desde 20261127120000.';

COMMIT;
