-- ============================================================================
-- Fase 8, D84-D85 (2026-09-22): el costo COMPLETO por botella y su margen.
--
-- Hasta hoy `v_costo_produccion` solo sumaba empaque y dejaba el margen en
-- NULL: las recetas no traen ni el liquido ni la mano de obra. Esta migracion
-- NO toca esa vista (la siguen leyendo quienes la lean); agrega una nueva,
-- `v_costo_completo`, y todo lo que necesita:
--
--   1. `catalogo_productos.costo_cero_confirmado` (default false). El agua
--      cuesta $0 y ESO ES UN HECHO, no un hueco. Hasta hoy `v_lote_rendimiento`
--      contaba cualquier costo 0 como "sin costo", asi que un lote real con su
--      agua capturada nunca habria dado `costo_por_ml`. Solo el agua lo lleva.
--   2. Dos insumos nuevos, con el costo de MARGENES_2026-09-02.md §1:
--      levadura y enzimas ($50 POR LOTE, unidad LOTE) y "de tibu" ($30/kg).
--   3. `parametros_costo`: los numeros que no son de un insumo, con nombre y
--      fuente, a la vista (no enterrados en una vista). Marbete y caja estan
--      ahi con valor NULL: no hay dato, y la vista lo dice.
--   4. `receta_liquido_estandar`: el lote estandar de Norman.
--   5. `costo_completo_de(...)`: la aritmetica, PURA (sin tablas), para que
--      una prueba la corra sobre fixtures.
--   6. `v_costo_completo`: por presentacion, empaque + liquido + mano de obra,
--      precio publico y de distribuidor en Zacatecas, margen $ y %, y `faltan`.
--
-- Filas que toca: agrega 2 a `catalogo_productos`, 7 a `parametros_costo`, 5 a
-- `receta_liquido_estandar`, y pone `costo_cero_confirmado = true` en la fila
-- del agua (columna nueva; nada existente cambia de valor). No borra nada.
-- ============================================================================

-- 1. El cero que es un hecho --------------------------------------------------
alter table public.catalogo_productos
  add column if not exists costo_cero_confirmado boolean not null default false;

comment on column public.catalogo_productos.costo_cero_confirmado is
  'true = su costo_unitario 0 es un HECHO (el agua), no un costo que falta. '
  'Las vistas de costo solo cuentan como faltante un 0 con esta columna en false.';

update public.catalogo_productos set costo_cero_confirmado = true where sku = 'agua';

-- 2. Levadura y "tibu": MARGENES_2026-09-02.md §1, lineas 15-18 ---------------
insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario, es_materia_prima)
select 'levadura-enzimas', 'Levadura y enzimas', 'INSUMO', 'LOTE', 50, true
where not exists (select 1 from public.catalogo_productos where sku = 'levadura-enzimas');

insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario, es_materia_prima)
select 'tibu', 'Insumo de tibu', 'INSUMO', 'KILOGRAMOS', 30, true
where not exists (select 1 from public.catalogo_productos where sku = 'tibu');

-- 3. Parametros con nombre ----------------------------------------------------
create table if not exists public.parametros_costo (
  clave  text primary key,
  valor  numeric,             -- NULL = no hay dato, y se dice
  unidad text not null,
  fuente text not null,
  nota   text
);

alter table public.parametros_costo enable row level security;
create policy parametros_costo_sel_admin_socio on public.parametros_costo
  for select to authenticated using (mi_rol() = any (array['ADMIN', 'SOCIO']));
create policy parametros_costo_upd_admin on public.parametros_costo
  for update to authenticated using (mi_rol() = 'ADMIN') with check (mi_rol() = 'ADMIN');
grant select, update on public.parametros_costo to authenticated;
grant all on public.parametros_costo to service_role;

insert into public.parametros_costo (clave, valor, unidad, fuente, nota) values
  ('nomina_mensual', 14000, 'MXN/mes',
   'MARGENES_2026-09-02.md §2 (linea 33): $8,000 + $6,000', null),
  ('capacidad_botellas_750_mes', 416, 'botellas de 750 ml/mes',
   'MARGENES_2026-09-02.md §2 (lineas 29-30): 4 lotes/semana x 24',
   'ES CAPACIDAD, NO PRODUCCION REAL. La mano de obra por botella = nomina / esto: '
   'si se produce menos, el costo real por botella SUBE (a 208/mes es el doble).'),
  ('ml_lote_estandar', 18000, 'ml',
   'MARGENES_2026-09-02.md §1 (linea 19): ~24 botellas de 750 ml por lote', null),
  ('comision_dst_estandar', 0.20, 'fraccion',
   'lib/reglas-comerciales.ts:114 (REGLAS_COMERCIALES.md): 750 $599 -> $480',
   'El precio de distribuidor es ceil(PP x (1 - esto)), efectivo, sin cuenta fiscal.'),
  ('factor_reconstruccion_fiscal', 1.7748, 'factor',
   'lib/finance-utils.ts (FULL_TAX): base = PP / 1.7748',
   'Solo para el margen "por cuenta fiscal". Si cambia alla, cambia aqui.'),
  ('costo_marbete_por_botella', null, 'MXN/botella', 'sin dato',
   'NO HAY DATO. No se inventa. Cuando exista, entra solo al costo total.'),
  ('costo_caja_por_botella', null, 'MXN/botella', 'sin dato',
   'NO HAY DATO. No se inventa. Cuando exista, entra solo al costo total.')
on conflict (clave) do nothing;

-- 4. El lote estandar ---------------------------------------------------------
create table if not exists public.receta_liquido_estandar (
  id_insumo         uuid primary key references public.catalogo_productos(id),
  cantidad_por_lote numeric,     -- NULL solo donde el costo es $0 confirmado
  fuente            text not null
);

alter table public.receta_liquido_estandar enable row level security;
create policy receta_liquido_sel_admin_socio on public.receta_liquido_estandar
  for select to authenticated using (mi_rol() = any (array['ADMIN', 'SOCIO']));
grant select on public.receta_liquido_estandar to authenticated;
grant all on public.receta_liquido_estandar to service_role;

-- El aditivo es `mosto-1` a $24 (ticket real, en la base) y no $25 del texto:
-- el brief dice que la base gana. Por eso el lote sale $1,322 y no $1,330.
insert into public.receta_liquido_estandar (id_insumo, cantidad_por_lote, fuente)
select c.id, v.cantidad, v.fuente
from (values
  ('chile-guajillo',   12::numeric, 'MARGENES §1 linea 15: 12 kg'),
  ('mosto-1',           8::numeric, 'MARGENES §1 linea 16: ~8 kg de aditivo'),
  ('levadura-enzimas',  1::numeric, 'MARGENES §1 linea 17: $50 por lote'),
  ('tibu',              6::numeric, 'MARGENES §1 linea 18: ~6 kg'),
  ('agua',              null,       'Costo $0 confirmado; la cantidad no se dicto')
) as v(sku, cantidad, fuente)
join public.catalogo_productos c on c.sku = v.sku
on conflict (id_insumo) do nothing;

-- 5. La aritmetica, pura ------------------------------------------------------
-- Empaque, liquido o mano de obra en NULL -> costo_total y margenes NULL: son
-- obligatorios. Marbete y caja en NULL -> entran como 0 AL TOTAL pero quedan en
-- `faltan` y `costo_completo = false`: son huecos DECLARADOS.
create or replace function public.costo_completo_de(
  p_ml numeric, p_empaque numeric, p_liquido_por_ml numeric, p_mo_por_ml numeric,
  p_marbete numeric, p_caja numeric,
  p_precio_publico numeric, p_comision_dst numeric, p_factor_fiscal numeric)
returns table (
  costo_liquido numeric, costo_mano_obra numeric, costo_total numeric,
  precio_distribuidor numeric, base_fiscal numeric,
  margen_publico numeric, margen_publico_pct numeric,
  margen_distribuidor numeric, margen_distribuidor_pct numeric,
  margen_publico_fiscal numeric, margen_publico_fiscal_pct numeric,
  faltan text[], costo_completo boolean)
language sql immutable
as $$
  with c as (
    select p_ml * p_liquido_por_ml as liq,
           p_ml * p_mo_por_ml      as mo,
           p_empaque + p_ml * p_liquido_por_ml + p_ml * p_mo_por_ml
             + coalesce(p_marbete, 0) + coalesce(p_caja, 0) as total,
           ceil(p_precio_publico * (1 - p_comision_dst)) as dst,
           round(p_precio_publico / p_factor_fiscal, 2)  as base,
           array_remove(array[
             case when p_empaque is null then 'empaque' end,
             case when p_liquido_por_ml is null then 'liquido' end,
             case when p_mo_por_ml is null then 'mano_de_obra' end,
             case when p_marbete is null then 'marbete' end,
             case when p_caja is null then 'caja' end], null) as faltan
  )
  select round(liq, 2), round(mo, 2), round(total, 2), dst, base,
         round(p_precio_publico - total, 2), round((p_precio_publico - total) / nullif(p_precio_publico, 0) * 100, 1),
         round(dst - total, 2),              round((dst - total) / nullif(dst, 0) * 100, 1),
         round(base - total, 2),             round((base - total) / nullif(base, 0) * 100, 1),
         faltan, cardinality(faltan) = 0
  from c
$$;

revoke all on function public.costo_completo_de(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.costo_completo_de(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated, service_role;

-- 6. `v_lote_rendimiento`: el agua deja de ser un faltante ---------------------
-- Mismas columnas, mismo orden; solo cambian los dos FILTER de `entradas`.
create or replace view public.v_lote_rendimiento
with (security_invoker = true) as
 WITH entradas AS (
         SELECT e.id_lote,
            round(sum(e.cantidad * COALESCE(p.costo_unitario, 0::numeric)), 4) AS costo_conocido,
            count(*) FILTER (WHERE COALESCE(p.costo_unitario, 0::numeric) = 0::numeric AND NOT p.costo_cero_confirmado) AS insumos_sin_costo,
            string_agg(p.sku::text, ', '::text ORDER BY (p.sku::text)) FILTER (WHERE COALESCE(p.costo_unitario, 0::numeric) = 0::numeric AND NOT p.costo_cero_confirmado) AS faltan_costo,
            sum(e.cantidad) FILTER (WHERE p.sku::text = 'chile-guajillo'::text) AS kg_chile
           FROM lote_entradas e
             JOIN catalogo_productos p ON p.id = e.id_insumo
          GROUP BY e.id_lote
        ), salidas AS (
         SELECT lote_salidas.id_lote,
            sum(lote_salidas.litros) AS litros,
            count(*) AS tandas,
            round(sum(lote_salidas.litros * COALESCE(lote_salidas.grado_alcohol, 0::numeric)) / NULLIF(sum(lote_salidas.litros), 0::numeric), 2) AS grado_ponderado,
            round(sum(lote_salidas.litros * COALESCE(lote_salidas.grado_alcohol, 0::numeric)) / 100::numeric, 4) AS alcohol_absoluto_l,
            count(*) FILTER (WHERE lote_salidas.grado_alcohol IS NULL) AS tandas_sin_grado
           FROM lote_salidas
          GROUP BY lote_salidas.id_lote
        ), envasado AS (
         SELECT v.id_lote,
            sum(v.botellas) AS botellas,
            sum(v.botellas::numeric * p.ml_por_unidad) AS ml_envasados,
            count(*) FILTER (WHERE p.ml_por_unidad IS NULL) AS formatos_sin_ml
           FROM lote_envasado v
             JOIN catalogo_productos p ON p.id = v.id_producto
          GROUP BY v.id_lote
        )
 SELECT l.id,
    l.codigo_lote,
    l.fecha_inicio,
    l.fecha_fin_fermentacion,
    COALESCE(l.horas_fermentacion, ((l.fecha_fin_fermentacion - l.fecha_inicio) * 24)::numeric) AS horas_fermentacion,
    en.kg_chile,
    s.litros AS litros_producidos,
    s.tandas,
    s.grado_ponderado,
    ev.botellas,
    ev.ml_envasados,
    round(s.litros / NULLIF(en.kg_chile, 0::numeric), 4) AS litros_por_kg_chile,
    round(1::numeric - ev.ml_envasados / NULLIF(s.litros * 1000::numeric, 0::numeric), 4) AS merma_envasado,
    en.costo_conocido AS costo_insumos_conocido,
    en.insumos_sin_costo,
    en.faltan_costo,
        CASE
            WHEN en.insumos_sin_costo = 0 AND COALESCE(ev.formatos_sin_ml, 0::bigint) = 0 THEN round(en.costo_conocido / NULLIF(ev.ml_envasados, 0::numeric), 6)
            ELSE NULL::numeric
        END AS costo_por_ml,
    g.grado_objetivo,
    s.alcohol_absoluto_l,
    s.tandas_sin_grado,
    round(s.alcohol_absoluto_l / NULLIF(g.grado_objetivo / 100::numeric, 0::numeric), 4) AS litros_al_grado_objetivo,
    round(s.alcohol_absoluto_l / NULLIF(g.grado_objetivo / 100::numeric, 0::numeric) / 0.75, 2) AS botellas_750_teoricas,
        CASE
            WHEN s.tandas_sin_grado = 0 AND en.insumos_sin_costo = 0 THEN round(en.costo_conocido / NULLIF(s.alcohol_absoluto_l / (g.grado_objetivo / 100::numeric) * 1000::numeric, 0::numeric), 6)
            ELSE NULL::numeric
        END AS costo_por_ml_al_grado_objetivo,
    s.grado_ponderado >= g.grado_objetivo AS alcanza_el_grado_diluyendo
   FROM lotes l
     CROSS JOIN ( SELECT 38.0 AS grado_objetivo) g
     LEFT JOIN entradas en ON en.id_lote = l.id
     LEFT JOIN salidas s ON s.id_lote = l.id
     LEFT JOIN envasado ev ON ev.id_lote = l.id;

-- 7. La vista del costo completo ----------------------------------------------
-- Liquido: el ULTIMO lote real con `costo_por_ml` (por fecha_inicio) reemplaza
-- al estandar; `fuente_costo_liquido` dice cual se uso.
-- Mano de obra: por ml de liquido (nomina / capacidad / 750). Es el supuesto
-- de MARGENES §6: llenar 15 de 50 ml cuesta mas trabajo que una de 750, asi
-- que el costo del 50 ml esta SUBESTIMADO. Se deja visible, no se corrige.
create or replace view public.v_costo_completo
with (security_invoker = true) as
with par as (
  select max(valor) filter (where clave = 'nomina_mensual')               as nomina,
         max(valor) filter (where clave = 'capacidad_botellas_750_mes')   as capacidad,
         max(valor) filter (where clave = 'ml_lote_estandar')             as ml_lote,
         max(valor) filter (where clave = 'comision_dst_estandar')        as comision,
         max(valor) filter (where clave = 'factor_reconstruccion_fiscal') as factor,
         max(valor) filter (where clave = 'costo_marbete_por_botella')    as marbete,
         max(valor) filter (where clave = 'costo_caja_por_botella')       as caja
  from parametros_costo
), liquido_std as (
  select case when count(*) filter (where coalesce(c.costo_unitario, 0) = 0 and not c.costo_cero_confirmado) = 0
              then sum(coalesce(r.cantidad_por_lote, 0) * coalesce(c.costo_unitario, 0)) end as costo_lote
  from receta_liquido_estandar r
  join catalogo_productos c on c.id = r.id_insumo
), lote_real as (
  select codigo_lote, costo_por_ml
  from v_lote_rendimiento
  where costo_por_ml is not null
  order by fecha_inicio desc nulls last
  limit 1
), empaque as (
  select r.id_producto_terminado as id,
         case when count(*) filter (where coalesce(i.costo_unitario, 0) = 0 and not i.costo_cero_confirmado) = 0
              then sum(r.cantidad_requerida * i.costo_unitario) end as costo,
         string_agg(i.sku::text, ', ' order by i.sku)
           filter (where coalesce(i.costo_unitario, 0) = 0 and not i.costo_cero_confirmado) as sin_costo
  from recetas_produccion r
  join catalogo_productos i on i.id = r.id_insumo
  group by r.id_producto_terminado
)
select pt.id as id_producto,
       pt.sku,
       pt.nombre,
       pt.ml_por_unidad as ml,
       round(e.costo, 2) as costo_empaque,
       e.sin_costo as empaque_sin_costo,
       case when lr.costo_por_ml is not null then 'LOTE_REAL' else 'ESTANDAR' end as fuente_costo_liquido,
       lr.codigo_lote as lote_usado,
       round(coalesce(lr.costo_por_ml, ls.costo_lote / nullif(par.ml_lote, 0)), 6) as liquido_por_ml,
       k.costo_liquido,
       k.costo_mano_obra,
       par.marbete as costo_marbete,
       par.caja as costo_caja,
       k.costo_total,
       lp.precio_final as precio_publico,
       k.precio_distribuidor,
       k.base_fiscal,
       k.margen_publico, k.margen_publico_pct,
       k.margen_distribuidor, k.margen_distribuidor_pct,
       k.margen_publico_fiscal, k.margen_publico_fiscal_pct,
       k.faltan,
       k.costo_completo,
       par.capacidad as capacidad_supuesta_botellas_750_mes
from catalogo_productos pt
cross join par
cross join liquido_std ls
left join lote_real lr on true
left join empaque e on e.id = pt.id
left join listas_precios lp on lp.id_producto = pt.id and lp.zona::text = 'Zacatecas'
cross join lateral public.costo_completo_de(
  pt.ml_por_unidad, e.costo,
  coalesce(lr.costo_por_ml, ls.costo_lote / nullif(par.ml_lote, 0)),
  par.nomina / nullif(par.capacidad * 750, 0),
  par.marbete, par.caja,
  lp.precio_final, par.comision, par.factor) k
where pt.tipo = 'TERMINADO' and pt.ml_por_unidad is not null;

grant select on public.v_costo_completo to authenticated, service_role;

comment on view public.v_costo_completo is
  'Fase 8 D85: costo completo y margen por presentacion. Fuentes en parametros_costo '
  'y receta_liquido_estandar. faltan/costo_completo dicen lo que no se sabe.';
