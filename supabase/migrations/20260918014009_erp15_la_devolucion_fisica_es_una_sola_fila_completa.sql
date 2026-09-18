-- ERP-15 - La devolucion fisica es UNA fila, y la base no acepta la mitad.
--
-- Decidido el 2026-09-17 tras medir, no tras recordar. Norman: "no recuerdo
-- como funciona, mejor verifica como funciona y piensa cual es lo mas
-- intuitivo".
--
-- LO MEDIDO:
--   * 0 filas de DEVOLUCION_FISICA / INGRESO_TRASPASO / EGRESO_TRASPASO
--     en 488 del ledger. Los tres cambios de abajo son no-ops sobre los datos
--     de hoy, y por eso se pueden aplicar sin mover una sola cifra.
--   * v_stock_por_cubeta ya une por `destino OR origen`, o sea que UNA fila con
--     los dos campos ya produce dos renglones, uno por entidad. La forma de una
--     sola fila ya estaba soportada; lo que faltaba era que restara.
--   * `DEVOLUCION_FISICA` estaba en la rama de ENTRADAS de
--     `inventario_ledger_entidad_obligatoria`, o sea que la base aceptaba una
--     devolucion CON destino y SIN origen: entraba a la matriz y no salia de
--     nadie. Ese era el defecto, no el CHECK de tipos.
--
-- POR QUE UNA FILA Y NO EL PAR SALIDA/ENTRADA_CONCESION:
--   dos filas se pueden escribir a medias -una se guarda, la otra se pierde- y
--   eso es exactamente lo que ERP-11 existe para arreglar. Copiar el par seria
--   copiar el bug. Una fila es atomica por construccion.

-- 1. Los tres tipos que el codigo ya conoce entran al CHECK. Permisivo: solo
--    agrega a una lista blanca, no invalida ninguna fila existente.
ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_tipo_movimiento_check;

ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_tipo_movimiento_check
  CHECK (tipo_movimiento IN (
    'ENTRADA_COMPRA', 'SALIDA_VENTA', 'PRODUCCION', 'MERMA', 'TRASPASO',
    'ANULADO', 'ENTRADA_CONCESION', 'SALIDA_CONCESION', 'LIQUIDACION_INTERNA',
    'DEVOLUCION_FISICA', 'INGRESO_TRASPASO', 'EGRESO_TRASPASO'
  ));

-- 2. Una devolucion fisica exige LAS DOS entidades. Es lo que impide escribir
--    media devolucion. Las otras ramas quedan identicas a como estaban.
ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_entidad_obligatoria;

ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_entidad_obligatoria
  CHECK (
    CASE
      WHEN tipo_movimiento = 'DEVOLUCION_FISICA'
        THEN id_entidad_origen IS NOT NULL AND id_entidad_destino IS NOT NULL
      WHEN tipo_movimiento IN ('ENTRADA_COMPRA', 'PRODUCCION', 'INGRESO_TRASPASO', 'ENTRADA_CONCESION')
        THEN id_entidad_destino IS NOT NULL
      WHEN tipo_movimiento IN ('SALIDA_VENTA', 'MERMA', 'TRASPASO', 'EGRESO_TRASPASO', 'SALIDA_CONCESION')
        THEN id_entidad_origen IS NOT NULL
      ELSE false
    END
  );

-- 3. La vista aprende a restarle al distribuidor. `DEVOLUCION_FISICA` ya estaba
--    en la lista de entradas (suma al destino); ahora tambien esta en la de
--    salidas (resta al origen). Se conserva `security_invoker = true`: sin eso
--    la RLS de las tablas dejaria de aplicarse al leer la vista.
CREATE OR REPLACE VIEW public.v_stock_por_cubeta
  WITH (security_invoker = true) AS
  WITH movimientos AS (
    SELECT e.id AS id_entidad,
           e.nombre AS entidad,
           il.id_producto,
           CASE WHEN il.cubeta = 'CONSIGNADO' THEN 'CONSIGNADO' ELSE 'PAGADO' END AS cubeta,
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
