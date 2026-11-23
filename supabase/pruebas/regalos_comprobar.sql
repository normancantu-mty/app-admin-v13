-- Prueba desechable 2026-11-23: regalo sin costo, suma por persona, razon guardada.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.entidades (id, nombre, rol, zona) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Matriz prueba', 'ADMIN', 'Zacatecas');
INSERT INTO public.catalogo_productos (id, sku, nombre, tipo, ml_por_unidad)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'PRB750', 'Prueba 750ml', 'TERMINADO', 750),
       ('00000000-0000-0000-0000-0000000000b2', 'PRB50', 'Prueba 50ml', 'TERMINADO', 50);
INSERT INTO public.inventario_ledger (id_producto, id_entidad_destino, tipo_movimiento, cantidad, cubeta, costo_unitario_movimiento) VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','PRODUCCION',10,'PAGADO',0);
SET LOCAL ROLE service_role;
DO $$
DECLARE v uuid; n int; t text;
BEGIN
  -- sin costo_unitario_movimiento: la RPC lo acepta
  PERFORM public.registrar_regalo(
    '{"quien_regalo":"Norman","motivo":"conferencia de IA","fecha":"2026-11-23","id_entidad_origen":"00000000-0000-0000-0000-0000000000a1","usuario_creador":"telegram:norman"}',
    '[{"id_producto":"00000000-0000-0000-0000-0000000000b1","cubeta":"PAGADO","cantidad":1}]');
  PERFORM public.registrar_regalo(
    '{"quien_regalo":"Kevin","motivo":"feria","fecha":"2026-11-22","id_entidad_origen":"00000000-0000-0000-0000-0000000000a1","usuario_creador":"telegram:kevin"}',
    '[{"id_producto":"00000000-0000-0000-0000-0000000000b1","cubeta":"PAGADO","cantidad":2},{"id_producto":"00000000-0000-0000-0000-0000000000b2","cubeta":"PAGADO","cantidad":3}]');
  v := public.registrar_regalo(
    '{"quien_regalo":"Kevin","motivo":"boda","fecha":"2026-11-23","id_entidad_origen":"00000000-0000-0000-0000-0000000000a1","usuario_creador":"telegram:kevin"}',
    '[{"id_producto":"00000000-0000-0000-0000-0000000000b1","cubeta":"PAGADO","cantidad":1}]');
  SELECT string_agg(q, ' | ' ORDER BY q) INTO t FROM (SELECT quien_regalo || '=' || trim_scale(sum(piezas)) q FROM public.v_regalo_lineas GROUP BY quien_regalo) x;
  IF t IS DISTINCT FROM 'Kevin=6 | Norman=1' THEN RAISE EXCEPTION 'suma por persona: %', t; END IF;
  RAISE NOTICE 'OK 1 suma por persona: %', t;
  SELECT string_agg(DISTINCT motivo, ', ' ORDER BY motivo) INTO t FROM public.v_regalo_lineas;
  IF t IS DISTINCT FROM 'boda, conferencia de IA, feria' THEN RAISE EXCEPTION 'razones: %', t; END IF;
  RAISE NOTICE 'OK 2 cada razon guardada: %', t;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'v_regalo_lineas' AND column_name LIKE '%costo%';
  IF n <> 0 THEN RAISE EXCEPTION 'la vista trae costo'; END IF;
  RAISE NOTICE 'OK 3 la vista no trae costo';
  SELECT count(*) INTO n FROM public.inventario_ledger WHERE id_regalo IS NOT NULL AND tipo_movimiento = 'MERMA' AND id_entidad_origen IS NOT NULL;
  IF n <> 4 THEN RAISE EXCEPTION 'filas de inventario: %', n; END IF;
  RAISE NOTICE 'OK 4 el inventario baja: 4 filas MERMA';
  SELECT sum(stock) INTO n FROM public.v_stock_por_cubeta WHERE id_producto = '00000000-0000-0000-0000-0000000000b1';
  RAISE NOTICE 'OK 5 stock 750 visto por v_stock_por_cubeta: %', n;
  IF n IS DISTINCT FROM 6 THEN RAISE EXCEPTION 'stock: %', n; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  UPDATE public.inventario_ledger SET status = 'ANULADO' WHERE id_regalo IN (SELECT id FROM public.regalos WHERE motivo = 'boda');
  IF (SELECT sum(piezas) FROM public.v_regalo_lineas WHERE quien_regalo = 'Kevin') <> 5 THEN RAISE EXCEPTION 'anular no baja el contador'; END IF;
  RAISE NOTICE 'OK 6 anular el movimiento baja el contador (Kevin 6 -> 5)';
END $$;
ROLLBACK;
