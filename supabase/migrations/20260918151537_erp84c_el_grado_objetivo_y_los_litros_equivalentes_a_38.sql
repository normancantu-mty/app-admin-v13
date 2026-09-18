-- Norman, 2026-09-18: "a lo mejor te va a salir que son 10 L al 50% y otros 10 L
-- al 10% de alcohol, entonces tu tienes que hacer la conversion a 38%, que es el
-- valor de nuestro destilado, para asi generar todos los datos".
--
-- La unidad que hacia falta es el ALCOHOL ABSOLUTO: sum(litros * grado). Es lo
-- unico que se conserva al mezclar y al diluir, y por eso es lo unico que
-- compara dos lotes entre si. Los litros crudos no comparan nada: 20 L al 30%
-- y 20 L al 45% no son la misma produccion.
--
-- litros_al_grado_objetivo = alcohol_absoluto / 0.38 -> cuanto producto vendible
-- vale ese alcohol. Es una equivalencia CONTABLE.
--
-- Y la advertencia que solo se ve al escribir la formula: al agua se le puede
-- AGREGAR agua, nunca quitar. Una mezcla que quedo por DEBAJO de 38 no llega a
-- 38 diluyendo: o se mezcla con algo mas fuerte o se vuelve a destilar. Por eso
-- alcanza_el_grado_diluyendo existe, y por eso es booleano y no un adorno.
create or replace view public.v_lote_rendimiento
with (security_invoker = true) as
 with entradas as (
         select e.id_lote,
            round(sum(e.cantidad * coalesce(p.costo_unitario, 0::numeric)), 4) as costo_conocido,
            count(*) filter (where coalesce(p.costo_unitario, 0::numeric) = 0::numeric) as insumos_sin_costo,
            string_agg(p.sku::text, ', '::text order by (p.sku::text)) filter (where coalesce(p.costo_unitario, 0::numeric) = 0::numeric) as faltan_costo,
            sum(e.cantidad) filter (where p.sku::text = 'chile-guajillo'::text) as kg_chile
           from lote_entradas e
             join catalogo_productos p on p.id = e.id_insumo
          group by e.id_lote
        ), salidas as (
         select lote_salidas.id_lote,
            sum(lote_salidas.litros) as litros,
            count(*) as tandas,
            round(sum(lote_salidas.litros * coalesce(lote_salidas.grado_alcohol, 0::numeric)) / nullif(sum(lote_salidas.litros), 0::numeric), 2) as grado_ponderado,
            round(sum(lote_salidas.litros * coalesce(lote_salidas.grado_alcohol, 0::numeric)) / 100::numeric, 4) as alcohol_absoluto_l,
            count(*) filter (where lote_salidas.grado_alcohol is null) as tandas_sin_grado
           from lote_salidas
          group by lote_salidas.id_lote
        ), envasado as (
         select v.id_lote,
            sum(v.botellas) as botellas,
            sum(v.botellas::numeric * p.ml_por_unidad) as ml_envasados,
            count(*) filter (where p.ml_por_unidad is null) as formatos_sin_ml
           from lote_envasado v
             join catalogo_productos p on p.id = v.id_producto
          group by v.id_lote
        )
 select l.id,
    l.codigo_lote,
    l.fecha_inicio,
    l.fecha_fin_fermentacion,
    coalesce(l.horas_fermentacion, ((l.fecha_fin_fermentacion - l.fecha_inicio) * 24)::numeric) as horas_fermentacion,
    en.kg_chile,
    s.litros as litros_producidos,
    s.tandas,
    s.grado_ponderado,
    ev.botellas,
    ev.ml_envasados,
    round(s.litros / nullif(en.kg_chile, 0::numeric), 4) as litros_por_kg_chile,
    round(1::numeric - ev.ml_envasados / nullif(s.litros * 1000::numeric, 0::numeric), 4) as merma_envasado,
    en.costo_conocido as costo_insumos_conocido,
    en.insumos_sin_costo,
    en.faltan_costo,
        case
            when en.insumos_sin_costo = 0 and coalesce(ev.formatos_sin_ml, 0::bigint) = 0 then round(en.costo_conocido / nullif(ev.ml_envasados, 0::numeric), 6)
            else null::numeric
        end as costo_por_ml,
    g.grado_objetivo,
    s.alcohol_absoluto_l,
    s.tandas_sin_grado,
    round(s.alcohol_absoluto_l / nullif(g.grado_objetivo / 100::numeric, 0::numeric), 4) as litros_al_grado_objetivo,
    round(s.alcohol_absoluto_l / nullif(g.grado_objetivo / 100::numeric, 0::numeric) / 0.75, 2) as botellas_750_teoricas,
        case
            when s.tandas_sin_grado = 0 and en.insumos_sin_costo = 0 then round(en.costo_conocido / nullif(s.alcohol_absoluto_l / (g.grado_objetivo / 100::numeric) * 1000::numeric, 0::numeric), 6)
            else null::numeric
        end as costo_por_ml_al_grado_objetivo,
    (s.grado_ponderado >= g.grado_objetivo) as alcanza_el_grado_diluyendo
   from lotes l
     cross join ( select 38.0::numeric as grado_objetivo) g
     left join entradas en on en.id_lote = l.id
     left join salidas s on s.id_lote = l.id
     left join envasado ev on ev.id_lote = l.id;

grant select on public.v_lote_rendimiento to authenticated, service_role;
