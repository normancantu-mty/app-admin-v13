-- ============================================================================
-- Fase 9, D92 (2026-09-23): envasar SIN el empaque registrado ya no se escribe.
--
-- Norman: "No me importa inventario negativo. De hecho es mejor para que
-- bloquee. Pero si hay negativo, el asistente debe estar preguntando".
--
-- 1. `stock_de_insumos(entidad, ids)`: el stock de cualquier producto (insumo o
--    terminado) de una entidad, con la MISMA regla de signos que
--    `v_stock_por_cubeta` (entrada si la entidad es destino de un tipo de
--    entrada; salida si es origen de un tipo de salida; ACTIVO/APPROVED).
--    Hace falta porque `v_stock_por_cubeta` filtra `tipo = 'TERMINADO'` y
--    `having > 0`: para un insumo siempre contesta "nada". Por eso la Fase 8
--    avisaba falta de empaque aunque hubiera (hoy la matriz tiene 6 botellas
--    750 y 6 corchos; la vista decia 0).
--
-- 2. `registrar_en_lote`: antes de escribir el envasado, suma lo que TODO el
--    envasado pide de cada insumo y lo compara con `stock_de_insumos`. Si un
--    insumo quedaria en negativo, `raise exception 'FALTA_EMPAQUE: ...'` y no
--    queda nada (es una sola transaccion). Un candado de transaccion
--    (`pg_advisory_xact_lock`) serializa dos envasados simultaneos, para que
--    los dos no lean el mismo stock y lo gasten dos veces.
--
-- Aditiva: una funcion nueva y el cuerpo de otra. No toca filas existentes.
-- Cero botellas sigue sin mover nada (no pide empaque, no bloquea).
-- ============================================================================

create or replace function public.stock_de_insumos(p_id_entidad uuid, p_ids uuid[])
returns table (id_producto uuid, stock numeric)
language sql stable
as $$
  select il.id_producto,
         round(sum(
           case
             when il.id_entidad_destino = p_id_entidad and il.tipo_movimiento::text = any (array[
               'ENTRADA_COMPRA', 'PRODUCCION', 'DEVOLUCION_FISICA', 'INGRESO_TRASPASO', 'ENTRADA_CONCESION'])
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

create or replace function public.registrar_en_lote(
  p_id_lote uuid, p_entradas jsonb, p_tandas jsonb, p_envasado jsonb, p_usuario text)
returns jsonb
language plpgsql
as $$
declare
  v_codigo text;
  v_admin uuid;
  v_base integer;
  v_linea jsonb;
  v_botellas integer;
  v_entradas integer := 0;
  v_tandas integer := 0;
  v_envasado integer := 0;
  v_inventario integer := 0;
  v_n integer;
  v_faltan text;
begin
  select codigo_lote into v_codigo from public.lotes where id = p_id_lote for update;
  if v_codigo is null then
    raise exception 'El lote % no existe.', p_id_lote;
  end if;

  -- Entradas: el mismo insumo dicho otra vez SE SUMA (unique id_lote,id_insumo).
  insert into public.lote_entradas (id_lote, id_insumo, cantidad)
  select p_id_lote, (e->>'id_insumo')::uuid, (e->>'cantidad')::numeric
  from jsonb_array_elements(coalesce(p_entradas, '[]'::jsonb)) e
  on conflict (id_lote, id_insumo)
    do update set cantidad = public.lote_entradas.cantidad + excluded.cantidad;
  get diagnostics v_entradas = row_count;

  -- Tandas: se numeran DESPUES de las que el lote ya tenia.
  select coalesce(max(numero_tanda), 0) into v_base from public.lote_salidas where id_lote = p_id_lote;
  insert into public.lote_salidas (id_lote, numero_tanda, litros, grado_alcohol)
  select p_id_lote, v_base + t.n::integer, (t.v->>'litros')::numeric, (t.v->>'grado_alcohol')::numeric
  from jsonb_array_elements(coalesce(p_tandas, '[]'::jsonb)) with ordinality as t(v, n);
  get diagnostics v_tandas = row_count;

  -- Envasado: cada renglon, su fila de `lote_envasado` y su inventario.
  if jsonb_array_length(coalesce(p_envasado, '[]'::jsonb)) > 0 then
    -- La misma entidad que `registrarProduccionAction` (inventario.ts:106-110).
    select id into v_admin from public.entidades where rol = 'ADMIN' limit 1;
    if v_admin is null then
      raise exception 'No existe una entidad ADMIN para asignar la produccion.';
    end if;

    -- D92: ningun insumo queda en negativo. Se suma lo que pide TODO el
    -- envasado (dos formatos comparten lamina) antes de escribir una fila.
    perform pg_advisory_xact_lock(hashtext('registrar_en_lote:empaque'));
    with pedido as (
      select m.id_producto, sum(m.cantidad) as ocupa
      from jsonb_array_elements(p_envasado) l,
           lateral public.movimientos_de_envasado(
             (l->>'id_producto')::uuid, (l->>'botellas')::integer) m
      where m.tipo_movimiento = 'TRASPASO'
      group by m.id_producto
    ), hay as (
      select s.id_producto, s.stock
      from public.stock_de_insumos(v_admin, array(select id_producto from pedido)) s
    )
    select string_agg(
             format('%s (ocupas %s, hay %s)', coalesce(c.nombre, p.id_producto::text),
                    trim_scale(p.ocupa), trim_scale(coalesce(h.stock, 0))),
             '; ' order by c.nombre)
      into v_faltan
    from pedido p
    left join hay h on h.id_producto = p.id_producto
    left join public.catalogo_productos c on c.id = p.id_producto
    where coalesce(h.stock, 0) < p.ocupa;

    if v_faltan is not null then
      raise exception 'FALTA_EMPAQUE: %', v_faltan;
    end if;

    for v_linea in select * from jsonb_array_elements(p_envasado) loop
      v_botellas := (v_linea->>'botellas')::integer;
      continue when coalesce(v_botellas, 0) <= 0;

      insert into public.lote_envasado (id_lote, id_producto, botellas)
      values (p_id_lote, (v_linea->>'id_producto')::uuid, v_botellas);
      v_envasado := v_envasado + 1;

      insert into public.inventario_ledger
        (id_producto, tipo_movimiento, cantidad, id_entidad_origen, id_entidad_destino,
         cubeta, status, usuario_creador, notas)
      select m.id_producto, m.tipo_movimiento, m.cantidad,
             case when m.tipo_movimiento = 'TRASPASO' then v_admin end,
             case when m.tipo_movimiento = 'PRODUCCION' then v_admin end,
             'PAGADO', 'ACTIVO', p_usuario,
             'ENVASADO lote ' || v_codigo || ': ' || v_botellas || ' botellas'
      from public.movimientos_de_envasado((v_linea->>'id_producto')::uuid, v_botellas) m;
      get diagnostics v_n = row_count;
      v_inventario := v_inventario + v_n;
    end loop;
  end if;

  return jsonb_build_object(
    'codigo_lote', v_codigo,
    'entradas', v_entradas,
    'tandas', v_tandas,
    'envasado', v_envasado,
    'filas_inventario', v_inventario);
end
$$;

revoke all on function public.stock_de_insumos(uuid, uuid[]) from public, anon;
grant execute on function public.stock_de_insumos(uuid, uuid[]) to authenticated, service_role;
revoke all on function public.registrar_en_lote(uuid, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.registrar_en_lote(uuid, jsonb, jsonb, jsonb, text) to service_role;
