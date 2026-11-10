-- ============================================================================
-- ROLLBACK_unidades_lotes_2026-11-10.sql · reversa de
-- supabase/migrations/20261110195229_unidades_lotes_gramos_y_litros.sql
-- Escrito el 2026-11-10 por el Socio (ejecutor).
-- ============================================================================
-- Que deja: precios por kilo, levadura en KILOGRAMOS, receta y funcion como
-- estaban antes.
--   - Las columnas de costo se QUEDAN en numeric(14,4): regresarlas a (12,2)
--     obliga a tirar y recrear las 3 vistas otra vez, y los precios de antes
--     (24, 35, 1580) caben igual en 4 decimales. No cambia ningun numero.
--   - lote_entradas: la levadura se divide / 1000, tambien la escrita despues
--     de la migracion (que ya venia en gramos): asi todo queda en kilos. Los
--     aditivos siempre estuvieron en gramos y no se tocan.
--   - inventario_ledger: solo se regresan las filas con la marca de la
--     migracion. Los movimientos de aditivos/levadura hechos DESPUES (ya con
--     costo por gramo, o levadura en gramos) NO se tocan. Revisarlos a mano antes:
--       select p.sku, il.cantidad, il.costo_unitario_movimiento, il.notas
--         from inventario_ledger il join catalogo_productos p on p.id = il.id_producto
--        where p.sku in ('mosto-1','aditivo-2','levadura-enzimas')
--          and coalesce(il.notas, '') not like '%[2026-11-10:%';
--   - lote_salidas: los litros y notas que el bot ya escribio se QUEDAN (son
--     datos medidos); solo la funcion vuelve a no escribirlos.
--   - El bot tambien hay que regresarlo al commit anterior: si no, sigue
--     mandando levadura en gramos a un catalogo en kilos.
-- ============================================================================

begin;

update public.catalogo_productos set costo_unitario = 24
 where sku = 'mosto-1' and costo_unitario = 0.024;
update public.catalogo_productos set costo_unitario = 35
 where sku = 'aditivo-2' and costo_unitario = 0.035;
update public.catalogo_productos set unidad_medida = 'KILOGRAMOS', costo_unitario = 1580
 where sku = 'levadura-enzimas' and unidad_medida = 'GRAMOS' and costo_unitario = 1.58;

update public.inventario_ledger il
   set costo_unitario_movimiento = il.costo_unitario_movimiento * 1000,
       notas = nullif(replace(il.notas, ' [2026-11-10: costo por kg -> por g]', ''), '')
  from public.catalogo_productos p
 where p.id = il.id_producto and p.sku in ('mosto-1', 'aditivo-2')
   and il.notas like '%[2026-11-10: costo por kg -> por g]%';
update public.inventario_ledger il
   set cantidad = il.cantidad / 1000,
       costo_unitario_movimiento = il.costo_unitario_movimiento * 1000,
       notas = nullif(replace(il.notas, ' [2026-11-10: kg -> g]', ''), '')
  from public.catalogo_productos p
 where p.id = il.id_producto and p.sku = 'levadura-enzimas'
   and il.notas like '%[2026-11-10: kg -> g]%';

update public.lote_entradas e set cantidad = e.cantidad / 1000
  from public.catalogo_productos p
 where p.id = e.id_insumo and p.sku = 'levadura-enzimas';

update public.receta_liquido_estandar r
   set cantidad_por_lote = r.cantidad_por_lote / 1000,
       fuente = replace(r.fuente, ' | 2026-11-10: en gramos', '')
  from public.catalogo_productos p
 where p.id = r.id_insumo and p.sku in ('mosto-1', 'levadura-enzimas') and r.cantidad_por_lote >= 10;

-- La funcion tal como estaba (20261019150000_lote_v2_ciclo.sql).
create or replace function public.registrar_etapa_lote(
  p_id_lote uuid, p_etapa text, p_fecha date, p_telegram_id bigint, p_usuario text,
  p_entradas jsonb, p_garrafas jsonb, p_datos jsonb)
returns jsonb
language plpgsql
as $function$
declare
  v_codigo text;
  v_id uuid;
  v_entradas integer := 0;
  v_garrafas integer := 0;
  v_base integer := 0;
begin
  select codigo_lote into v_codigo from public.lotes where id = p_id_lote for update;
  if v_codigo is null then
    raise exception 'El lote % no existe.', p_id_lote;
  end if;

  insert into public.lote_etapas (id_lote, etapa, fecha, telegram_id, registrado_por, datos)
  values (p_id_lote, p_etapa, p_fecha, p_telegram_id, p_usuario, coalesce(p_datos, '{}'::jsonb))
  on conflict (id_lote, etapa) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'ETAPA_YA_REGISTRADA: % del lote %', p_etapa, v_codigo;
  end if;

  insert into public.lote_entradas (id_lote, id_insumo, cantidad)
  select p_id_lote, (e->>'id_insumo')::uuid, (e->>'cantidad')::numeric
  from jsonb_array_elements(coalesce(p_entradas, '[]'::jsonb)) e
  on conflict (id_lote, id_insumo)
    do update set cantidad = public.lote_entradas.cantidad + excluded.cantidad;
  get diagnostics v_entradas = row_count;

  select coalesce(max(numero_tanda), 0) into v_base from public.lote_salidas where id_lote = p_id_lote;
  insert into public.lote_salidas (id_lote, numero_tanda, litros, grado_alcohol, peso_kg)
  select p_id_lote, v_base + (g->>'numero')::integer, null,
         (g->>'grado_alcohol')::numeric, (g->>'peso_kg')::numeric
  from jsonb_array_elements(coalesce(p_garrafas, '[]'::jsonb)) g;
  get diagnostics v_garrafas = row_count;

  return jsonb_build_object('id_etapa', v_id, 'codigo_lote', v_codigo,
                            'entradas', v_entradas, 'garrafas', v_garrafas);
end;
$function$;

revoke all on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb)
  to service_role;

commit;
