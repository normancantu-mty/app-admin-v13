-- Comprobaciones de 20261127120000_comision_con_decimales.sql sobre el Postgres
-- EFIMERO de scripts/probar_migracion_efimera.py. Hace RAISE EXCEPTION si algo
-- no cuadra. 2026-11-27.
--
-- Uso (desde la raiz del repo):
--   python scripts/probar_migracion_efimera.py \
--     supabase/pruebas/comision_decimal_semilla.sql \
--     supabase/migrations/20261127120000_comision_con_decimales.sql \
--     --comprobar supabase/pruebas/comision_decimal_comprobar.sql

DO $$
DECLARE
  v_tipo text;
  v_n int;
  v_id uuid;
  v_val numeric;
BEGIN
  -- 1. Las cuatro columnas quedaron numeric(7,4).
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'entidades'
     AND column_name IN ('comision_base','comision_base_local','comision_hijo_local','comision_logistica')
     AND data_type = 'numeric' AND numeric_precision = 7 AND numeric_scale = 4;
  IF v_n <> 4 THEN RAISE EXCEPTION 'FALLA 1: % de 4 columnas en numeric(7,4)', v_n; END IF;

  -- 2. Los datos de la semilla (copia de los 15 valores reales de produccion) no cambiaron.
  SELECT count(*) INTO v_n FROM public.entidades e JOIN semilla_comision s ON s.nombre = e.nombre
   WHERE e.comision_base IS DISTINCT FROM s.cb OR e.comision_base_local IS DISTINCT FROM s.cbl
      OR e.comision_hijo_local IS DISTINCT FROM s.chl OR e.comision_logistica IS DISTINCT FROM s.cl;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA 2: % filas cambiaron de valor', v_n; END IF;
  SELECT count(*) INTO v_n FROM semilla_comision;
  IF v_n <> 16 THEN RAISE EXCEPTION 'FALLA 2b: la semilla tiene % filas (esperaba 16)', v_n; END IF;

  -- 3. 0.175 y 0.125 se guardan EXACTOS (antes: 0.18 y 0.13).
  UPDATE public.entidades SET comision_hijo_local = 0.175 WHERE nombre = 'Gilberto Franco';
  SELECT comision_hijo_local INTO v_val FROM public.entidades WHERE nombre = 'Gilberto Franco';
  IF v_val <> 0.175 THEN RAISE EXCEPTION 'FALLA 3: 0.175 quedo %', v_val; END IF;
  UPDATE public.entidades SET comision_base_local = 0.125 WHERE nombre = 'Casa Verde';
  SELECT comision_base_local INTO v_val FROM public.entidades WHERE nombre = 'Casa Verde';
  IF v_val <> 0.125 THEN RAISE EXCEPTION 'FALLA 3b: 0.125 quedo %', v_val; END IF;

  -- 4. Mas de 4 decimales: Postgres redondea half-up (el TS ya lo hizo y aviso antes).
  UPDATE public.entidades SET comision_base = 0.17555 WHERE nombre = 'David Flores';
  SELECT comision_base INTO v_val FROM public.entidades WHERE nombre = 'David Flores';
  IF v_val <> 0.1756 THEN RAISE EXCEPTION 'FALLA 4: 0.17555 quedo %', v_val; END IF;

  -- 5. La funcion de alta del bot y de la web guarda el decimal.
  v_id := public.crear_entidad_atomica(
    jsonb_build_object('nombre','Prueba 17.5','rol','DST','zona','Foraneo',
                       'comision_base',0.25,'comision_hijo_local',0.175),
    jsonb_build_object('nombre','Efectivo (Prueba 17.5)'));
  SELECT comision_hijo_local INTO v_val FROM public.entidades WHERE id = v_id;
  IF v_val <> 0.175 THEN RAISE EXCEPTION 'FALLA 5: crear_entidad_atomica guardo %', v_val; END IF;

  -- 6. El default sigue siendo cero.
  SELECT column_default INTO v_tipo FROM information_schema.columns
   WHERE table_schema='public' AND table_name='entidades' AND column_name='comision_base';
  IF v_tipo NOT LIKE '0%' THEN RAISE EXCEPTION 'FALLA 6: default %', v_tipo; END IF;

  -- 7. Las vistas sobre entidades siguen respondiendo.
  PERFORM count(*) FROM public.v_saldo_entidad;
  PERFORM count(*) FROM public.v_movimiento_clasificado;

  RAISE NOTICE 'OK: 4 columnas numeric(7,4), 16 valores intactos, 0.175/0.125 exactos, crear_entidad_atomica guarda 0.175, vistas vivas';
END $$;
