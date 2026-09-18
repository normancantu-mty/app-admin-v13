-- ERP-84: el registro de lotes. Que entro, cuanto fermento, que salio, que se envaso.
--
-- Escrito el 2026-09-18 por el Socio Estrategico. Aplicada con apply_migration del MCP.
--
-- DE DONDE SALE ESTO
-- ---------------------------------------------------------------------------
-- Norman, 2026-09-18, describiendo el proceso: produccion ~4 dias por semana;
-- cada lote lleva agua, chile y dos ingredientes mas; se mide cuantos dias y
-- horas fermenta; salen ~20 litros que se separan en DOS tandas con distinto
-- grado de alcohol y peso; de ahi se envasa y **el numero de lote va impreso en
-- la etiqueta**. Tambien sale pasta de chile, que hoy se DONA al DIF y por eso
-- no absorbe costo (`D-195`, `D-196`).
--
-- EL SECRETO DE LA RECETA, Y COMO SE PROTEGE DE VERDAD
-- ---------------------------------------------------------------------------
-- Norman: *"todo esto de la receta es muy delicado y no quiero que salga... uno
-- es Az y otro Al"*. Los dos ingredientes entran al catalogo con **nombre
-- opaco**: `ing-az` / `Ingrediente Az`. Quien lea la base ve cuanto se usa, no
-- de que se trata.
--
-- **Pero hay que decirlo sin adornos: las CANTIDADES son la receta.** Ocultar
-- el nombre sube el costo de copiarla, no lo vuelve imposible: cualquiera con
-- acceso de lectura y conocimiento del oficio reduce el espacio de candidatos
-- muy rapido. **La proteccion real no es criptografica, es de ACCESO**, y por
-- eso estas cuatro tablas nacen con RLS y con la lectura restringida a
-- ADMIN y SOCIO -el mismo trato que ya tiene `recetas_produccion`-, no a
-- cualquier usuario autenticado. Si un dia hay empleados con cuenta, esta es la
-- linea que los deja fuera.
--
-- LA DECISION DE DISENO QUE IMPORTA: EL DENOMINADOR ES EL MILILITRO
-- ---------------------------------------------------------------------------
-- La tentacion es costear "por botella". **No se puede: un lote llena formatos
-- distintos.** 20 botellas de 750 ml son 15 litros; 20 de 50 ml son 1 litro.
-- Por eso se agrega `catalogo_productos.ml_por_unidad` y el rendimiento se mide
-- en **mililitros envasados**. El costo del liquido de una botella es
-- `ml_por_unidad * costo_por_ml`, y eso si es comparable entre formatos.
--
-- Y de paso, ese denominador destapa algo que hoy nadie puede ver: Norman dice
-- *"salen como 20 litros"* y *"salen como 20 botellas"*. **Esos dos numeros no
-- cuadran solos** -20 botellas de 750 ml son 15 litros, y faltarian 5-. Puede
-- ser merma, puede ser que las 20 sean de formatos mezclados, puede ser que
-- alguno de los dos numeros este redondeado. **La tabla lo va a decir en el
-- primer lote capturado; hoy es invisible.** Esa es la columna
-- `merma_envasado` de la vista.
--
-- QUE **NO** HACE ESTA MIGRACION, Y ES A PROPOSITO
-- ---------------------------------------------------------------------------
-- **No toca `recetas_produccion` ni `v_costo_produccion`.** El margen sigue
-- saliendo NULL. Conectar el costo del liquido al costo del producto terminado
-- exige **al menos un lote capturado de verdad**, y escribir ese puente sobre
-- cero filas seria construir contra una suposicion. Se hace cuando exista el
-- primer lote, con sus numeros a la vista. [Filtro: DOC02 -- YAGNI]
--
-- SUPUESTOS DECLARADOS (corregibles con un UPDATE, las tablas nacen vacias)
--   - `ing-az` y `ing-al` se miden en KILOGRAMOS. Norman no lo dijo; si alguno
--     va en litros o gramos, es un UPDATE de una linea.
--   - `agua` se mide en LITROS y hoy tiene costo 0.00. Es medible y no es
--     gratis, pero nadie ha dado esa cifra.
--   - Un lote puede tener cualquier numero de tandas. El caso de hoy son 2, y
--     no se cablea el 2 en ningun lado.
--
-- ES ADITIVA: cuatro tablas nuevas, una columna nueva con default NULL, tres
-- SKU nuevos y una vista nueva. No borra ni altera ninguna fila existente.
--
-- ROLLBACK:
--   drop view if exists public.v_lote_rendimiento;
--   drop table if exists public.lote_envasado, public.lote_salidas,
--                        public.lote_entradas, public.lotes;
--   alter table public.catalogo_productos drop column if exists ml_por_unidad;
--   delete from public.catalogo_productos where sku in ('agua','ing-az','ing-al');

alter table public.catalogo_productos
  add column if not exists ml_por_unidad numeric(10,2);

comment on column public.catalogo_productos.ml_por_unidad is
  'ERP-84. Mililitros de liquido que contiene UNA unidad de este producto. NULL = no es liquido (la pasta, los insumos de empaque). Es el denominador del costeo de lote: un lote llena formatos distintos, asi que el rendimiento se mide en ml, no en botellas.';

update public.catalogo_productos set ml_por_unidad = 50  where sku = 'plata-50'  and ml_por_unidad is null;
update public.catalogo_productos set ml_por_unidad = 250 where sku = 'plata-250' and ml_por_unidad is null;
update public.catalogo_productos set ml_por_unidad = 750 where sku = 'plata-750' and ml_por_unidad is null;

insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario, es_materia_prima)
values
  ('agua',   'Agua de proceso', 'INSUMO', 'LITROS',     0.00, true),
  ('ing-az', 'Ingrediente Az',  'INSUMO', 'KILOGRAMOS', 0.00, true),
  ('ing-al', 'Ingrediente Al',  'INSUMO', 'KILOGRAMOS', 0.00, true)
on conflict (sku) do nothing;

create table if not exists public.lotes (
  id                     uuid primary key default gen_random_uuid(),
  codigo_lote            text not null unique,
  fecha_inicio           date not null,
  fecha_fin_fermentacion date,
  horas_fermentacion     numeric(8,2) check (horas_fermentacion is null or horas_fermentacion > 0),
  notas                  text,
  usuario_creador        text not null,
  creado_en              timestamptz not null default now(),
  constraint lotes_fin_no_antes_del_inicio
    check (fecha_fin_fermentacion is null or fecha_fin_fermentacion >= fecha_inicio)
);

comment on table public.lotes is
  'ERP-84. Un renglon por lote de produccion. `codigo_lote` es el que va impreso en la etiqueta: es el puente entre una botella en la mano de un cliente y todo lo que sigue.';

create table if not exists public.lote_entradas (
  id        uuid primary key default gen_random_uuid(),
  id_lote   uuid not null references public.lotes(id) on delete cascade,
  id_insumo uuid not null references public.catalogo_productos(id),
  cantidad  numeric(12,4) not null check (cantidad > 0),
  unique (id_lote, id_insumo)
);

comment on table public.lote_entradas is
  'ERP-84. Que entro al lote y cuanto. La cantidad va en la unidad que declara catalogo_productos.unidad_medida del insumo. Un insumo no se puede repetir en el mismo lote: se suma antes de capturar.';

create table if not exists public.lote_salidas (
  id            uuid primary key default gen_random_uuid(),
  id_lote       uuid not null references public.lotes(id) on delete cascade,
  numero_tanda  integer not null check (numero_tanda > 0),
  litros        numeric(10,3) not null check (litros > 0),
  grado_alcohol numeric(5,2) check (grado_alcohol is null or (grado_alcohol >= 0 and grado_alcohol <= 100)),
  peso_kg       numeric(10,3) check (peso_kg is null or peso_kg > 0),
  notas         text,
  unique (id_lote, numero_tanda)
);

comment on table public.lote_salidas is
  'ERP-84. Lo que produjo el lote, tanda por tanda. Hoy son dos con distinto grado, pero el numero de tandas NO esta cableado: si un dia salen tres, se capturan tres.';

create table if not exists public.lote_envasado (
  id          uuid primary key default gen_random_uuid(),
  id_lote     uuid not null references public.lotes(id) on delete cascade,
  id_producto uuid not null references public.catalogo_productos(id),
  botellas    integer not null check (botellas > 0),
  fecha       date not null default current_date,
  unique (id_lote, id_producto)
);

comment on table public.lote_envasado is
  'ERP-84. Cuantas botellas de cada formato salieron del lote. Es lo que cierra el circulo: liga los litros producidos con el producto terminado que se vende.';

create index if not exists lote_entradas_por_lote on public.lote_entradas (id_lote);
create index if not exists lote_salidas_por_lote  on public.lote_salidas (id_lote);
create index if not exists lote_envasado_por_lote on public.lote_envasado (id_lote);

alter table public.lotes          enable row level security;
alter table public.lote_entradas  enable row level security;
alter table public.lote_salidas   enable row level security;
alter table public.lote_envasado  enable row level security;

create policy lotes_sel_admin_socio on public.lotes
  for select to authenticated using (mi_rol() = any (array['ADMIN','SOCIO']));
create policy lotes_ins_admin on public.lotes
  for insert to authenticated with check (mi_rol() = 'ADMIN');
create policy lotes_upd_admin on public.lotes
  for update to authenticated using (mi_rol() = 'ADMIN') with check (mi_rol() = 'ADMIN');
create policy lotes_del_admin on public.lotes
  for delete to authenticated using (mi_rol() = 'ADMIN');

create policy lote_entradas_sel_admin_socio on public.lote_entradas
  for select to authenticated using (mi_rol() = any (array['ADMIN','SOCIO']));
create policy lote_entradas_ins_admin on public.lote_entradas
  for insert to authenticated with check (mi_rol() = 'ADMIN');
create policy lote_entradas_upd_admin on public.lote_entradas
  for update to authenticated using (mi_rol() = 'ADMIN') with check (mi_rol() = 'ADMIN');
create policy lote_entradas_del_admin on public.lote_entradas
  for delete to authenticated using (mi_rol() = 'ADMIN');

create policy lote_salidas_sel_admin_socio on public.lote_salidas
  for select to authenticated using (mi_rol() = any (array['ADMIN','SOCIO']));
create policy lote_salidas_ins_admin on public.lote_salidas
  for insert to authenticated with check (mi_rol() = 'ADMIN');
create policy lote_salidas_upd_admin on public.lote_salidas
  for update to authenticated using (mi_rol() = 'ADMIN') with check (mi_rol() = 'ADMIN');
create policy lote_salidas_del_admin on public.lote_salidas
  for delete to authenticated using (mi_rol() = 'ADMIN');

create policy lote_envasado_sel_admin_socio on public.lote_envasado
  for select to authenticated using (mi_rol() = any (array['ADMIN','SOCIO']));
create policy lote_envasado_ins_admin on public.lote_envasado
  for insert to authenticated with check (mi_rol() = 'ADMIN');
create policy lote_envasado_upd_admin on public.lote_envasado
  for update to authenticated using (mi_rol() = 'ADMIN') with check (mi_rol() = 'ADMIN');
create policy lote_envasado_del_admin on public.lote_envasado
  for delete to authenticated using (mi_rol() = 'ADMIN');

create or replace view public.v_lote_rendimiento
with (security_invoker = true) as
with entradas as (
  select e.id_lote,
         round(sum(e.cantidad * coalesce(p.costo_unitario, 0)), 4)                 as costo_conocido,
         count(*) filter (where coalesce(p.costo_unitario, 0) = 0)                 as insumos_sin_costo,
         string_agg(p.sku, ', ' order by p.sku)
           filter (where coalesce(p.costo_unitario, 0) = 0)                        as faltan_costo,
         sum(e.cantidad) filter (where p.sku = 'chile-guajillo')                   as kg_chile
    from public.lote_entradas e
    join public.catalogo_productos p on p.id = e.id_insumo
   group by e.id_lote
),
salidas as (
  select id_lote,
         sum(litros)                                                               as litros,
         count(*)                                                                  as tandas,
         round(sum(litros * coalesce(grado_alcohol, 0)) / nullif(sum(litros), 0), 2)
                                                                                   as grado_ponderado
    from public.lote_salidas
   group by id_lote
),
envasado as (
  select v.id_lote,
         sum(v.botellas)                                                           as botellas,
         sum(v.botellas * p.ml_por_unidad)                                         as ml_envasados,
         count(*) filter (where p.ml_por_unidad is null)                           as formatos_sin_ml
    from public.lote_envasado v
    join public.catalogo_productos p on p.id = v.id_producto
   group by v.id_lote
)
select
  l.id,
  l.codigo_lote,
  l.fecha_inicio,
  l.fecha_fin_fermentacion,
  coalesce(l.horas_fermentacion,
           (l.fecha_fin_fermentacion - l.fecha_inicio) * 24)                       as horas_fermentacion,
  en.kg_chile,
  s.litros                                                                         as litros_producidos,
  s.tandas,
  s.grado_ponderado,
  ev.botellas,
  ev.ml_envasados,
  round(s.litros / nullif(en.kg_chile, 0), 4)                                      as litros_por_kg_chile,
  round(1 - (ev.ml_envasados / nullif(s.litros * 1000, 0)), 4)                     as merma_envasado,
  en.costo_conocido                                                                as costo_insumos_conocido,
  en.insumos_sin_costo,
  en.faltan_costo,
  case when en.insumos_sin_costo = 0 and coalesce(ev.formatos_sin_ml, 0) = 0
       then round(en.costo_conocido / nullif(ev.ml_envasados, 0), 6)
  end                                                                              as costo_por_ml
from public.lotes l
  left join entradas en on en.id_lote = l.id
  left join salidas  s  on s.id_lote  = l.id
  left join envasado ev on ev.id_lote = l.id;

comment on view public.v_lote_rendimiento is
  'ERP-84. Rendimiento y costo de cada lote. costo_por_ml sale NULL si algun insumo del lote no tiene costo o si algun formato envasado no declara ml_por_unidad: la misma regla que v_costo_produccion, por la misma razon -un costo al que le falta un renglon esta inflado, no aproximado-.';

revoke all on public.v_lote_rendimiento from public, anon;
grant select on public.v_lote_rendimiento to authenticated, service_role;
