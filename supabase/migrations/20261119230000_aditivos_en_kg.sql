-- Aditivo 1 y Aditivo 2 en KILOGRAMOS (2026-11-19). Escrito el 2026-11-19 por el agente (Cuartel).
-- Reversa: supabase/ROLLBACK_aditivos_en_kg_2026-11-19.sql
--
-- Cris (2026-11-19): en la app y en Telegram el aditivo 1 y 2 se capturan "en
-- gramos", pero en el ERP se manejan como KILOGRAMOS con el MISMO numero
-- (8 g dichos -> 8 kg). El flujo nuevo no convierte (lib/bot-compra.ts,
-- esAditivoMismoNumero). Esto deja la base coherente con "el numero es kg":
--
--   1. catalogo: mosto-1 y aditivo-2 GRAMOS -> KILOGRAMOS; precio por kg otra
--      vez ($0.024/g -> $24/kg, $0.035/g -> $35/kg: los precios de antes del
--      2026-11-10). La levadura se queda en GRAMOS (no es parte del pedido).
--   2. inventario_ledger: las CANTIDADES no se tocan (10 + 90 de aditivo 1, 180
--      de aditivo 2 pasan a leerse como kg: el arranque del 2026-10-27 se conto
--      cuando el catalogo estaba en kilos); el costo del movimiento pasa a por kg
--      (x1000), el mismo precio por unidad del catalogo.
--   3. lote_entradas: las cantidades de aditivo de los lotes YA escritos se
--      capturaron en GRAMOS reales (bot/plantilla "8 kg" -> 8000 g; receta
--      "~8 kg de aditivo"). Dejarlas igual en kg daria 8,000 kg por lote y un
--      costo de $192,000 de aditivo 1 por lote. Se pasan a kg (/1000) UNA vez, con
--      marca en la bitacora: masa real y dinero quedan iguales. Desde hoy lo
--      nuevo entra con el mismo numero, sin conversion.
--   4. receta_liquido_estandar: aditivo 1 8000 g -> 8 kg (la fuente dice ~8 kg).
--
-- ORDEN AL DESPLEGAR: esta migracion junto con el deploy del codigo web que trae
-- esAditivoMismoNumero. Con el codigo viejo, un "8 g" del bot se dividiria entre
-- 1000 contra un catalogo en KILOGRAMOS.

begin;

-- 1. catalogo
update public.catalogo_productos set unidad_medida = 'KILOGRAMOS', costo_unitario = 24
 where sku = 'mosto-1' and unidad_medida = 'GRAMOS' and costo_unitario = 0.024;
update public.catalogo_productos set unidad_medida = 'KILOGRAMOS', costo_unitario = 35
 where sku = 'aditivo-2' and unidad_medida = 'GRAMOS' and costo_unitario = 0.035;

-- 2. inventario_ledger: costo por kg; cantidad igual. Idempotente por la marca.
update public.inventario_ledger il
   set costo_unitario_movimiento = il.costo_unitario_movimiento * 1000,
       notas = coalesce(il.notas, '') || ' [2026-11-19: aditivo en kg, costo por kg]'
  from public.catalogo_productos p
 where p.id = il.id_producto and p.sku in ('mosto-1', 'aditivo-2')
   and coalesce(il.notas, '') not like '%[2026-11-19:%';

-- 3. lote_entradas: los gramos ya escritos -> kg (una vez). Se deja traza en la bitacora.
insert into public.auditoria_logs (tabla, id_registro, operacion, usuario, rol, datos_antes, datos_despues, motivo)
select 'lote_entradas', e.id, 'UPDATE', 'sistema', null, to_jsonb(e), to_jsonb(e) || jsonb_build_object('cantidad', e.cantidad / 1000),
       '2026-11-19: aditivo en kg (los gramos escritos antes pasan a kg)'
  from public.lote_entradas e join public.catalogo_productos p on p.id = e.id_insumo
 where p.sku in ('mosto-1', 'aditivo-2');
update public.lote_entradas e
   set cantidad = e.cantidad / 1000
  from public.catalogo_productos p
 where p.id = e.id_insumo and p.sku in ('mosto-1', 'aditivo-2');

-- 4. receta
update public.receta_liquido_estandar r
   set cantidad_por_lote = r.cantidad_por_lote / 1000,
       fuente = r.fuente || ' | 2026-11-19: en kg'
  from public.catalogo_productos p
 where p.id = r.id_insumo and p.sku = 'mosto-1' and r.cantidad_por_lote >= 1000;

-- Verificacion: si algo no quedo, se deshace TODO.
do $$
declare v_malos int;
begin
  select count(*) into v_malos from public.catalogo_productos
   where (sku = 'mosto-1' and (unidad_medida <> 'KILOGRAMOS' or costo_unitario <> 24))
      or (sku = 'aditivo-2' and (unidad_medida <> 'KILOGRAMOS' or costo_unitario <> 35));
  if v_malos > 0 then raise exception 'catalogo: % aditivo(s) no quedaron en kg', v_malos; end if;
  select count(*) into v_malos from public.receta_liquido_estandar r join public.catalogo_productos p on p.id = r.id_insumo
   where p.sku = 'mosto-1' and r.cantidad_por_lote <> 8;
  if v_malos > 0 then raise exception 'receta: aditivo 1 no quedo en 8 kg'; end if;
end $$;

commit;
