-- app_movil_etapas_lote_authenticated (2026-11-11)
-- La app movil (supabase-js con el JWT del usuario) registra etapas de lote,
-- envasado diario y registro en lote. Antes: las 3 RPC solo service_role y
-- lote_etapas sin politica de INSERT (SPEC_BACKEND.md, seccion Lotes).
-- Cambio minimo:
--  1. Las 3 RPC conservan su logica; al inicio, si no es service_role (bot) ni
--     postgres, exige mi_rol() = 'ADMIN'. Siguen SECURITY INVOKER: el RLS del
--     llamador sigue aplicando a cada INSERT.
--  2. registrar_etapa_lote: desde la app, registrado_por = email del JWT y
--     telegram_id = NULL (el bot sigue pasando los suyos).
--  3. EXECUTE a authenticated (no a anon/public).
--  4. Politica INSERT en lote_etapas para ADMIN, firmando con su propio email.

CREATE OR REPLACE FUNCTION public.registrar_etapa_lote(p_id_lote uuid, p_etapa text, p_fecha date, p_telegram_id bigint, p_usuario text, p_entradas jsonb, p_garrafas jsonb, p_datos jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_codigo text;
  v_id uuid;
  v_entradas integer := 0;
  v_garrafas integer := 0;
  v_base integer := 0;
  v_usuario text := p_usuario;
  v_telegram_id bigint := p_telegram_id;
begin
  -- 2026-11-11 (app movil, JWT del usuario): fuera del bot (service_role) y de
  -- postgres (pruebas en supabase/pruebas), solo un ADMIN puede llamarla.
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'postgres'
     and public.mi_rol() is distinct from 'ADMIN' then
    raise exception 'NO_AUTORIZADO: solo un ADMIN registra esto (rol de la sesion: %)',
      coalesce(public.mi_rol(), 'sin sesion')
      using errcode = '42501';
  end if;
  -- 2026-11-11: desde la app el autor sale del JWT (como tg_forzar_autor), no
  -- del parametro: un ADMIN no puede firmar como otro ni como un telegram_id ajeno.
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'postgres' then
    v_usuario := nullif(auth.jwt() ->> 'email', '');
    v_telegram_id := null;
    if v_usuario is null then
      raise exception 'NO_AUTORIZADO: la sesion no trae email para registrado_por.'
        using errcode = '42501';
    end if;
  end if;

  select codigo_lote into v_codigo from public.lotes where id = p_id_lote for update;
  if v_codigo is null then
    raise exception 'El lote % no existe.', p_id_lote;
  end if;

  insert into public.lote_etapas (id_lote, etapa, fecha, telegram_id, registrado_por, datos)
  values (p_id_lote, p_etapa, p_fecha, v_telegram_id, v_usuario, coalesce(p_datos, '{}'::jsonb))
  on conflict (id_lote, etapa) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'ETAPA_YA_REGISTRADA: % del lote %', p_etapa, v_codigo;
  end if;

  -- El aditivo 2 entra como insumo del lote. Si el mismo insumo ya estaba, se
  -- SUMA (unique id_lote,id_insumo), igual que `registrar_en_lote`.
  insert into public.lote_entradas (id_lote, id_insumo, cantidad)
  select p_id_lote, (e->>'id_insumo')::uuid, (e->>'cantidad')::numeric
  from jsonb_array_elements(coalesce(p_entradas, '[]'::jsonb)) e
  on conflict (id_lote, id_insumo)
    do update set cantidad = public.lote_entradas.cantidad + excluded.cantidad;
  get diagnostics v_entradas = row_count;

  -- Las garrafas: una fila por garrafa. numero_tanda = max(numero_tanda) del
  -- lote + numero de garrafa (ronda 2: si el lote ya tenia salidas, p. ej. tandas
  -- del F0, no choca con el unique). 2026-11-10: litros y nota MEDIDOS por
  -- garrafa, como la tanda de la web (antes litros iba NULL).
  select coalesce(max(numero_tanda), 0) into v_base from public.lote_salidas where id_lote = p_id_lote;
  insert into public.lote_salidas (id_lote, numero_tanda, litros, grado_alcohol, peso_kg, notas)
  select p_id_lote, v_base + (g->>'numero')::integer, (g->>'litros')::numeric,
         (g->>'grado_alcohol')::numeric, (g->>'peso_kg')::numeric, nullif(btrim(g->>'notas'), '')
  from jsonb_array_elements(coalesce(p_garrafas, '[]'::jsonb)) g;
  get diagnostics v_garrafas = row_count;

  return jsonb_build_object('id_etapa', v_id, 'codigo_lote', v_codigo,
                            'entradas', v_entradas, 'garrafas', v_garrafas);
end;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_envasado_diario(p_fecha date, p_envasado jsonb, p_usuario text, p_nota text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  v_admin uuid;
  v_linea jsonb;
  v_botellas integer;
  v_envasado integer := 0;
  v_inventario integer := 0;
  v_n integer;
  v_faltan text;
begin
  -- 2026-11-11 (app movil, JWT del usuario): fuera del bot (service_role) y de
  -- postgres (pruebas en supabase/pruebas), solo un ADMIN puede llamarla.
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'postgres'
     and public.mi_rol() is distinct from 'ADMIN' then
    raise exception 'NO_AUTORIZADO: solo un ADMIN registra esto (rol de la sesion: %)',
      coalesce(public.mi_rol(), 'sin sesion')
      using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(p_envasado, '[]'::jsonb)) = 0 then
    raise exception 'ENVASADO_VACIO: no hay botellas que registrar.';
  end if;
  -- La misma entidad que `registrarProduccionAction` y `registrar_en_lote`.
  select id into v_admin from public.entidades where rol = 'ADMIN' limit 1;
  if v_admin is null then
    raise exception 'No existe una entidad ADMIN para asignar la produccion.';
  end if;

  -- D92: ningun insumo queda en negativo. MISMO candado que `registrar_en_lote`:
  -- un envasado diario y uno de lote simultaneos no gastan dos veces el empaque.
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

    insert into public.lote_envasado (id_lote, id_producto, botellas, fecha, nota)
    values (null, (v_linea->>'id_producto')::uuid, v_botellas,
            coalesce(p_fecha, (now() at time zone 'America/Mexico_City')::date), nullif(p_nota, ''));
    v_envasado := v_envasado + 1;

    insert into public.inventario_ledger
      (id_producto, tipo_movimiento, cantidad, id_entidad_origen, id_entidad_destino,
       cubeta, status, usuario_creador, notas)
    select m.id_producto, m.tipo_movimiento, m.cantidad,
           case when m.tipo_movimiento = 'TRASPASO' then v_admin end,
           case when m.tipo_movimiento = 'PRODUCCION' then v_admin end,
           'PAGADO', 'ACTIVO', p_usuario,
           'ENVASADO diario: ' || v_botellas || ' botellas'
    from public.movimientos_de_envasado((v_linea->>'id_producto')::uuid, v_botellas) m;
    get diagnostics v_n = row_count;
    v_inventario := v_inventario + v_n;
  end loop;

  return jsonb_build_object('envasado', v_envasado, 'filas_inventario', v_inventario);
end;
$function$;

CREATE OR REPLACE FUNCTION public.registrar_en_lote(p_id_lote uuid, p_entradas jsonb, p_tandas jsonb, p_envasado jsonb, p_usuario text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
  -- 2026-11-11 (app movil, JWT del usuario): fuera del bot (service_role) y de
  -- postgres (pruebas en supabase/pruebas), solo un ADMIN puede llamarla.
  if coalesce(auth.role(), '') <> 'service_role' and current_user <> 'postgres'
     and public.mi_rol() is distinct from 'ADMIN' then
    raise exception 'NO_AUTORIZADO: solo un ADMIN registra esto (rol de la sesion: %)',
      coalesce(public.mi_rol(), 'sin sesion')
      using errcode = '42501';
  end if;
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
$function$;

revoke all on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb) to authenticated;
revoke all on function public.registrar_envasado_diario(date, jsonb, text, text) from public, anon;
grant execute on function public.registrar_envasado_diario(date, jsonb, text, text) to authenticated;
revoke all on function public.registrar_en_lote(uuid, jsonb, jsonb, jsonb, text) from public, anon;
grant execute on function public.registrar_en_lote(uuid, jsonb, jsonb, jsonb, text) to authenticated;

drop policy if exists lote_etapas_ins_admin on public.lote_etapas;
create policy lote_etapas_ins_admin on public.lote_etapas
  for insert to authenticated
  with check (
    public.mi_rol() = 'ADMIN'
    and registrado_por = (auth.jwt() ->> 'email')
    and telegram_id is null
  );
