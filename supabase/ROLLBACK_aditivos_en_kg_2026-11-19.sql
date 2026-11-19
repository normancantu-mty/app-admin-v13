-- ============================================================================
-- ROLLBACK de la migracion aditivos_en_kg (2026-11-19).
-- Escrito el 2026-11-19 por el agente (Cuartel). Correr en UNA transaccion.
--
-- Revierte: catalogo a GRAMOS con precio por gramo, costo de los movimientos de
-- inventario a por gramo, y las cantidades de lote_entradas que la migracion
-- paso a kg (SOLO esas: se identifican por su fila en auditoria_logs con el
-- motivo de la migracion; lo capturado despues con "el mismo numero" no se toca
-- y hay que revisarlo a mano). Revertir tambien el deploy web que trae
-- esAditivoMismoNumero (lib/bot-compra.ts), o el bot no convertira g<->kg.
-- ============================================================================
BEGIN;

UPDATE public.catalogo_productos SET unidad_medida = 'GRAMOS', costo_unitario = 0.024
 WHERE sku = 'mosto-1' AND unidad_medida = 'KILOGRAMOS' AND costo_unitario = 24;
UPDATE public.catalogo_productos SET unidad_medida = 'GRAMOS', costo_unitario = 0.035
 WHERE sku = 'aditivo-2' AND unidad_medida = 'KILOGRAMOS' AND costo_unitario = 35;

UPDATE public.inventario_ledger il
   SET costo_unitario_movimiento = il.costo_unitario_movimiento / 1000,
       notas = replace(il.notas, ' [2026-11-19: aditivo en kg, costo por kg]', '')
  FROM public.catalogo_productos p
 WHERE p.id = il.id_producto AND p.sku IN ('mosto-1', 'aditivo-2')
   AND il.notas LIKE '%[2026-11-19: aditivo en kg, costo por kg]%';

UPDATE public.lote_entradas e
   SET cantidad = e.cantidad * 1000
 WHERE e.id IN (SELECT a.id_registro FROM public.auditoria_logs a
                 WHERE a.tabla = 'lote_entradas'
                   AND a.motivo = '2026-11-19: aditivo en kg (los gramos escritos antes pasan a kg)');

UPDATE public.receta_liquido_estandar r
   SET cantidad_por_lote = r.cantidad_por_lote * 1000,
       fuente = replace(r.fuente, ' | 2026-11-19: en kg', '')
  FROM public.catalogo_productos p
 WHERE p.id = r.id_insumo AND p.sku = 'mosto-1' AND r.cantidad_por_lote < 100;

COMMIT;
