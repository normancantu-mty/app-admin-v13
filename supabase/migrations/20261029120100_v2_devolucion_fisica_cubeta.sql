-- v2 LOCAL (2026-10-29, Socio ejecutor, T5): la devolucion fisica de mercancia CONSIGNADA.
--
-- LO MEDIDO (base local, carga conciliada): consignacion de 3 x 750 a un DST, devolucion de 1
-- por /dashboard/distribuidores/[id]/devolucion, venta de 1. Stock real del DST: 1.
-- v_stock_por_cubeta decia CONSIGNADO = 2 y escondia PAGADO = -1 (HAVING > 0): la fila de
-- DEVOLUCION_FISICA se escribia con la cubeta por default (PAGADO), asi que no bajaba su
-- consignado. Las unidades consignadas (las 281 del arranque) quedaban infladas tras cada
-- devolucion.
--
-- EL ARREGLO, en dos lados:
--  * app/actions/devoluciones.ts escribe la fila con cubeta = 'CONSIGNADO' (abona deuda, asi
--    que son piezas consignadas).
--  * Esta vista: del lado del DESTINO (la matriz) una DEVOLUCION_FISICA cuenta siempre en
--    PAGADO; del lado del origen, en la cubeta de la fila. Es un no-op para las filas que ya
--    existen con PAGADO (ambos lados siguen en PAGADO).
-- Copia de la vista de 20260918014009 con solo la expresion de la cubeta cambiada.

CREATE OR REPLACE VIEW public.v_stock_por_cubeta
  WITH (security_invoker = true) AS
  WITH movimientos AS (
    SELECT e.id AS id_entidad,
           e.nombre AS entidad,
           il.id_producto,
           CASE
             -- v2 (2026-10-29): la devolucion fisica sale del CONSIGNADO del nodo y entra al
             -- PAGADO de la matriz. Una fila, dos cubetas: la del destino es siempre PAGADO.
             WHEN il.tipo_movimiento::text = 'DEVOLUCION_FISICA' AND il.id_entidad_destino = e.id THEN 'PAGADO'
             WHEN il.cubeta = 'CONSIGNADO' THEN 'CONSIGNADO'
             ELSE 'PAGADO'
           END AS cubeta,
           CASE
             WHEN il.id_entidad_destino = e.id AND il.tipo_movimiento::text = ANY (ARRAY['ENTRADA_COMPRA','PRODUCCION','DEVOLUCION_FISICA','INGRESO_TRASPASO','ENTRADA_CONCESION'])
               THEN il.cantidad
             WHEN il.id_entidad_origen = e.id AND il.tipo_movimiento::text = ANY (ARRAY['SALIDA_VENTA','MERMA','TRASPASO','EGRESO_TRASPASO','SALIDA_CONCESION','DEVOLUCION_FISICA'])
               THEN - il.cantidad
             ELSE 0::numeric
           END AS delta
      FROM inventario_ledger il
      JOIN entidades e ON e.id = il.id_entidad_destino OR e.id = il.id_entidad_origen
     WHERE il.status = ANY (ARRAY['ACTIVO','APPROVED'])
  )
  SELECT m.id_entidad,
         m.entidad,
         m.id_producto,
         p.nombre AS producto,
         m.cubeta,
         round(sum(m.delta), 4) AS stock
    FROM movimientos m
    JOIN catalogo_productos p ON p.id = m.id_producto
   WHERE p.tipo::text = 'TERMINADO'
   GROUP BY m.id_entidad, m.entidad, m.id_producto, p.nombre, m.cubeta
  HAVING round(sum(m.delta), 4) > 0::numeric;
