-- Lote v2: el ciclo del lote por etapas (produccion, fermentacion, aditivo 2,
-- reposo, destilacion, muestra).
--
-- Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
-- Encargo: Fresnillo/ERP_Fresnillo/DESDE_SOCIO_encargo_lote_v2_2026-10-19.md
--
-- ES ADITIVA. Solo CREATE TABLE / CREATE INDEX / CREATE FUNCTION / CREATE POLICY
-- nuevos, ADD COLUMN con default NULL y un DROP NOT NULL. No borra, no cambia el
-- tipo de ninguna columna, no toca ninguna fila existente.
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
--
-- RLS: las tablas nuevas nacen con RLS y lectura solo para ADMIN, igual que las
-- cuatro de ERP-84 (la receta es de acceso restringido). El bot entra con
-- service_role.
--
-- REVERSA (en este orden; borra lo que se haya capturado con el ciclo v2):
--   drop function if exists public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb);
--   drop table if exists public.lote_recordatorios;
--   drop table if exists public.lote_etapas;
--   drop table if exists public.temperatura_diaria;
--   -- solo si NINGUNA fila de lote_salidas tiene litros NULL:
--   alter table public.lote_salidas alter column litros set not null;
--   alter table public.lotes drop column if exists brix_final;
--   alter table public.lotes drop column if exists brix_chile;

-- 1. Brix del dia de produccion ------------------------------------------------
alter table public.lotes add column if not exists brix_chile numeric(5,2)
  check (brix_chile is null or (brix_chile >= 0 and brix_chile <= 100));
alter table public.lotes add column if not exists brix_final numeric(5,2)
  check (brix_final is null or (brix_final >= 0 and brix_final <= 100));

comment on column public.lotes.brix_chile is
  'Lote v2. Grados Brix del chile, dictados el dia de produccion.';
comment on column public.lotes.brix_final is
  'Lote v2. Grados Brix despues de agregar el aditivo 1 (interpretacion del Socio, 2026-10-19).';

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
  'Lote v2. Temperatura por dia. fuente=open-meteo exterior es la del aire en Fresnillo, Zac. (PROXY sin anclar del cuarto de fermentacion); fuente=manual es la dictada.';

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
create function public.registrar_etapa_lote(
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

  -- Las garrafas: una fila por garrafa, numero_tanda = numero de garrafa.
  -- litros va NULL a proposito: no hay densidad medida.
  insert into public.lote_salidas (id_lote, numero_tanda, litros, grado_alcohol, peso_kg)
  select p_id_lote, (g->>'numero')::integer, null,
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
