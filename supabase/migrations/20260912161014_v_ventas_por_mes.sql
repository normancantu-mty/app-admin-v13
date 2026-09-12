-- ============================================================================
-- La venta mes contra mes, que el ERP registraba desde mayo y nadie veia
-- ============================================================================
-- POR QUE EXISTE. El 2026-09-12, para contestar *"como van las ventas"*, hubo
-- que escribir SQL a mano contra produccion. El dato llevaba **cuatro meses**
-- en la base y no habia una sola pantalla que lo enseñara. La caida estaba
-- ahi desde junio y nadie la habia visto.
--
-- ─── EL DEFECTO QUE ESTA VISTA EXISTE PARA MATAR ────────────────────────────
--
-- Al medirlo a mano, la primera pasada agrupo `fecha_transaccion` —que es
-- `timestamptz`— **sin convertir a hora de Mexico**, o sea en UTC. Una venta de
-- las 7 de la tarde del 31 de julio en Fresnillo **cae en agosto** para UTC.
--
-- Resultado de esa pasada, contra el correcto:
--
--   | mes | UTC (mal)  | Mexico (bien) |
--   |-----|------------|---------------|
--   | jul | $92,159    | $108,703      |
--   | ago | $85,970    | $73,842       |
--   | sep | $18,840    | $14,424       |
--
-- **El gran total era identico en las dos** ($400,625.00), que es exactamente
-- lo que hace invisible el error: la cifra de control cuadra y los meses estan
-- mal. El nombre en ingles es **timezone-dependent bucketing**.
--
-- Aqui la conversion esta escrita UNA vez, en la vista, y ya no se puede
-- olvidar: es el mismo motivo por el que existen las otras cinco vistas
-- canonicas.
--
-- ─── DECISIONES ─────────────────────────────────────────────────────────────
--
--   * **`security_invoker = true`**: cada quien ve las ventas que su RLS le
--     deja ver. Sin esto la vista seria una puerta trasera a las ventas de toda
--     la red para cualquier DST.
--   * **Los ANULADOS quedan fuera.** Un ticket anulado no fue una venta. Si
--     algun dia se quiere medir la tasa de anulacion por mes, va en otra vista:
--     mezclarlas obligaria a cada consumidor a recordar filtrar.
--   * **Sin filtro de fechas.** El periodo lo pone quien consulta, igual que en
--     `v_movimiento_clasificado`.
--
-- ROLLBACK: DROP VIEW public.v_ventas_por_mes;
--
-- COMPROBACION DESPUES DE APLICAR — las dos cifras tienen que ser iguales:
--   SELECT sum(vendido) FROM v_ventas_por_mes;
--   SELECT sum(total_cobrado_real) FROM transacciones_tickets WHERE status='ACTIVO';
-- ============================================================================

CREATE OR REPLACE VIEW public.v_ventas_por_mes
WITH (security_invoker = true) AS
SELECT
  date_trunc('month', t.fecha_transaccion AT TIME ZONE 'America/Mexico_City')::date AS mes,
  count(*)                                                          AS tickets,
  sum(t.total_cobrado_real)                                         AS vendido,
  sum(t.total_cobrado_real) FILTER (WHERE t.condicion_pago = 'CONTADO')   AS vendido_contado,
  sum(t.total_cobrado_real) FILTER (WHERE t.condicion_pago = 'CONCESION') AS vendido_concesion,
  count(*) FILTER (WHERE t.condicion_pago = 'CONCESION')            AS tickets_concesion,
  count(DISTINCT t.id_comprador)                                    AS compradores
FROM public.transacciones_tickets t
WHERE t.status = 'ACTIVO'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW public.v_ventas_por_mes IS
  'Una fila por mes con la venta ACTIVA, agrupada en hora de Mexico (nunca UTC: agrupar en UTC mueve las ventas de la tarde al mes siguiente). Los ANULADOS quedan fuera a proposito: un ticket anulado no fue una venta. La suma de vendido sobre todos los meses debe dar el mismo total que sum(total_cobrado_real) where status=ACTIVO.';

REVOKE ALL ON public.v_ventas_por_mes FROM PUBLIC, anon;
GRANT SELECT ON public.v_ventas_por_mes TO authenticated, service_role;
