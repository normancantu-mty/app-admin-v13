-- PROPUESTA, NO APLICADA. Escrito el 2026-11-07 por el ejecutor del Socio (Fase 6).
--
-- Hoy no hay vista de stock POSITIVO de insumos: solo `v_insumos_en_negativo`
-- (HAVING stock < 0). El bot calcula el inventario de insumos en TypeScript con
-- el MISMO cuerpo (`stockDeInsumos` de lib/bot-pregunta-erp.ts). Si esta vista
-- se aplica, el bot puede leerla en vez de replicar la regla, y la regla vive en
-- un solo lugar. Es el cuerpo de `v_insumos_en_negativo` sin el HAVING.

create or replace view public.v_stock_insumos
with (security_invoker = true) as
with movimientos as (
  select e.id as id_entidad,
         e.nombre as entidad,
         il.id_producto,
         case when il.id_entidad_destino = e.id
               and il.tipo_movimiento::text = any (array['ENTRADA_COMPRA','PRODUCCION','DEVOLUCION_FISICA','INGRESO_TRASPASO','ENTRADA_CONCESION','AJUSTE_INVENTARIO'])
              then il.cantidad else 0::numeric end as entrada,
         case when il.id_entidad_origen = e.id
               and il.tipo_movimiento::text = any (array['SALIDA_VENTA','MERMA','TRASPASO','EGRESO_TRASPASO','SALIDA_CONCESION','DEVOLUCION_FISICA'])
              then il.cantidad else 0::numeric end as salida
    from inventario_ledger il
    join entidades e on e.id = il.id_entidad_destino or e.id = il.id_entidad_origen
   where il.status = any (array['ACTIVO','APPROVED'])
)
select m.id_entidad, m.entidad, m.id_producto, p.sku, p.nombre as insumo, p.unidad_medida,
       round(sum(m.entrada), 4) as capturado_entradas,
       round(sum(m.salida), 4) as consumido,
       round(sum(m.entrada) - sum(m.salida), 4) as stock
  from movimientos m
  join catalogo_productos p on p.id = m.id_producto
 where p.tipo::text = 'INSUMO'
 group by m.id_entidad, m.entidad, m.id_producto, p.sku, p.nombre, p.unidad_medida;

revoke all on public.v_stock_insumos from anon;
