-- ===========================================================================
--  ERP-15 · `DEVOLUCION_FISICA` entra al CHECK de tipos de inventario
-- ===========================================================================
--  Escrito el 2026-09-14 por el Socio.  **ESTA MIGRACION NO ESTA APLICADA.**
--  Se aplica con `apply_migration` del MCP. NUNCA con `supabase db push`.
--
-- ---------------------------------------------------------------------------
--  1. POR QUE APARECIO AHORA
-- ---------------------------------------------------------------------------
--  Buscando cuantas filas habria que reclasificar en `devoluciones.ts` -que
--  escribe `ENTRADA_COMPRA` donde va una devolucion- el conteo dio **0**:
--
--      filas con notas 'Devolucion de Distribuidor' ..... 0
--      filas con tipo_movimiento = 'DEVOLUCION_FISICA' .. 0
--
--  O sea que **ese flujo nunca se ha usado en produccion**. No hay historia que
--  reescribir, que es la mejor noticia posible. Pero al mirar el CHECK vivo:
--
--      CHECK (tipo_movimiento IN ('ENTRADA_COMPRA','SALIDA_VENTA','PRODUCCION',
--        'MERMA','TRASPASO','ANULADO','ENTRADA_CONCESION','SALIDA_CONCESION',
--        'LIQUIDACION_INTERNA'))
--
--  **`DEVOLUCION_FISICA` no esta.** Tampoco `INGRESO_TRASPASO` ni
--  `EGRESO_TRASPASO`, que si existen en el enum de TypeScript
--  (`lib/inventario-types.ts`). Si hoy se corrigiera `devoluciones.ts` para que
--  escriba el tipo correcto, **Postgres rechazaria la fila** y el flujo dejaria
--  de funcionar del todo. Por eso esta migracion va ANTES que ese cambio de
--  codigo, y no despues.
--
-- ---------------------------------------------------------------------------
--  2. ES PERMISIVA, NO RESTRICTIVA
-- ---------------------------------------------------------------------------
--  Solo agrega valores a una lista blanca. No invalida ni una fila existente
--  -las 484 usan 7 tipos, todos ya permitidos- y no puede romper nada que hoy
--  funcione. Se comprueba en el paso 4.
--
-- ---------------------------------------------------------------------------
--  3. EL CAMBIO
-- ---------------------------------------------------------------------------

ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_tipo_movimiento_check;

ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_tipo_movimiento_check
  CHECK (tipo_movimiento IN (
    'ENTRADA_COMPRA', 'SALIDA_VENTA', 'PRODUCCION', 'MERMA', 'TRASPASO',
    'ANULADO', 'ENTRADA_CONCESION', 'SALIDA_CONCESION', 'LIQUIDACION_INTERNA',
    'DEVOLUCION_FISICA', 'INGRESO_TRASPASO', 'EGRESO_TRASPASO'
  ));

-- ---------------------------------------------------------------------------
--  4. COMPROBACION, PARA CORRER JUSTO DESPUES DE APLICAR
-- ---------------------------------------------------------------------------
--  (a) Ninguna fila vieja quedo fuera -tiene que dar 484 y 484-:
--
--      SELECT count(*) AS total,
--             count(*) FILTER (WHERE tipo_movimiento IN (
--               'ENTRADA_COMPRA','SALIDA_VENTA','PRODUCCION','MERMA','TRASPASO',
--               'ANULADO','ENTRADA_CONCESION','SALIDA_CONCESION',
--               'LIQUIDACION_INTERNA','DEVOLUCION_FISICA','INGRESO_TRASPASO',
--               'EGRESO_TRASPASO')) AS permitidas
--      FROM public.inventario_ledger;
--
--  (b) CONTROL POSITIVO. Un tipo inventado tiene que SEGUIR fallando con 23514.
--      Sin esto, una lista que aceptara todo daria el mismo "paso" que una
--      correcta:
--
--      BEGIN;
--        INSERT INTO public.inventario_ledger (id_producto, tipo_movimiento, cantidad, usuario_creador, status, id_entidad_destino)
--        SELECT p.id, 'TIPO_QUE_NO_EXISTE', 1, 'prueba-erp15', 'ACTIVO', e.id
--        FROM public.catalogo_productos p, public.entidades e WHERE e.rol='ADMIN' LIMIT 1;
--      ROLLBACK;
--
--  (c) CONTROL NEGATIVO. `DEVOLUCION_FISICA` **con su destino** ya entra:
--
--      BEGIN;
--        INSERT INTO public.inventario_ledger (id_producto, tipo_movimiento, cantidad, usuario_creador, status, id_entidad_destino)
--        SELECT p.id, 'DEVOLUCION_FISICA', 1, 'prueba-erp15', 'ACTIVO', e.id
--        FROM public.catalogo_productos p, public.entidades e WHERE e.rol='ADMIN' LIMIT 1;
--      ROLLBACK;
--
-- ---------------------------------------------------------------------------
--  5. LO QUE ESTA MIGRACION **NO** RESUELVE, Y ES DECISION DE NORMAN
-- ---------------------------------------------------------------------------
--  Que el tipo EXISTA no dice de que lado cuenta. Hoy `DEVOLUCION_FISICA` esta
--  en `TIPOS_MOVIMIENTO_ENTRADA` y en ninguna lista de salida
--  (`lib/inventario-types.ts:24`). Con esa clasificacion, una devolucion
--  **suma al almacen y nunca resta al libro del distribuidor**: el mismo
--  producto queda existiendo en los dos lados a la vez.
--
--  La pregunta de negocio, que el agente no puede contestar: cuando un
--  distribuidor devuelve mercancia, **una sola fila** con
--  `id_entidad_origen` = distribuidor e `id_entidad_destino` = matriz, o **dos
--  filas** -una salida del distribuidor y una entrada a la matriz-? El resto del
--  sistema usa el par `SALIDA_CONCESION` / `ENTRADA_CONCESION`, o sea dos filas,
--  y la simetria diria que esto va igual. Pero eso lo decide Norman.
--
--  **Hasta que eso se decida, `devoluciones.ts` NO se toca.** Escribir el tipo
--  correcto con la clasificacion equivocada cambia un error visible por uno
--  silencioso, que es peor.
