-- ============================================================================
-- v2 LOCAL: correcciones del ADMIN por MOVIMIENTO DE AJUSTE (nunca editando filas)
-- Escrito el 2026-11-03 por el agente de la ruta admin (rama
-- dev/panel-scroll-y-ajustes-admin). SOLO LOCAL: no se aplica en produccion.
-- ============================================================================
-- POR QUE. El ingeniero corrige stock y saldos directo en la base. Este repo es
-- de libros: el stock y el saldo se CALCULAN sumando movimientos y la regla es
-- "anular, no borrar". La correccion entra como UNA fila nueva por la
-- diferencia (deseado - calculado), ACTIVO, con autor (tg_forzar_autor) y
-- bitacora (tg_bitacora). Nada existente se edita ni se borra.
--
-- POR QUE TIPOS NUEVOS Y NO LOS QUE YA HAY (investigado antes de escribir):
--   * Inventario: no hay tipo de ajuste. El conteo fisico (20260912120000) NO
--     ajusta el libro a proposito. MERMA solo resta; ENTRADA_COMPRA/PRODUCCION
--     ensucian compras, costos y envasados.
--   * Finanzas: SALDO_INICIAL es el arranque. No sirve: (1) `tg_cuenta_solo_egresos`
--     lo rechaza hacia la Cuenta Gilberto (solo_egresos), o sea que esa cuenta no
--     se podria corregir; (2) `corteDeArranque`, el modal de cuenta y
--     `Movimientos.tsx` lo tratan como "saldo de arranque" y lo esconden o lo
--     suman como arranque.
--
-- EL DISENO: un tipo por ledger, con CANTIDAD/MONTO CON SIGNO.
--   * `AJUSTE_INVENTARIO`: va en la lista de ENTRADAS (suma en el destino) con
--     `id_entidad_destino` = la entidad cuyo stock se corrige, `id_entidad_origen`
--     NULL y la cubeta que se corrige. Cantidad negativa = baja el stock. Asi
--     TODO lo que suma por destino (v_stock_por_cubeta, stock_de_insumos,
--     v_insumos_en_negativo y sus espejos en TypeScript) lo cuenta bien sin una
--     rama especial.
--   * `AJUSTE_SALDO`: va en la lista de INGRESOS de `saldo_cuenta` (suma en
--     `id_cuenta_destino`), origen NULL. Monto negativo = baja el saldo. NO es
--     ingreso ni egreso del negocio: `v_movimiento_clasificado` no lo marca
--     (es_ingreso_admin solo INGRESO_VENTA/ABONO_DEUDA; es_egreso_admin solo
--     GASTO/EGRESO/CARGO/...), asi que no toca resumenes, cartera ni IVA.
--   * La forma (un solo lado, distinto de cero) la exige un CHECK.
--   * Solo un ADMIN escribe o anula un ajuste: trigger `tg_ajuste_solo_admin`
--     (el RLS deja insertar a un DST en sus entidades y anular en 12 h).
--
-- LA ESCRITURA: dos RPC SECURITY INVOKER (RLS y triggers de autor de quien
-- llama) que validan ADMIN, toman un LOCK de la tabla en SHARE ROW EXCLUSIVE
-- (espera a las capturas en vuelo del bot y las detiene hasta el COMMIT),
-- recalculan el valor actual y RECHAZAN si no es el que el usuario vio.
--
-- ROLLBACK (solo si no hay filas de ajuste):
--   DROP FUNCTION public.ajustar_inventario(uuid, uuid, text, numeric, numeric, text);
--   DROP FUNCTION public.ajustar_saldo_cuenta(uuid, numeric, numeric, text);
--   DROP FUNCTION public.stock_ajustable();
--   DROP FUNCTION public.stock_en_cubeta(uuid, uuid, text);
--   DROP TRIGGER trg_ajuste_solo_admin_inv ON public.inventario_ledger;
--   DROP TRIGGER trg_ajuste_solo_admin_fin ON public.finanzas_ledger;
--   DROP FUNCTION public.tg_ajuste_solo_admin();
--   y re-aplicar las definiciones anteriores de los CHECK, v_stock_por_cubeta
--   (20261029120100), v_insumos_en_negativo (20260918015908), stock_de_insumos
--   (20260923075244), saldo_cuenta (20261028120100) y v_transferencias_resumen
--   (20261028120300) y v_cartera (20261029120000).
-- ============================================================================


-- ─── 1. INVENTARIO: el tipo, la entidad obligatoria y la forma ──────────────

ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_tipo_movimiento_check;
ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_tipo_movimiento_check
  CHECK (tipo_movimiento IN (
    'ENTRADA_COMPRA', 'SALIDA_VENTA', 'PRODUCCION', 'MERMA', 'TRASPASO',
    'ANULADO', 'ENTRADA_CONCESION', 'SALIDA_CONCESION', 'LIQUIDACION_INTERNA',
    'DEVOLUCION_FISICA', 'INGRESO_TRASPASO', 'EGRESO_TRASPASO',
    'AJUSTE_INVENTARIO'
  ));

ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_entidad_obligatoria;
ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_entidad_obligatoria
  CHECK (
    CASE
      WHEN tipo_movimiento = 'DEVOLUCION_FISICA'
        THEN id_entidad_origen IS NOT NULL AND id_entidad_destino IS NOT NULL
      WHEN tipo_movimiento IN ('ENTRADA_COMPRA', 'PRODUCCION', 'INGRESO_TRASPASO', 'ENTRADA_CONCESION', 'AJUSTE_INVENTARIO')
        THEN id_entidad_destino IS NOT NULL
      WHEN tipo_movimiento IN ('SALIDA_VENTA', 'MERMA', 'TRASPASO', 'EGRESO_TRASPASO', 'SALIDA_CONCESION')
        THEN id_entidad_origen IS NOT NULL
      ELSE false
    END
  );

-- Un ajuste es de UNA entidad (destino), sin origen, y mueve algo.
ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_ajuste_forma;
ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_ajuste_forma
  CHECK (
    tipo_movimiento <> 'AJUSTE_INVENTARIO'
    OR (id_entidad_origen IS NULL AND id_entidad_destino IS NOT NULL AND cantidad <> 0)
  );


-- ─── 2. INVENTARIO: las lecturas aprenden el tipo (lista de ENTRADAS) ───────
-- Copia de 20261029120100 con AJUSTE_INVENTARIO en la lista de entradas.

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
             WHEN il.id_entidad_destino = e.id AND il.tipo_movimiento::text = ANY (ARRAY['ENTRADA_COMPRA','PRODUCCION','DEVOLUCION_FISICA','INGRESO_TRASPASO','ENTRADA_CONCESION','AJUSTE_INVENTARIO'])
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

-- Copia de 20260918015908 con AJUSTE_INVENTARIO en la lista de entradas.
create or replace view public.v_insumos_en_negativo
with (security_invoker = true) as
with movimientos as (
  select
    e.id     as id_entidad,
    e.nombre as entidad,
    il.id_producto,
    case
      when il.id_entidad_destino = e.id
       and il.tipo_movimiento::text = any (array[
             'ENTRADA_COMPRA','PRODUCCION','DEVOLUCION_FISICA',
             'INGRESO_TRASPASO','ENTRADA_CONCESION','AJUSTE_INVENTARIO'])
      then il.cantidad
      else 0::numeric
    end as entrada,
    case
      when il.id_entidad_origen = e.id
       and il.tipo_movimiento::text = any (array[
             'SALIDA_VENTA','MERMA','TRASPASO','EGRESO_TRASPASO',
             'SALIDA_CONCESION','DEVOLUCION_FISICA'])
      then il.cantidad
      else 0::numeric
    end as salida
  from inventario_ledger il
    join entidades e
      on e.id = il.id_entidad_destino or e.id = il.id_entidad_origen
  where il.status = any (array['ACTIVO','APPROVED'])
)
select
  m.id_entidad,
  m.entidad,
  m.id_producto,
  p.sku,
  p.nombre        as insumo,
  p.unidad_medida,
  round(sum(m.entrada), 4)                     as capturado_entradas,
  round(sum(m.salida), 4)                      as consumido,
  round(sum(m.entrada) - sum(m.salida), 4)     as stock,
  round(sum(m.salida) - sum(m.entrada), 4)     as faltante
from movimientos m
  join catalogo_productos p on p.id = m.id_producto
where p.tipo = 'INSUMO'
group by m.id_entidad, m.entidad, m.id_producto, p.sku, p.nombre, p.unidad_medida
having round(sum(m.entrada) - sum(m.salida), 4) < 0;

-- Copia de 20260923075244 con AJUSTE_INVENTARIO en la lista de entradas. Es la
-- que decide si alcanza el empaque para envasar.
create or replace function public.stock_de_insumos(p_id_entidad uuid, p_ids uuid[])
returns table (id_producto uuid, stock numeric)
language sql stable
as $$
  select il.id_producto,
         round(sum(
           case
             when il.id_entidad_destino = p_id_entidad and il.tipo_movimiento::text = any (array[
               'ENTRADA_COMPRA', 'PRODUCCION', 'DEVOLUCION_FISICA', 'INGRESO_TRASPASO', 'ENTRADA_CONCESION', 'AJUSTE_INVENTARIO'])
               then il.cantidad
             else 0::numeric
           end
           -
           case
             when il.id_entidad_origen = p_id_entidad and il.tipo_movimiento::text = any (array[
               'SALIDA_VENTA', 'MERMA', 'TRASPASO', 'EGRESO_TRASPASO', 'SALIDA_CONCESION', 'DEVOLUCION_FISICA'])
               then il.cantidad
             else 0::numeric
           end), 4) as stock
  from public.inventario_ledger il
  where il.id_producto = any (p_ids)
    and il.status in ('ACTIVO', 'APPROVED')
    and (il.id_entidad_destino = p_id_entidad or il.id_entidad_origen = p_id_entidad)
  group by il.id_producto
$$;

revoke all on function public.stock_de_insumos(uuid, uuid[]) from public, anon;
grant execute on function public.stock_de_insumos(uuid, uuid[]) to authenticated, service_role;


-- ─── 3. FINANZAS: el tipo, la forma y el saldo ──────────────────────────────

ALTER TABLE public.finanzas_ledger
  DROP CONSTRAINT IF EXISTS finanzas_ledger_tipo_movimiento_check;
ALTER TABLE public.finanzas_ledger
  ADD CONSTRAINT finanzas_ledger_tipo_movimiento_check CHECK (tipo_movimiento::text = ANY (ARRAY[
    'INGRESO_VENTA', 'GASTO_OPERATIVO', 'ABONO_DEUDA', 'INGRESO_COMISION', 'DEUDA_A_MATRIZ',
    'COMISION_PASIVA', 'PASIVO_IVA', 'PASIVO_IEPS', 'EGRESO_TRASPASO', 'INGRESO_TRASPASO',
    'SUBSIDIO_FISCAL', 'CARGO_DEUDA', 'COMPRA_INSUMOS', 'MERMA', 'DEVOLUCION',
    'SALDO_INICIAL', 'AJUSTE_SALDO'
  ]::text[]));

ALTER TABLE public.finanzas_ledger
  DROP CONSTRAINT IF EXISTS finanzas_ledger_ajuste_forma;
ALTER TABLE public.finanzas_ledger
  ADD CONSTRAINT finanzas_ledger_ajuste_forma
  CHECK (
    tipo_movimiento IS DISTINCT FROM 'AJUSTE_SALDO'
    OR (id_cuenta_destino IS NOT NULL AND id_cuenta_origen IS NULL AND monto <> 0)
  );

-- Saldo de una cuenta. Misma regla que getLiquidezPorCuenta y lib/v2/dinero.ts:
--   entra:  INGRESO_VENTA, ABONO_DEUDA, INGRESO_TRASPASO, SALDO_INICIAL, AJUSTE_SALDO
--           (por id_cuenta_destino; AJUSTE_SALDO trae signo)
--   sale:   GASTO_OPERATIVO, CARGO_DEUDA, SUBSIDIO_FISCAL, COMPRA_INSUMOS, EGRESO_TRASPASO
--           (por COALESCE(id_cuenta_origen, id_cuenta_destino))
--   solo filas contables (status ACTIVO/APPROVED, categoria distinta de ABONO_PENDIENTE).
CREATE OR REPLACE FUNCTION public.saldo_cuenta(p_id_cuenta uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE(SUM(
           CASE
             WHEN f.tipo_movimiento IN ('INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO', 'SALDO_INICIAL', 'AJUSTE_SALDO')
                  AND f.id_cuenta_destino = p_id_cuenta THEN f.monto
             WHEN f.tipo_movimiento IN ('GASTO_OPERATIVO', 'CARGO_DEUDA', 'SUBSIDIO_FISCAL',
                                        'COMPRA_INSUMOS', 'EGRESO_TRASPASO')
                  AND COALESCE(f.id_cuenta_origen, f.id_cuenta_destino) = p_id_cuenta THEN -f.monto
             ELSE 0
           END), 0)::numeric(14,2)
    FROM public.finanzas_ledger f
   WHERE (f.id_cuenta_destino = p_id_cuenta OR f.id_cuenta_origen = p_id_cuenta)
     AND f.status IN ('ACTIVO', 'APPROVED')
     AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE';
$$;

REVOKE ALL ON FUNCTION public.saldo_cuenta(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.saldo_cuenta(uuid) TO authenticated, service_role;

-- Copia de 20261028120300 con AJUSTE_SALDO en `recibidas`: asi "por convertir"
-- (recibido - convertido) sigue al saldo corregido y no ofrece convertir dinero
-- que el ajuste quito (el monto del ajuste trae signo).
CREATE OR REPLACE VIEW public.v_transferencias_resumen
WITH (security_invoker = true) AS
WITH cuentas AS (
  SELECT c.id, c.nombre FROM public.cuentas_financieras c WHERE c.clase = 'TRANSFERENCIAS'
),
recibidas AS (
  SELECT f.id_cuenta_destino AS id_cuenta, f.id, f.fecha_movimiento, f.monto,
         SUM(f.monto) OVER (PARTITION BY f.id_cuenta_destino
                            ORDER BY f.fecha_movimiento, f.id) AS acumulado
    FROM public.finanzas_ledger f
    JOIN cuentas c ON c.id = f.id_cuenta_destino
   WHERE f.tipo_movimiento IN ('INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO', 'SALDO_INICIAL', 'AJUSTE_SALDO')
     AND f.status IN ('ACTIVO', 'APPROVED')
     AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
),
convertidas AS (
  SELECT k.id_cuenta_origen AS id_cuenta, COUNT(*) AS n, SUM(k.monto) AS monto,
         SUM(k.comision) AS comision, SUM(k.neto) AS neto
    FROM public.conversiones_transferencia k
   WHERE k.status = 'ACTIVO'
   GROUP BY k.id_cuenta_origen
)
SELECT c.id AS id_cuenta,
       c.nombre AS cuenta,
       COUNT(r.id)::int                                  AS recibidas_n,
       COALESCE(SUM(r.monto), 0)::numeric(14,2)          AS recibido_monto,
       COALESCE(MAX(k.n), 0)::int                        AS conversiones_n,
       COALESCE(MAX(k.monto), 0)::numeric(14,2)          AS convertido_monto,
       COALESCE(MAX(k.comision), 0)::numeric(14,2)       AS comision_monto,
       COALESCE(MAX(k.neto), 0)::numeric(14,2)           AS neto_a_efectivo,
       COUNT(r.id) FILTER (WHERE r.acumulado > COALESCE(k.monto, 0))::int AS pendientes_n,
       (COALESCE(SUM(r.monto), 0) - COALESCE(MAX(k.monto), 0))::numeric(14,2) AS pendiente_monto,
       public.saldo_cuenta(c.id)                         AS saldo_cuenta
  FROM cuentas c
  LEFT JOIN recibidas r ON r.id_cuenta = c.id
  LEFT JOIN convertidas k ON k.id_cuenta = c.id
 GROUP BY c.id, c.nombre;

REVOKE ALL ON public.v_transferencias_resumen FROM anon;
GRANT SELECT ON public.v_transferencias_resumen TO authenticated, service_role;


-- ─── 4. SOLO EL ADMIN ESCRIBE O ANULA UN AJUSTE ─────────────────────────────
-- El RLS deja a un DST insertar en sus entidades (inventario_ins_dst) y anular en
-- 12 h (tg_vigilar_update_no_admin). Un ajuste es otra cosa: solo ADMIN, sin
-- excepcion para service_role (el bot nunca escribe ajustes).

CREATE OR REPLACE FUNCTION public.tg_ajuste_solo_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_tipo_ajuste text := CASE TG_TABLE_NAME
                          WHEN 'inventario_ledger' THEN 'AJUSTE_INVENTARIO'
                          ELSE 'AJUSTE_SALDO'
                        END;
  v_toca boolean := NEW.tipo_movimiento = v_tipo_ajuste;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_toca := v_toca OR OLD.tipo_movimiento = v_tipo_ajuste;
  END IF;
  IF COALESCE(v_toca, false) AND public.mi_rol() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'Solo un ADMIN registra o anula un % (rol de la sesion: %)',
      v_tipo_ajuste, COALESCE(public.mi_rol(), 'sin sesion')
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.tg_ajuste_solo_admin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ajuste_solo_admin_inv ON public.inventario_ledger;
CREATE TRIGGER trg_ajuste_solo_admin_inv
  BEFORE INSERT OR UPDATE ON public.inventario_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_ajuste_solo_admin();

DROP TRIGGER IF EXISTS trg_ajuste_solo_admin_fin ON public.finanzas_ledger;
CREATE TRIGGER trg_ajuste_solo_admin_fin
  BEFORE INSERT OR UPDATE ON public.finanzas_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_ajuste_solo_admin();


-- ─── 5. LECTURA: el stock por entidad, producto y cubeta ────────────────────
-- La MISMA regla de v_stock_por_cubeta (lista de tipos y cubeta de la
-- devolucion), sin sus dos recortes: aqui entran los INSUMOS y los stocks en 0
-- o negativos, porque eso es justo lo que se corrige. Ademas, cada producto del
-- catalogo aparece en el PAGADO de cada entidad ADMIN aunque no tenga
-- movimientos (para poder darle su primer stock).

CREATE OR REPLACE FUNCTION public.stock_ajustable()
RETURNS TABLE (
  id_entidad uuid, entidad text, rol text,
  id_producto uuid, producto text, sku text, tipo_producto text, unidad_medida text,
  cubeta text, stock numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  WITH movimientos AS (
    SELECT e.id AS id_entidad,
           il.id_producto,
           CASE
             WHEN il.tipo_movimiento::text = 'DEVOLUCION_FISICA' AND il.id_entidad_destino = e.id THEN 'PAGADO'
             WHEN il.cubeta = 'CONSIGNADO' THEN 'CONSIGNADO'
             ELSE 'PAGADO'
           END AS cubeta,
           CASE
             WHEN il.id_entidad_destino = e.id AND il.tipo_movimiento::text = ANY (ARRAY['ENTRADA_COMPRA','PRODUCCION','DEVOLUCION_FISICA','INGRESO_TRASPASO','ENTRADA_CONCESION','AJUSTE_INVENTARIO'])
               THEN il.cantidad
             WHEN il.id_entidad_origen = e.id AND il.tipo_movimiento::text = ANY (ARRAY['SALIDA_VENTA','MERMA','TRASPASO','EGRESO_TRASPASO','SALIDA_CONCESION','DEVOLUCION_FISICA'])
               THEN - il.cantidad
             ELSE 0::numeric
           END AS delta
      FROM inventario_ledger il
      JOIN entidades e ON e.id = il.id_entidad_destino OR e.id = il.id_entidad_origen
     WHERE il.status = ANY (ARRAY['ACTIVO','APPROVED'])
  ),
  sumado AS (
    SELECT m.id_entidad, m.id_producto, m.cubeta, round(sum(m.delta), 4) AS stock
      FROM movimientos m
     GROUP BY m.id_entidad, m.id_producto, m.cubeta
  ),
  base_matriz AS (
    SELECT e.id AS id_entidad, p.id AS id_producto, 'PAGADO'::text AS cubeta, 0::numeric AS stock
      FROM entidades e CROSS JOIN catalogo_productos p
     WHERE e.rol = 'ADMIN'
  ),
  todo AS (
    SELECT * FROM sumado
    UNION ALL
    SELECT b.* FROM base_matriz b
     WHERE NOT EXISTS (SELECT 1 FROM sumado s
                        WHERE s.id_entidad = b.id_entidad AND s.id_producto = b.id_producto
                          AND s.cubeta = b.cubeta)
  )
  SELECT t.id_entidad, e.nombre::text, e.rol::text,
         t.id_producto, p.nombre::text, p.sku::text, p.tipo::text, p.unidad_medida::text,
         t.cubeta, t.stock
    FROM todo t
    JOIN entidades e ON e.id = t.id_entidad
    JOIN catalogo_productos p ON p.id = t.id_producto
   ORDER BY (e.rol <> 'ADMIN'), e.nombre, (p.tipo::text <> 'TERMINADO'), p.nombre, t.cubeta;
$$;
REVOKE ALL ON FUNCTION public.stock_ajustable() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_ajustable() TO authenticated, service_role;

-- El stock de UNA celda (entidad, producto, cubeta), con la misma regla.
CREATE OR REPLACE FUNCTION public.stock_en_cubeta(p_id_entidad uuid, p_id_producto uuid, p_cubeta text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT COALESCE(round(sum(
           CASE
             WHEN il.id_entidad_destino = p_id_entidad AND il.tipo_movimiento::text = ANY (ARRAY['ENTRADA_COMPRA','PRODUCCION','DEVOLUCION_FISICA','INGRESO_TRASPASO','ENTRADA_CONCESION','AJUSTE_INVENTARIO'])
               THEN il.cantidad
             WHEN il.id_entidad_origen = p_id_entidad AND il.tipo_movimiento::text = ANY (ARRAY['SALIDA_VENTA','MERMA','TRASPASO','EGRESO_TRASPASO','SALIDA_CONCESION','DEVOLUCION_FISICA'])
               THEN - il.cantidad
             ELSE 0::numeric
           END), 4), 0)
    FROM inventario_ledger il
   WHERE il.id_producto = p_id_producto
     AND il.status = ANY (ARRAY['ACTIVO','APPROVED'])
     AND (il.id_entidad_destino = p_id_entidad OR il.id_entidad_origen = p_id_entidad)
     AND (CASE
            WHEN il.tipo_movimiento::text = 'DEVOLUCION_FISICA' AND il.id_entidad_destino = p_id_entidad THEN 'PAGADO'
            WHEN il.cubeta = 'CONSIGNADO' THEN 'CONSIGNADO'
            ELSE 'PAGADO'
          END) = p_cubeta;
$$;
REVOKE ALL ON FUNCTION public.stock_en_cubeta(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_en_cubeta(uuid, uuid, text) TO authenticated, service_role;


-- ─── 6. ESCRITURA: los dos ajustes, atomicos ────────────────────────────────

CREATE OR REPLACE FUNCTION public.ajustar_inventario(
  p_id_entidad  uuid,
  p_id_producto uuid,
  p_cubeta      text,
  p_valor_visto numeric,
  p_valor_nuevo numeric,
  p_motivo      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_motivo  text := btrim(COALESCE(p_motivo, ''));
  v_visto   numeric := round(p_valor_visto, 4);
  v_nuevo   numeric := round(p_valor_nuevo, 4);
  v_actual  numeric;
  v_dif     numeric;
  v_final   numeric;
  v_id      uuid;
  v_ent     text;
  v_prod    text;
BEGIN
  IF public.mi_rol() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'Solo un ADMIN corrige inventario' USING ERRCODE = '42501';
  END IF;
  IF length(v_motivo) < 5 THEN
    RAISE EXCEPTION 'El motivo es obligatorio (minimo 5 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_cubeta IS NULL OR p_cubeta NOT IN ('PAGADO', 'CONSIGNADO') THEN
    RAISE EXCEPTION 'Cubeta invalida: %', p_cubeta USING ERRCODE = 'check_violation';
  END IF;
  IF v_visto IS NULL OR v_nuevo IS NULL THEN
    RAISE EXCEPTION 'Faltan el valor visto o el valor nuevo' USING ERRCODE = 'check_violation';
  END IF;
  IF v_nuevo < 0 THEN
    RAISE EXCEPTION 'El stock no puede quedar negativo (%)', v_nuevo USING ERRCODE = 'check_violation';
  END IF;

  SELECT nombre INTO v_ent FROM public.entidades WHERE id = p_id_entidad;
  IF v_ent IS NULL THEN
    RAISE EXCEPTION 'La entidad % no existe', p_id_entidad USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT nombre INTO v_prod FROM public.catalogo_productos WHERE id = p_id_producto;
  IF v_prod IS NULL THEN
    RAISE EXCEPTION 'El producto % no esta registrado', p_id_producto USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Espera a las capturas en vuelo (bot, POS) y frena las nuevas hasta el COMMIT:
  -- el valor que se lee abajo es el que habra cuando se escriba el ajuste.
  LOCK TABLE public.inventario_ledger IN SHARE ROW EXCLUSIVE MODE;

  v_actual := public.stock_en_cubeta(p_id_entidad, p_id_producto, p_cubeta);
  IF v_actual <> v_visto THEN
    RAISE EXCEPTION 'CAMBIO_CONCURRENTE: el stock de % / % (%) es % y tu viste %. Recarga y vuelve a confirmar.',
      v_prod, v_ent, p_cubeta, trim_scale(v_actual), trim_scale(v_visto)
      USING ERRCODE = '40001';
  END IF;

  v_dif := v_nuevo - v_actual;
  IF v_dif = 0 THEN
    RAISE EXCEPTION 'SIN_CAMBIO: el stock ya es %', trim_scale(v_actual) USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.inventario_ledger
    (id_producto, tipo_movimiento, cantidad, id_entidad_origen, id_entidad_destino,
     cubeta, status, costo_unitario_movimiento, fecha_movimiento, notas)
  VALUES
    (p_id_producto, 'AJUSTE_INVENTARIO', v_dif, NULL, p_id_entidad,
     p_cubeta, 'ACTIVO', 0, now(),
     format('AJUSTE ADMIN %s: %s -> %s (dif %s). Motivo: %s',
            p_cubeta, trim_scale(v_actual), trim_scale(v_nuevo), trim_scale(v_dif), v_motivo))
  RETURNING id INTO v_id;

  v_final := public.stock_en_cubeta(p_id_entidad, p_id_producto, p_cubeta);
  IF v_final <> v_nuevo THEN
    RAISE EXCEPTION 'El ajuste no cuadra: quedo % y se pidio %', v_final, v_nuevo;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'anterior', v_actual, 'nuevo', v_final, 'diferencia', v_dif);
END
$$;
REVOKE ALL ON FUNCTION public.ajustar_inventario(uuid, uuid, text, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_inventario(uuid, uuid, text, numeric, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.ajustar_saldo_cuenta(
  p_id_cuenta   uuid,
  p_saldo_visto numeric,
  p_saldo_nuevo numeric,
  p_motivo      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_motivo  text := btrim(COALESCE(p_motivo, ''));
  v_visto   numeric := round(p_saldo_visto, 2);
  v_nuevo   numeric := round(p_saldo_nuevo, 2);
  v_actual  numeric;
  v_dif     numeric;
  v_final   numeric;
  v_id      uuid;
  v_cuenta  text;
  v_entidad uuid;
BEGIN
  IF public.mi_rol() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'Solo un ADMIN corrige saldos' USING ERRCODE = '42501';
  END IF;
  IF length(v_motivo) < 5 THEN
    RAISE EXCEPTION 'El motivo es obligatorio (minimo 5 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  IF v_visto IS NULL OR v_nuevo IS NULL THEN
    RAISE EXCEPTION 'Faltan el saldo visto o el saldo nuevo' USING ERRCODE = 'check_violation';
  END IF;

  SELECT nombre, id_entidad INTO v_cuenta, v_entidad
    FROM public.cuentas_financieras WHERE id = p_id_cuenta;
  IF v_cuenta IS NULL THEN
    RAISE EXCEPTION 'La cuenta % no existe', p_id_cuenta USING ERRCODE = 'foreign_key_violation';
  END IF;

  LOCK TABLE public.finanzas_ledger IN SHARE ROW EXCLUSIVE MODE;

  v_actual := public.saldo_cuenta(p_id_cuenta);
  IF v_actual <> v_visto THEN
    RAISE EXCEPTION 'CAMBIO_CONCURRENTE: el saldo de % es % y tu viste %. Recarga y vuelve a confirmar.',
      v_cuenta, v_actual, v_visto
      USING ERRCODE = '40001';
  END IF;

  v_dif := v_nuevo - v_actual;
  IF v_dif = 0 THEN
    RAISE EXCEPTION 'SIN_CAMBIO: el saldo ya es %', v_actual USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.finanzas_ledger
    (tipo_movimiento, monto, categoria, descripcion, id_cuenta_origen, id_cuenta_destino,
     id_entidad_relacionada, fecha_movimiento, status)
  VALUES
    ('AJUSTE_SALDO', v_dif, 'AJUSTE',
     format('AJUSTE ADMIN de saldo: %s -> %s (dif %s). Motivo: %s', v_actual, v_nuevo, v_dif, v_motivo),
     NULL, p_id_cuenta, v_entidad, now(), 'ACTIVO')
  RETURNING id INTO v_id;

  v_final := public.saldo_cuenta(p_id_cuenta);
  IF v_final <> v_nuevo THEN
    RAISE EXCEPTION 'El ajuste no cuadra: quedo % y se pidio %', v_final, v_nuevo;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'anterior', v_actual, 'nuevo', v_final, 'diferencia', v_dif);
END
$$;
REVOKE ALL ON FUNCTION public.ajustar_saldo_cuenta(uuid, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_saldo_cuenta(uuid, numeric, numeric, text) TO authenticated;


-- ─── 7. CARTERA: «libro dice» sigue al ajuste del ADMIN ─────────────────────
-- Copia de 20261029120000 (v_cartera con id_acreedor) con UN cambio: el
-- AJUSTE_INVENTARIO hacia el nodo (destino = nodo, cantidad con signo) entra a
-- `libro_dice` = recibidas - salidas + ajustes. NO entra a `recibidas`: esas son
-- piezas entregadas en concesion y mueven estimado_en_piso y el filtro de nodos;
-- un ajuste no es una entrega. Mismas columnas y mismo orden (CREATE OR REPLACE).
-- Espejo TypeScript: lib/cartera-utils.ts (construirCartera). Rollback: re-aplicar
-- 20261029120000_v2_cartera_acreedor.sql.

CREATE OR REPLACE VIEW public.v_cartera WITH (security_invoker = true) AS
WITH inventario_vivo AS (
  SELECT
    il.tipo_movimiento,
    abs(il.cantidad) AS cantidad,
    il.cantidad      AS cantidad_con_signo,  -- 2026-11-03: el AJUSTE_INVENTARIO trae signo
    il.id_entidad_origen,
    il.id_entidad_destino,
    il.fecha_movimiento
  FROM public.inventario_ledger il
  WHERE COALESCE(il.status, 'ACTIVO') <> 'ANULADO'
),
piso AS (
  SELECT
    e.id AS id_entidad,
    COALESCE(SUM(CASE WHEN iv.id_entidad_destino = e.id
                       AND iv.tipo_movimiento = 'ENTRADA_CONCESION'
                      THEN iv.cantidad ELSE 0 END), 0) AS recibidas,
    COALESCE(SUM(CASE WHEN iv.id_entidad_origen = e.id
                      THEN iv.cantidad ELSE 0 END), 0) AS salidas,
    MAX(CASE WHEN iv.id_entidad_destino = e.id
              AND iv.tipo_movimiento = 'ENTRADA_CONCESION'
             THEN iv.fecha_movimiento END)             AS ultima_entrega,
    -- 2026-11-03: correccion del ADMIN sobre el stock del nodo (cualquier cubeta), con signo.
    COALESCE(SUM(CASE WHEN iv.id_entidad_destino = e.id
                       AND iv.tipo_movimiento = 'AJUSTE_INVENTARIO'
                      THEN iv.cantidad_con_signo ELSE 0 END), 0) AS ajustes
  FROM public.entidades e
  LEFT JOIN inventario_vivo iv
    ON iv.id_entidad_destino = e.id
    OR iv.id_entidad_origen  = e.id
  WHERE e.rol IN ('DST', 'LOC')
  GROUP BY e.id
),
finanzas_cartera AS (
  -- [OJO] Aqui el filtro es `<> 'ANULADO'`, no `IN ('ACTIVO','APPROVED')`.
  SELECT
    fl.id_entidad_relacionada,
    fl.tipo_movimiento,
    fl.monto,
    fl.categoria,
    fl.fecha_movimiento
  FROM public.finanzas_ledger fl
  WHERE COALESCE(fl.status, 'ACTIVO') <> 'ANULADO'
    AND NOT fl.es_entrega_efectivo  -- D112: la entrega de efectivo NO es abono de concesion
),
deuda_tickets AS (
  SELECT
    tk.id_comprador AS id_entidad,
    SUM(CASE WHEN e.rol = 'DST' THEN tk.monto_base_ingreso ELSE tk.total_cobrado_real END) AS monto
  FROM public.transacciones_tickets tk
  JOIN public.entidades e ON e.id = tk.id_comprador
  WHERE COALESCE(tk.status, 'ACTIVO') <> 'ANULADO'
    AND tk.condicion_pago = 'CONCESION'
  GROUP BY tk.id_comprador
),
ajustes AS (
  SELECT
    f.id_entidad_relacionada AS id_entidad,
    SUM(CASE WHEN f.tipo_movimiento = 'CARGO_DEUDA' THEN f.monto ELSE 0 END) AS cargo_deuda,
    SUM(CASE WHEN f.tipo_movimiento = 'ABONO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN f.monto ELSE 0 END) AS abonado,
    MAX(CASE WHEN f.tipo_movimiento = 'ABONO_DEUDA'
              AND f.categoria IS DISTINCT FROM 'ABONO_PENDIENTE'
             THEN f.fecha_movimiento END) AS ultimo_abono
  FROM finanzas_cartera f
  WHERE f.id_entidad_relacionada IS NOT NULL
  GROUP BY f.id_entidad_relacionada
),
base AS (
  SELECT
    e.id      AS id_entidad,
    e.nombre,
    e.rol,
    p.recibidas,
    p.salidas,
    p.ultima_entrega,
    p.ajustes,
    COALESCE(dt.monto, 0) + COALESCE(aj.cargo_deuda, 0) - COALESCE(aj.abonado, 0) AS deuda,
    COALESCE(aj.abonado, 0) AS abonado,
    aj.ultimo_abono,
    -- v2: con quien es la deuda. NULL = la matriz; si no, el padre en la red
    -- (el DST que le entrego). Misma regla que cargar_arranque.py y la conciliacion.
    COALESCE(e.id_nodo_padre, e.id_padre) AS id_acreedor
  FROM public.entidades e
  JOIN piso p               ON p.id_entidad = e.id
  LEFT JOIN deuda_tickets dt ON dt.id_entidad = e.id
  LEFT JOIN ajustes       aj ON aj.id_entidad = e.id
  WHERE e.rol IN ('DST', 'LOC')
    AND p.recibidas > 0
),
calculada AS (
  SELECT
    b.*,
    b.deuda + b.abonado AS generado,
    CASE WHEN b.deuda + b.abonado > 0 THEN b.abonado / (b.deuda + b.abonado) END AS porcentaje_pagado,
    COALESCE(b.ultimo_abono, b.ultima_entrega) AS referencia_fecha,
    CASE
      WHEN b.ultimo_abono   IS NOT NULL THEN 'ABONO'
      WHEN b.ultima_entrega IS NOT NULL THEN 'ENTREGA'
      ELSE 'NINGUNA'
    END AS referencia_dias
  FROM base b
),
con_dias AS (
  SELECT
    c.*,
    CASE
      WHEN c.referencia_fecha IS NULL THEN NULL
      ELSE GREATEST(0, (
        (now() AT TIME ZONE 'America/Mexico_City')::date
        - (c.referencia_fecha AT TIME ZONE 'America/Mexico_City')::date
      ))
    END AS dias_sin_abono
  FROM calculada c
)
SELECT
  id_entidad,
  nombre,
  rol,
  recibidas,
  salidas,
  recibidas - salidas + ajustes           AS libro_dice,
  ROUND(generado, 2)                      AS generado,
  ROUND(abonado, 2)                       AS abonado,
  porcentaje_pagado,
  -- porcentajePagado === null ? recibidas : Math.max(0, Math.round(recibidas * (1 - pct)))
  CASE
    WHEN porcentaje_pagado IS NULL THEN recibidas
    ELSE GREATEST(0, ROUND(recibidas * (1 - porcentaje_pagado)))
  END                                     AS estimado_en_piso,
  ROUND(deuda, 2)                         AS deuda,
  ultimo_abono,
  dias_sin_abono,
  referencia_dias,
  -- prioridad = deuda > 0 ? deuda * dias : 0. Es el orden de visita.
  CASE WHEN deuda > 0 THEN ROUND(deuda * COALESCE(dias_sin_abono, 0), 2) ELSE 0 END AS prioridad,
  now()                                   AS calculado_en,
  id_acreedor
FROM con_dias;
