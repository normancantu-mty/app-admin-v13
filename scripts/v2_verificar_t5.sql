-- v2 LOCAL, T5: esperado vs obtenido de los flujos que la simulacion del 2026-10-28 no ejercio.
-- Escrito el 2026-10-29 por el Socio (ejecutor). SOLO LEE.
--
--   docker exec -i supabase_db_app-admin-v2 psql -U postgres -X < scripts/v2_verificar_t5.sql
--
-- Orden que supone (la bateria lo corre asi):
--   reset -> cargar_arranque.py --consig conciliado -> v2_t5_fixture.sql
--   -> v2_simular_t5.mjs (pantallas) -> v2_pruebas_t5_bot.py (rutas del bot)
-- Los esperados salen de las reglas y de la carga (precio de lista, formula fiscal de
-- lib/finance-utils.ts, receta, saldos del arranque), NO de las filas que se comprueban.
-- Columna ok: OK | FALLA | BRECHA (el codigo hace lo que dice, pero no lo que dice
-- REGLAS_COMERCIALES.md; es decision de Norman, no se cuenta como falla).
\pset footer off
WITH
admin AS (SELECT 'e0000000-0000-0000-0000-000000000001'::uuid AS id),
dstp AS (SELECT 'd5000000-0000-4000-a000-000000000001'::uuid AS id),
alson AS (SELECT id FROM entidades WHERE nombre = 'Al son del Mezcal'),
david AS (SELECT id FROM entidades WHERE nombre = 'David Flores'),
fres AS (SELECT id FROM cuentas_financieras WHERE id_entidad = (SELECT id FROM admin) AND clase = 'FISCAL'),
efec AS (SELECT id FROM cuentas_financieras WHERE id_entidad = (SELECT id FROM admin) AND clase = 'EFECTIVO'),
p750 AS (SELECT 'c1000000-0000-0000-0000-000000000001'::uuid AS id),
p250 AS (SELECT 'c1000000-0000-0000-0000-000000000003'::uuid AS id),
pp AS (SELECT
         (SELECT precio_final FROM listas_precios WHERE id_producto = (SELECT id FROM p750) AND zona = 'Zacatecas') AS pp750,
         (SELECT precio_final FROM listas_precios WHERE id_producto = (SELECT id FROM p250) AND zona = 'Zacatecas') AS pp250),
tk AS (SELECT t.*,
         CASE
           WHEN t.id_vendedor = (SELECT id FROM dstp) THEN 'D'
           WHEN t.id_comprador = (SELECT id FROM dstp) AND t.condicion_pago = 'CONCESION' THEN 'C'
           WHEN t.id_comprador = (SELECT id FROM alson) THEN 'A'
           WHEN t.id_comprador IS NULL AND t.id_cuenta_destino = (SELECT id FROM fres) THEN 'F'
         END AS cual
       FROM transacciones_tickets t),
fin AS (SELECT f.*, tk.cual FROM finanzas_ledger f LEFT JOIN tk ON tk.id = f.id_ticket),
inv AS (SELECT i.*, tk.cual FROM inventario_ledger i
          LEFT JOIN tk ON i.notas = 'ticket:' || tk.id::text),
-- la formula fiscal de lib/finance-utils.ts (FACTOR 1.7748, IEPS 53%, IVA 16%), a mano
fx AS (SELECT 2 * pp750 AS total, 2 * pp750 / 1.7748 AS base FROM pp),
stock AS (SELECT id_entidad, id_producto, cubeta, stock FROM v_stock_por_cubeta),
insumo AS (SELECT p.sku,
             COALESCE(SUM(CASE WHEN i.id_entidad_destino = (SELECT id FROM admin) AND i.tipo_movimiento IN ('ENTRADA_COMPRA','PRODUCCION') THEN i.cantidad
                               WHEN i.id_entidad_origen = (SELECT id FROM admin) AND i.tipo_movimiento IN ('TRASPASO','MERMA','SALIDA_VENTA') THEN -i.cantidad
                               ELSE 0 END), 0) AS neto
           FROM catalogo_productos p LEFT JOIN inventario_ledger i ON i.id_producto = p.id AND i.status IN ('ACTIVO','APPROVED')
           GROUP BY p.sku),
pruebas(orden, prueba, esperado, obtenido, tipo) AS (VALUES
 -- (a) venta desde Cuenta Fresnillo con IVA/IEPS (pantalla del POS)
 ('a1', 'Fresnillo: un ticket de contado al publico', '1', (SELECT count(*)::text FROM tk WHERE cual = 'F'), 'OK'),
 ('a2', 'Fresnillo: INGRESO_VENTA = 2 x precio de lista 750', (SELECT round(total,2)::text FROM fx),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'F' AND tipo_movimiento = 'INGRESO_VENTA'), 'OK'),
 ('a3', 'Fresnillo: PASIVO_IEPS = round(total/1.7748*0.53, 2)', (SELECT round(base * 0.53, 2)::text FROM fx),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'F' AND tipo_movimiento = 'PASIVO_IEPS'), 'OK'),
 ('a4', 'Fresnillo: PASIVO_IVA = round((base+ieps)*0.16, 2)', (SELECT round(base * 1.53 * 0.16, 2)::text FROM fx),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'F' AND tipo_movimiento = 'PASIVO_IVA'), 'OK'),
 ('a5', 'Fresnillo: ticket.monto_base_ingreso = round(total/1.7748, 2)', (SELECT round(base,2)::text FROM fx),
        (SELECT monto_base_ingreso::text FROM tk WHERE cual = 'F'), 'OK'),
 ('a6', 'Fresnillo: las 3 filas de dinero van a Cuenta Fresnillo', '3',
        (SELECT count(*)::text FROM fin WHERE cual = 'F' AND id_cuenta_destino = (SELECT id FROM fres)), 'OK'),
 ('a7', 'SUBSIDIO_FISCAL: filas en todo el ledger (no hay codigo que lo escriba)', '0',
        (SELECT count(*)::text FROM finanzas_ledger WHERE tipo_movimiento = 'SUBSIDIO_FISCAL'), 'OK'),
 -- (c) anulacion por el bot de la venta de Fresnillo
 ('c1', 'bot anula Fresnillo: ticket ANULADO', 'ANULADO', (SELECT status FROM tk WHERE cual = 'F'), 'OK'),
 ('c2', 'bot anula Fresnillo: sus 3 filas de dinero ANULADO', '3',
        (SELECT count(*)::text FROM fin WHERE cual = 'F' AND status = 'ANULADO'), 'OK'),
 ('c3', 'bot anula Fresnillo: su SALIDA_VENTA ANULADO', 'ANULADO',
        (SELECT string_agg(status, ',') FROM inv WHERE cual = 'F'), 'OK'),
 ('c4', 'Cuenta Fresnillo vuelve al saldo del corte', '12059.33',
        (SELECT public.saldo_cuenta(id)::text FROM fres), 'OK'),
 -- (d) COMISION_PASIVA: ADMIN vende de contado a un LOC de David
 ('d1', 'Al son: ticket de contado a precio con su comision local (ceil(pp250*(1-0.15)))',
        (SELECT ceil(pp250 * 0.85)::numeric(12,2)::text FROM pp), (SELECT string_agg(d.precio_unitario::text, ',') FROM ticket_detalles d JOIN tk ON tk.id = d.id_ticket WHERE tk.cual = 'A'), 'OK'),
 ('d2', 'Al son: COMISION_PASIVA va a David (padre), sin cuenta', 'David Flores',
        (SELECT string_agg(e.nombre, ',') FROM fin JOIN entidades e ON e.id = fin.id_entidad_relacionada WHERE cual = 'A' AND tipo_movimiento = 'COMISION_PASIVA' AND id_cuenta_destino IS NULL), 'OK'),
 ('d3', 'Al son: COMISION_PASIVA segun el codigo (floor(precio/1.7748*0.15) x 2, cuenta del ADMIN)',
        (SELECT (floor(ceil(pp250 * 0.85) / 1.7748 * 0.15) * 2)::numeric(12,2)::text FROM pp),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'A' AND tipo_movimiento = 'COMISION_PASIVA'), 'OK'),
 ('d4', 'Al son: COMISION_PASIVA segun REGLAS_COMERCIALES (red 15% x Base=PP, efectivo)',
        (SELECT (round(pp250 * 0.15, 2) * 2)::text FROM pp),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'A' AND tipo_movimiento = 'COMISION_PASIVA'), 'BRECHA'),
 ('d5', 'Al son: INGRESO_VENTA a Efectivo = 2 x ceil(pp250*0.85)', (SELECT (2 * ceil(pp250 * 0.85))::numeric(12,2)::text FROM pp),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'A' AND tipo_movimiento = 'INGRESO_VENTA' AND id_cuenta_destino = (SELECT id FROM efec)), 'OK'),
 ('d6', 'Efectivo = corte + venta a Al son', (SELECT (4690 + 2 * ceil(pp250 * 0.85))::numeric(14,2)::text FROM pp),
        (SELECT public.saldo_cuenta(id)::text FROM efec), 'OK'),
 -- consignacion + devolucion fisica a DST Prueba (comision_base 0.20 por el fixture)
 ('e1', 'DST Prueba: consignacion 3 x ceil(pp750*0.80)', (SELECT (3 * ceil(pp750 * 0.80))::numeric(12,2)::text FROM pp),
        (SELECT total_cobrado_real::text FROM tk WHERE cual = 'C'), 'OK'),
 ('e2', 'Devolucion fisica: abona lo que se cobro (ceil(pp750*0.80)), no el precio de lista',
        (SELECT ceil(pp750 * 0.80)::numeric(12,2)::text FROM pp),
        (SELECT string_agg(monto::text, ',') FROM finanzas_ledger WHERE id_entidad_relacionada = (SELECT id FROM dstp) AND tipo_movimiento = 'ABONO_DEUDA' AND status = 'ACTIVO'), 'OK'),
 ('e3', 'Devolucion fisica: una fila, de DST Prueba a la matriz, cubeta CONSIGNADO', '1|CONSIGNADO',
        (SELECT count(*)::text || '|' || string_agg(cubeta, ',') FROM inventario_ledger WHERE tipo_movimiento = 'DEVOLUCION_FISICA' AND id_entidad_origen = (SELECT id FROM dstp) AND id_entidad_destino = (SELECT id FROM admin)), 'OK'),
 ('e4', 'DST Prueba: deuda = 2 piezas en consignacion x ceil(pp750*0.80)', (SELECT (2 * ceil(pp750 * 0.80))::numeric(14,2)::text FROM pp),
        (SELECT round(sum(CASE WHEN tipo='ABONO' THEN -monto ELSE monto END), 2)::text FROM (
            SELECT 'CARGO' tipo, total_cobrado_real monto FROM tk WHERE id_comprador = (SELECT id FROM dstp) AND condicion_pago = 'CONCESION' AND status = 'ACTIVO'
            UNION ALL SELECT 'ABONO', monto FROM finanzas_ledger WHERE id_entidad_relacionada = (SELECT id FROM dstp) AND tipo_movimiento = 'ABONO_DEUDA' AND status = 'ACTIVO') x), 'OK'),
 ('e5', 'v_cartera: deuda de DST Prueba = la misma', (SELECT (2 * ceil(pp750 * 0.80))::numeric(14,2)::text FROM pp),
        (SELECT deuda::numeric(14,2)::text FROM v_cartera WHERE id_entidad = (SELECT id FROM dstp)), 'OK'),
 ('e6', 'DST Prueba: CONSIGNADO 750 = 3 - 1 devuelta (la venta se anulo)', '2.0000',
        (SELECT coalesce(string_agg(stock::text, ','), '0') FROM stock WHERE id_entidad = (SELECT id FROM dstp) AND id_producto = (SELECT id FROM p750) AND cubeta = 'CONSIGNADO'), 'OK'),
 ('e7', 'DST Prueba: sin PAGADO negativo escondido (suma cruda del ledger)', '0',
        (SELECT coalesce(sum(CASE WHEN id_entidad_destino = (SELECT id FROM dstp) THEN cantidad ELSE -cantidad END), 0)::int::text
           FROM inventario_ledger WHERE status IN ('ACTIVO','APPROVED') AND cubeta = 'PAGADO' AND id_producto = (SELECT id FROM p750)
            AND (id_entidad_destino = (SELECT id FROM dstp) OR id_entidad_origen = (SELECT id FROM dstp))), 'OK'),
 -- venta de contado del DST (su sesion) y su anulacion por la pantalla de finanzas
 ('f1', 'DST vende 1 x pp750: INGRESO_COMISION = floor(pp750*0.20)', (SELECT floor(pp750 * 0.20)::numeric(12,2)::text FROM pp),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'D' AND tipo_movimiento = 'INGRESO_COMISION'), 'OK'),
 ('f2', 'DST vende: DEUDA_A_MATRIZ = pp750 - comision', (SELECT (pp750 - floor(pp750 * 0.20))::numeric(12,2)::text FROM pp),
        (SELECT string_agg(monto::text, ',') FROM fin WHERE cual = 'D' AND tipo_movimiento = 'DEUDA_A_MATRIZ'), 'OK'),
 ('f3', 'DST vende: sale de su CONSIGNADO', 'CONSIGNADO', (SELECT string_agg(cubeta, ',') FROM inv WHERE cual = 'D' AND tipo_movimiento = 'SALIDA_VENTA'), 'OK'),
 ('f4', 'anulacion por pantalla: ticket del DST ANULADO', 'ANULADO', (SELECT status FROM tk WHERE cual = 'D'), 'OK'),
 ('f5', 'anulacion por pantalla: sus 2 filas de dinero ANULADO', '2', (SELECT count(*)::text FROM fin WHERE cual = 'D' AND status = 'ANULADO'), 'OK'),
 ('f6', 'anulacion por pantalla: su SALIDA_VENTA ANULADO', 'ANULADO', (SELECT string_agg(status, ',') FROM inv WHERE cual = 'D'), 'OK'),
 -- (b) produccion: lote nuevo y envasado del dia (rutas del bot)
 ('b1', 'lote: uno abierto por el bot', '1', (SELECT count(*)::text FROM lotes), 'OK'),
 ('b2', 'lote: entrada 8 kg de chile guajillo', 'chile-guajillo=8',
        (SELECT string_agg(p.sku || '=' || trim(trailing '.' from trim(trailing '0' from e.cantidad::text)), ',') FROM lote_entradas e JOIN catalogo_productos p ON p.id = e.id_insumo), 'OK'),
 ('b3', 'lote: 1 tanda de 20 L a 40 grados', '20|40',
        (SELECT string_agg(trim(trailing '.' from trim(trailing '0' from litros::text)) || '|' || trim(trailing '.' from trim(trailing '0' from grado_alcohol::text)), ',') FROM lote_salidas), 'OK'),
 ('b4', 'lote: no escribe inventario; PRODUCCION+TRASPASO = solo las 6 filas del envasado', '6',
        (SELECT count(*)::text FROM inventario_ledger WHERE tipo_movimiento IN ('PRODUCCION','TRASPASO')), 'OK'),
 ('b5', 'envasado: PRODUCCION 6 x 750 a la matriz', '6.0000',
        (SELECT string_agg(cantidad::text, ',') FROM inventario_ledger WHERE tipo_movimiento = 'PRODUCCION' AND status = 'ACTIVO' AND id_entidad_destino = (SELECT id FROM admin)), 'OK'),
 ('b6', 'envasado: TRASPASO de cada insumo de la receta 750 (x6)',
        (SELECT string_agg(i.sku || '=' || trim(trailing '.' from trim(trailing '0' from (6 * r.cantidad_requerida)::text)), ',' ORDER BY i.sku)
           FROM recetas_produccion r JOIN catalogo_productos i ON i.id = r.id_insumo WHERE r.id_producto_terminado = (SELECT id FROM p750)),
        (SELECT string_agg(p.sku || '=' || trim(trailing '.' from trim(trailing '0' from l.cantidad::text)), ',' ORDER BY p.sku)
           FROM inventario_ledger l JOIN catalogo_productos p ON p.id = l.id_producto WHERE l.tipo_movimiento = 'TRASPASO' AND l.status = 'ACTIVO'), 'OK'),
 ('b7', 'entrada de empaque por el bot: botellas y corchos +10 (ENTRADA_COMPRA, sin dinero)', 'botella-750-vacia=4,corcho=4',
        (SELECT string_agg(sku || '=' || neto::int, ',' ORDER BY sku) FROM insumo WHERE sku IN ('botella-750-vacia','corcho')), 'OK'),
 ('b8', 'matriz 750 PAGADO = 27 corte - 3 consigna + 1 devuelta - 2 vendidas + 2 anuladas + 6 envasadas', '31.0000',
        (SELECT string_agg(stock::text, ',') FROM stock WHERE id_entidad = (SELECT id FROM admin) AND id_producto = (SELECT id FROM p750) AND cubeta = 'PAGADO'), 'OK'),
 ('b9', 'matriz 250 PAGADO = 257 corte - 2 a Al son', '255.0000',
        (SELECT string_agg(stock::text, ',') FROM stock WHERE id_entidad = (SELECT id FROM admin) AND id_producto = (SELECT id FROM p250) AND cubeta = 'PAGADO'), 'OK'),
 -- tipos sin escritor en el codigo (app/, lib/, funciones SQL): se comprueba que siguen en 0
 ('z1', 'finanzas MERMA / DEVOLUCION / SUBSIDIO_FISCAL: filas', '0',
        (SELECT count(*)::text FROM finanzas_ledger WHERE tipo_movimiento IN ('MERMA','DEVOLUCION','SUBSIDIO_FISCAL')), 'OK'),
 ('z2', 'inventario LIQUIDACION_INTERNA / INGRESO_TRASPASO / EGRESO_TRASPASO / ANULADO (tipo): filas', '0',
        (SELECT count(*)::text FROM inventario_ledger WHERE tipo_movimiento IN ('LIQUIDACION_INTERNA','INGRESO_TRASPASO','EGRESO_TRASPASO','ANULADO')), 'OK')
)
SELECT orden, prueba, esperado, coalesce(obtenido, '(null)') AS obtenido,
       CASE WHEN esperado = obtenido THEN 'OK' WHEN tipo = 'BRECHA' THEN 'BRECHA' ELSE 'FALLA' END AS ok
FROM pruebas ORDER BY orden;
