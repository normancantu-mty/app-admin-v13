-- v2 LOCAL: verificacion de la simulacion (scripts/v2_simular_ui.mjs + scripts/v2_pruebas_api.py)
-- sobre la carga de arranque en modo `cero`. Escrito el 2026-10-28 por el Socio (ejecutor).
--   docker exec -i supabase_db_app-admin-v2 psql -U postgres -X < scripts/v2_verificar_simulacion.sql
-- Cada fila: prueba | esperado (con su operacion) | obtenido | ok. El esperado sale de la
-- captura y de los montos que tecleo la simulacion, no de la base.
WITH
cta AS (SELECT nombre, id FROM cuentas_financieras WHERE id_entidad = 'e0000000-0000-0000-0000-000000000001'),
sim AS (SELECT * FROM finanzas_ledger WHERE categoria IS DISTINCT FROM 'ARRANQUE'),
tk AS (SELECT t.*, c.nombre AS cuenta FROM transacciones_tickets t LEFT JOIN cuentas_financieras c ON c.id = t.id_cuenta_destino),
stock AS (SELECT e.nombre AS ent, p.sku, v.cubeta, v.stock FROM v_stock_por_cubeta v
          JOIN entidades e ON e.id = v.id_entidad JOIN catalogo_productos p ON p.id = v.id_producto),
pruebas(orden, prueba, esperado, obtenido) AS (
  VALUES
  (1, 'venta efectivo: ticket 2 x 750ml a $599',            1198.00::numeric,
      (SELECT total_cobrado_real FROM tk WHERE cuenta = 'Efectivo' AND condicion_pago = 'CONTADO')),
  (2, 'venta efectivo: IVA+IEPS (cuenta LIBRE)',            0,
      (SELECT impuesto_iva_calculado + impuesto_ieps_calculado FROM tk WHERE cuenta = 'Efectivo' AND condicion_pago = 'CONTADO')),
  (3, 'venta transferencia: 3 x 250ml a $179 en Transferencias', 537.00,
      (SELECT sum(monto) FROM sim WHERE tipo_movimiento = 'INGRESO_VENTA' AND id_cuenta_destino = (SELECT id FROM cta WHERE nombre = 'Transferencias'))),
  (4, 'venta transferencia: pasivos IVA/IEPS generados',    0,
      (SELECT count(*) FROM finanzas_ledger WHERE tipo_movimiento IN ('PASIVO_IVA', 'PASIVO_IEPS'))),
  (5, 'conversion 500: comision 5% = 25.00',                25.00,
      (SELECT comision FROM conversiones_transferencia WHERE monto = 500)),
  (6, 'conversion 500: neto a Efectivo = 475.00',           475.00,
      (SELECT neto FROM conversiones_transferencia WHERE monto = 500)),
  (7, 'conversion 333.33: comision round(16.6665,2) = 16.67', 16.67,
      (SELECT comision FROM conversiones_transferencia WHERE monto = 333.33)),
  (8, 'conversion 333.33: neto 333.33-16.67 = 316.66',      316.66,
      (SELECT neto FROM conversiones_transferencia WHERE monto = 333.33)),
  (9, 'conversiones: gasto Financieros/Comision = 25+16.67', 41.67,
      (SELECT sum(monto) FROM sim WHERE tipo_movimiento = 'GASTO_OPERATIVO' AND categoria = 'Financieros')),
  (10, 'Transferencias: 599+537-500-333.33',                302.67,
      (SELECT public.saldo_cuenta(id) FROM cta WHERE nombre = 'Transferencias')),
  (11, 'metrica: recibidas (saldo inicial + 1 venta)',      2,
      (SELECT recibidas_n FROM v_transferencias_resumen)),
  (12, 'metrica: recibido 599+537',                         1136.00,
      (SELECT recibido_monto FROM v_transferencias_resumen)),
  (13, 'metrica: convertido 500+333.33',                    833.33,
      (SELECT convertido_monto FROM v_transferencias_resumen)),
  (14, 'metrica: pendiente 1136-833.33',                    302.67,
      (SELECT pendiente_monto FROM v_transferencias_resumen)),
  (15, 'metrica: pendientes FIFO (599 ya cubierta; la de 537 no)', 1,
      (SELECT pendientes_n FROM v_transferencias_resumen)),
  (16, 'consignacion Aeropuerto: ticket CONCESION, sin ingreso a caja', 0,
      (SELECT count(*) FROM sim f JOIN tk ON tk.id = f.id_ticket WHERE tk.condicion_pago = 'CONCESION' AND f.tipo_movimiento = 'INGRESO_VENTA')),
  (17, 'consignacion Aeropuerto: 4 entran a su CONSIGNADO, 1 merma -> 3', 3,
      (SELECT stock FROM stock WHERE ent = 'Aeropuerto' AND sku = 'plata-750ml' AND cubeta = 'CONSIGNADO')),
  (18, 'abono Aeropuerto: deuda = ticket concesion - 1000', (SELECT total_cobrado_real - 1000 FROM tk WHERE condicion_pago = 'CONCESION'),
      (SELECT saldo_pendiente_consignacion FROM v_saldo_entidad WHERE nombre = 'Aeropuerto')),
  (19, 'gasto UI Logistica y envios / Gasolina',            350.75,
      (SELECT sum(monto) FROM sim WHERE categoria = 'Logística y envíos' AND subcategoria = 'Gasolina')),
  (20, 'gasto API Servicios / Luz',                         120.40,
      (SELECT sum(monto) FROM sim WHERE categoria = 'Servicios' AND subcategoria = 'Luz')),
  (21, 'compra insumo: Sorbato 3 contado + 2 comprados',    5,
      -- v_stock_por_cubeta solo cubre TERMINADO: para insumos, la suma directa del libro
      (SELECT sum(CASE WHEN il.id_entidad_destino = 'e0000000-0000-0000-0000-000000000001' THEN il.cantidad ELSE -il.cantidad END)
         FROM inventario_ledger il JOIN catalogo_productos p ON p.id = il.id_producto
        WHERE p.sku = 'sorbato-de-potasio' AND il.status IN ('ACTIVO', 'APPROVED'))),
  (22, 'compra insumo: COMPRA_INSUMOS $300 desde Efectivo', 300.00,
      (SELECT sum(monto) FROM sim WHERE tipo_movimiento = 'COMPRA_INSUMOS' AND id_cuenta_origen = (SELECT id FROM cta WHERE nombre = 'Efectivo'))),
  (23, 'bodega 750ml: 27 contado - 2 venta - 4 consignacion', 21,
      (SELECT stock FROM stock WHERE ent = 'CEO Admin' AND sku = 'plata-750ml' AND cubeta = 'PAGADO')),
  (24, 'bodega 250ml: 257 contado - 3 venta',               254,
      (SELECT stock FROM stock WHERE ent = 'CEO Admin' AND sku = 'plata-250ml' AND cubeta = 'PAGADO')),
  (25, 'Efectivo: 4690+1198+1000+475+316.66-350.75-300-120.40', 6908.51,
      (SELECT public.saldo_cuenta(id) FROM cta WHERE nombre = 'Efectivo')),
  (26, 'Cuenta Fresnillo: saldo inicial sin movimientos',   12059.33,
      (SELECT public.saldo_cuenta(id) FROM cta WHERE nombre = 'Cuenta Fresnillo')),
  (27, 'Cuenta Gilberto (clase PERSONAL): 0 (solo egresos, ingreso rechazado)', 0,
      (SELECT public.saldo_cuenta(id) FROM cta WHERE nombre = 'Cuenta Gilberto')),
  (28, 'saldos iniciales: no cuentan como ingreso del periodo', 0,
      (SELECT count(*) FROM v_movimiento_clasificado WHERE tipo_movimiento = 'SALDO_INICIAL' AND es_ingreso_admin)),
  (29, 'pg_net: llamadas que salieron a la red (cascaron)', 0,
      (SELECT count(*) FROM net.http_request_queue))
)
SELECT orden, prueba, esperado, obtenido,
       CASE WHEN esperado = obtenido THEN 'OK' ELSE 'FALLA' END AS ok
  FROM pruebas ORDER BY orden;
