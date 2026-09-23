-- ============================================================================
-- Fase 8, D81-D82 (2026-09-22): envasar a un lote que YA existe, y que envasar
-- mueva el inventario, en una sola transaccion.
--
-- Hasta hoy: el bot trataba toda produccion como lote nuevo, y `lote_envasado`
-- no movia ni una botella de `inventario_ledger` (0 escrituras, 0 triggers).
--
-- 1. `lote_envasado` pierde su UNIQUE (id_lote, id_producto). Con el, el mismo
--    lote no se podia envasar en 750 dos dias distintos ("hoy envasamos 24 del
--    lote X", manana otras 24): el segundo INSERT reventaba con 23505. Queda un
--    indice NO unico con las mismas columnas. La tabla tiene 0 filas. **No es
--    aditiva estricta** (quita una restriccion), igual que D79; reversible.
--
-- 2. `movimientos_de_envasado(producto, botellas)`: lo que un envasado le hace
--    al inventario, sin escribir. +N PRODUCCION del terminado y, por cada
--    renglon de `recetas_produccion`, un TRASPASO de `cantidad_requerida x N`.
--    Es EXACTAMENTE lo que ya escribe `registrarProduccionAction`
--    (app/actions/inventario.ts:173-203): mismo tipo, misma cubeta PAGADO,
--    misma entidad ADMIN. Cero o menos botellas -> cero filas.
--
-- 3. `registrar_en_lote(lote, entradas, tandas, envasado, usuario)`: escribe
--    los hijos de un lote Y el inventario del envasado en UNA funcion, o sea
--    una transaccion. Si algo falla, no queda nada: ni el envasado sin su
--    inventario ni el inventario sin su envasado. La usan los dos caminos del
--    bot (lote nuevo y agregar a un lote existente).
--
-- Falta de empaque en stock: NO se bloquea aqui (lo pidio Norman: "se dice en
-- la propuesta antes del VA; no bloquea"). Es lo mismo que hace hoy
-- `registrarProduccionAction`, que tampoco revisa stock. Ver el informe de la
-- Fase 8: choca con la regla 3 de CLAUDE.md y se deja dicho, no escondido.
-- ============================================================================

alter table public.lote_envasado drop constraint if exists lote_envasado_id_lote_id_producto_key;
create index if not exists lote_envasado_por_lote_producto
  on public.lote_envasado (id_lote, id_producto);

create or replace function public.movimientos_de_envasado(p_id_producto uuid, p_botellas integer)
returns table (id_producto uuid, tipo_movimiento text, cantidad numeric)
language sql stable
as $$
  select p_id_producto, 'PRODUCCION'::text, p_botellas::numeric
  where coalesce(p_botellas, 0) > 0
  union all
  select r.id_insumo, 'TRASPASO'::text, r.cantidad_requerida * p_botellas
  from public.recetas_produccion r
  where coalesce(p_botellas, 0) > 0
    and r.id_producto_terminado = p_id_producto
    and r.id_insumo is not null
    and r.cantidad_requerida * p_botellas > 0
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

revoke all on function public.movimientos_de_envasado(uuid, integer) from public, anon;
grant execute on function public.movimientos_de_envasado(uuid, integer) to authenticated, service_role;
-- Escribe: solo el servidor (la ruta del bot, con service role).
revoke all on function public.registrar_en_lote(uuid, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.registrar_en_lote(uuid, jsonb, jsonb, jsonb, text) to service_role;
