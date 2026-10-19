-- Lote v2: el ciclo del lote por etapas (produccion, fermentacion, aditivo 2,
-- reposo, destilacion, muestra).
--
-- Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
-- Encargo: Fresnillo/ERP_Fresnillo/DESDE_SOCIO_encargo_lote_v2_2026-10-19.md
--
-- ES ADITIVA. Solo CREATE TABLE / CREATE INDEX / CREATE FUNCTION / CREATE POLICY
-- nuevos, ADD COLUMN con default NULL, dos DROP NOT NULL y un INSERT ... ON
-- CONFLICT DO NOTHING (el SKU chile-guajon). No borra, no cambia el tipo de
-- ninguna columna, no toca ninguna fila existente.
--
-- QUE TRAE
--   1. `lotes.brix_chile`, `lotes.brix_final`: el Brix del chile y el Brix
--      despues del aditivo 1. Se dictan el dia de produccion.
--   2. `lote_salidas.litros` deja de ser NOT NULL: la destilacion se captura por
--      GARRAFA con peso (kg) y % de alcohol. NO se inventa una densidad para
--      sacar litros; el CHECK (litros > 0) se queda (NULL lo pasa).
--   3. `lote_etapas`: una fila por etapa registrada de un lote (aditivo_2,
--      destilacion, muestra), con fecha, quien y cuando. De aqui salen los dias
--      de fermentacion (fecha de produccion -> fecha de destilacion) y los
--      recordatorios.
--   4. `lote_recordatorios`: cada recordatorio que el bot mando, UNO por lote y
--      tipo (PK). El bot lo RECLAMA con un INSERT ... ON CONFLICT DO NOTHING
--      antes de mandarlo: si no inserto, ya salio y no se repite, aunque el bot
--      se reinicie (el estado vive aqui, no en la memoria del proceso).
--   5. `temperatura_diaria`: min, max y promedio por dia y por fuente
--      ('open-meteo exterior' o 'manual'). Es un PROXY sin anclar de la
--      temperatura del cuarto de fermentacion.
--   6. `registrar_etapa_lote(...)`: escribe en UNA transaccion la etapa, sus
--      entradas (el aditivo 2 en `lote_entradas`) y sus garrafas
--      (`lote_salidas`, numero_tanda = numero de garrafa).
--   7. RONDA 5 (decision de Norman, 2026-10-19): el ENVASADO DIARIO, sin lote.
--      `lote_envasado.id_lote` deja de ser NOT NULL (NULL = envasado del dia,
--      que no se liga a ningun lote), `lote_envasado.nota` (el codigo de lote
--      dicho, si lo dijeron) y `registrar_envasado_diario(...)`: la fila de
--      `lote_envasado` y su inventario (+terminado, -empaque) en UNA
--      transaccion, con el mismo candado de empaque que `registrar_en_lote`
--      (D92: ningun insumo queda en negativo).
--   8. RONDA 5: el chile GUAJON en el catalogo (`chile-guajon`), con el mismo
--      tipo, unidad y es_materia_prima que `chile-guajillo`. Costo: el default
--      de la tabla (0, sin `costo_cero_confirmado`): el sistema lo marca como
--      "falta costo" hasta que Norman lo ponga. No se inventa un precio.
--
-- RLS: las tablas nuevas nacen con RLS y lectura solo para ADMIN, igual que las
-- cuatro de ERP-84 (la receta es de acceso restringido). El bot entra con
-- service_role.
--
-- RONDA 2 (2026-10-19, auditoria): este MISMO archivo se edito; no se habia
-- aplicado en ningun lado. Cambios: todo va entre BEGIN/COMMIT (si truena a
-- medias no queda nada), `create or replace function` (re-ejecutable),
-- `lote_recordatorios.intentos` + `entregado_en` (reintento con tope si fallan
-- todos los envios) y `registrar_etapa_lote` numera las garrafas desde
-- max(numero_tanda)+1 del lote.
--
-- REVERSA: PRIMERO revertir el codigo y reiniciar el bot; DESPUES este SQL
-- (en este orden; borra lo que se haya capturado con el ciclo v2), y al final
-- `npx supabase migration repair --status reverted 20261019150000 --linked`.
--   -- ronda 5 (7 y 8). El chile-guajon solo si nada lo usa todavia:
--   delete from public.catalogo_productos c where c.sku = 'chile-guajon'
--     and not exists (select 1 from public.lote_entradas e where e.id_insumo = c.id)
--     and not exists (select 1 from public.inventario_ledger l where l.id_producto = c.id);
--   drop function if exists public.registrar_envasado_diario(date, jsonb, text, text);
--   -- solo si NINGUNA fila de lote_envasado tiene id_lote NULL (los envasados
--   -- diarios ya escritos se quedarian sin lugar; sus movimientos de inventario
--   -- son filas normales de inventario_ledger y no se tocan):
--   alter table public.lote_envasado alter column id_lote set not null;
--   alter table public.lote_envasado drop column if exists nota;
--   drop function if exists public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb);
--   drop table if exists public.lote_recordatorios;
--   drop table if exists public.lote_etapas;
--   drop table if exists public.temperatura_diaria;
--   -- solo si NINGUNA fila de lote_salidas tiene litros NULL:
--   alter table public.lote_salidas alter column litros set not null;
--   alter table public.lotes drop column if exists brix_final;
--   alter table public.lotes drop column if exists brix_chile;

begin;

-- 1. Brix del dia de produccion ------------------------------------------------
alter table public.lotes add column if not exists brix_chile numeric(5,2)
  check (brix_chile is null or (brix_chile >= 0 and brix_chile <= 100));
alter table public.lotes add column if not exists brix_final numeric(5,2)
  check (brix_final is null or (brix_final >= 0 and brix_final <= 100));

comment on column public.lotes.brix_chile is
  'Lote v2. Grados Brix del chile, dictados el dia de produccion.';
comment on column public.lotes.brix_final is
  'Lote v2. Grados Brix despues de agregar el aditivo 1 (confirmado por Norman, 2026-10-19).';

-- 2. Garrafas sin litros -------------------------------------------------------
alter table public.lote_salidas alter column litros drop not null;

-- 3. Las etapas ----------------------------------------------------------------
create table if not exists public.lote_etapas (
  id             uuid primary key default gen_random_uuid(),
  id_lote        uuid not null references public.lotes(id) on delete cascade,
  etapa          text not null check (etapa in ('aditivo_2', 'destilacion', 'muestra')),
  fecha          date not null,
  telegram_id    bigint,
  registrado_por text not null,
  registrado_en  timestamptz not null default now(),
  datos          jsonb not null default '{}'::jsonb,
  unique (id_lote, etapa)
);

comment on table public.lote_etapas is
  'Lote v2. Una fila por etapa registrada de un lote. La produccion es la fila de `lotes` (fecha_inicio); los dias de fermentacion salen de fecha_inicio -> etapa destilacion.';

create index if not exists lote_etapas_por_lote on public.lote_etapas (id_lote);

-- 4. Los recordatorios ---------------------------------------------------------
create table if not exists public.lote_recordatorios (
  id_lote    uuid not null references public.lotes(id) on delete cascade,
  tipo       text not null check (tipo in ('aditivo_2', 'destilar', 'muestra', 'muestra_2')),
  enviado_en timestamptz not null default now(),
  primary key (id_lote, tipo)
);

-- Ronda 2: el reclamo NO es la entrega. `intentos` cuenta los reclamos (1 al
-- insertar); `entregado_en` se pone cuando AL MENOS un envio salio. Con
-- entregado_en NULL y intentos < tope (YAML), el siguiente latido lo reintenta
-- (compare-and-swap sobre `intentos`: un solo latido gana el reintento).
alter table public.lote_recordatorios add column if not exists intentos integer not null default 1
  check (intentos >= 1);
alter table public.lote_recordatorios add column if not exists entregado_en timestamptz;

comment on table public.lote_recordatorios is
  'Lote v2. Cada recordatorio del ciclo que el bot ya mando. Se reclama con INSERT ON CONFLICT DO NOTHING: lo que ya esta aqui no se vuelve a mandar.';

-- 5. La temperatura ------------------------------------------------------------
create table if not exists public.temperatura_diaria (
  fecha         date not null,
  fuente        text not null check (fuente in ('open-meteo exterior', 'manual')),
  t_min         numeric(5,2) not null,
  t_max         numeric(5,2) not null,
  t_prom        numeric(5,2) not null,
  latitud       numeric(8,4),
  longitud      numeric(8,4),
  registrado_en timestamptz not null default now(),
  primary key (fecha, fuente),
  constraint temperatura_diaria_orden check (t_min <= t_prom and t_prom <= t_max)
);

comment on table public.temperatura_diaria is
  'Lote v2. Temperatura por dia. fuente=open-meteo exterior es la del aire en Fresnillo, Zac. (PROXY sin anclar del cuarto de fermentacion). fuente=manual: el bot ya no la escribe (ronda 5, Norman 2026-10-19: la gente no dicta temperatura).';

-- RLS: lectura solo ADMIN, como ERP-84 ------------------------------------------
alter table public.lote_etapas        enable row level security;
alter table public.lote_recordatorios enable row level security;
alter table public.temperatura_diaria enable row level security;

drop policy if exists lote_etapas_sel_admin on public.lote_etapas;
create policy lote_etapas_sel_admin on public.lote_etapas
  for select to authenticated using (public.mi_rol() = 'ADMIN');

drop policy if exists lote_recordatorios_sel_admin on public.lote_recordatorios;
create policy lote_recordatorios_sel_admin on public.lote_recordatorios
  for select to authenticated using (public.mi_rol() = 'ADMIN');

drop policy if exists temperatura_diaria_sel_admin on public.temperatura_diaria;
create policy temperatura_diaria_sel_admin on public.temperatura_diaria
  for select to authenticated using (public.mi_rol() = 'ADMIN');

-- 6. La escritura de una etapa, todo o nada ---------------------------------------
create or replace function public.registrar_etapa_lote(
  p_id_lote uuid, p_etapa text, p_fecha date, p_telegram_id bigint, p_usuario text,
  p_entradas jsonb, p_garrafas jsonb, p_datos jsonb)
returns jsonb
language plpgsql
as $$
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
  -- del F0, no choca con el unique). litros va NULL: no hay densidad medida.
  select coalesce(max(numero_tanda), 0) into v_base from public.lote_salidas where id_lote = p_id_lote;
  insert into public.lote_salidas (id_lote, numero_tanda, litros, grado_alcohol, peso_kg)
  select p_id_lote, v_base + (g->>'numero')::integer, null,
         (g->>'grado_alcohol')::numeric, (g->>'peso_kg')::numeric
  from jsonb_array_elements(coalesce(p_garrafas, '[]'::jsonb)) g;
  get diagnostics v_garrafas = row_count;

  return jsonb_build_object('id_etapa', v_id, 'codigo_lote', v_codigo,
                            'entradas', v_entradas, 'garrafas', v_garrafas);
end;
$$;

revoke all on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb)
  to service_role;

-- 7. RONDA 5: el envasado diario, sin lote ---------------------------------------
-- Norman (2026-10-19): la produccion de un lote termina en la destilacion; el
-- envasado de botellas es diario, independiente del lote, y por ahora no se liga.
alter table public.lote_envasado alter column id_lote drop not null;
alter table public.lote_envasado add column if not exists nota text;

comment on column public.lote_envasado.id_lote is
  'NULL = envasado diario (lote v2 ronda 5, Norman 2026-10-19): el envasado de botellas es diario e independiente del lote y por ahora no se liga a ninguno.';
comment on column public.lote_envasado.nota is
  'Lote v2 ronda 5. Lo que se dijo con el envasado diario que no es dato (p. ej. el codigo de lote dicho, que NO lo liga a ese lote).';

create or replace function public.registrar_envasado_diario(
  p_fecha date, p_envasado jsonb, p_usuario text, p_nota text)
returns jsonb
language plpgsql
as $$
declare
  v_admin uuid;
  v_linea jsonb;
  v_botellas integer;
  v_envasado integer := 0;
  v_inventario integer := 0;
  v_n integer;
  v_faltan text;
begin
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
$$;

revoke all on function public.registrar_envasado_diario(date, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.registrar_envasado_diario(date, jsonb, text, text)
  to service_role;

-- 8. RONDA 5: el chile guajon ---------------------------------------------------
-- Mismo tipo, unidad y es_materia_prima que chile-guajillo. Costo: el default
-- (0, sin confirmar) -> el sistema lo marca "falta costo"; no se inventa precio.
insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, es_materia_prima)
select 'chile-guajon', 'Chile Guajon', g.tipo, g.unidad_medida, g.es_materia_prima
from public.catalogo_productos g
where g.sku = 'chile-guajillo'
on conflict (sku) do nothing;

commit;
