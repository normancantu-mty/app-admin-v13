-- Insumos del lote en GRAMOS, costos a 4 decimales, y litros y nota por garrafa (2026-11-10).
-- APLICADA el 2026-11-10 con aprobacion de Norman (version 20261110195229).
-- Reversa: supabase/ROLLBACK_unidades_lotes_2026-11-10.sql
--
-- Norman (2026-11-10): "que aditivo 1 y aditivo 2 mejor si los registre como
-- gramos en el erp, pero que el bot los interprete [...] Quiero que las
-- existencias las tome de las que ya estan registradas en inventario. Levadura
-- y enzimas que igual sea en gramos, tanto en inventario como en lote".
-- Respuestas de Norman: costo por gramo a "4 decimales"; un numero sin unidad,
-- el bot "pregunta g o kg".
--
-- El problema que arregla: los precios del catalogo estaban POR KILO (aditivo 1
-- $24/kg, aditivo 2 $35/kg, levadura $1,580/kg) pero el aditivo ya se contaba
-- en GRAMOS: el costo de insumos de L-10-11.1 salia 8000 g x $24 = $192,000.
-- Despues: 8000 x $0.024 + 8 kg chile x $75 = $792.
--
-- Que hace (todo en una transaccion):
--   1. costo_unitario (catalogo) y costo_unitario_movimiento (inventario) pasan
--      de numeric(12,2) a numeric(14,4): $0.024/g no cabe en 2 decimales. Las 3
--      vistas que leen el costo del catalogo se tiran y se recrean IGUALES
--      (definicion, security_invoker, comentario y permisos leidos de la base el
--      2026-11-10). Nada mas depende de esas columnas (pg_depend).
--   2. catalogo: aditivo 1 y 2 siguen en GRAMOS; su precio pasa a por gramo
--      ($24/kg -> $0.024/g, $35/kg -> $0.035/g). Levadura KILOGRAMOS -> GRAMOS,
--      $1,580/kg -> $1.58/g.
--   3. inventario_ledger: las existencias se quedan COMO ESTAN registradas (en
--      el catalogo en gramos: aditivo 1 = 100 g, aditivo 2 = 180 g); solo su
--      costo pasa a por gramo. La levadura 0.5 kg -> 500 g a $1.58 (mismo valor).
--      Sin ajustes (un AJUSTE solo lo hace un ADMIN con sesion).
--   4. lote_entradas: los aditivos ya estan en gramos (L-10-11.1: 8000) y no se
--      tocan; la levadura que hubiera en kilos pasa a gramos (hoy: ninguna).
--   5. receta_liquido_estandar: aditivo 1 8 (kg) -> 8000 g; levadura 0.02 kg -> 20 g.
--   6. registrar_etapa_lote: la garrafa trae litros y nota; se escriben en
--      lote_salidas (antes litros iba NULL y la nota se perdia).
--
-- ORDEN AL DESPLEGAR: primero esta migracion, luego reiniciar el bot con el
-- codigo nuevo. Al reves, un lote dictado entre los dos pasos quedaria mal.

begin;

-- 1. Costos a 4 decimales. Las vistas primero (v_costo_completo lee v_lote_rendimiento).
drop view public.v_costo_completo;
drop view public.v_costo_produccion;
drop view public.v_lote_rendimiento;

alter table public.catalogo_productos alter column costo_unitario type numeric(14,4);
alter table public.inventario_ledger alter column costo_unitario_movimiento type numeric(14,4);

create view public.v_lote_rendimiento with (security_invoker = true) as
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

comment on view public.v_lote_rendimiento is 'ERP-84. Rendimiento y costo de cada lote. costo_por_ml sale NULL si algun insumo del lote no tiene costo o si algun formato envasado no declara ml_por_unidad: la misma regla que v_costo_produccion, por la misma razon -un costo al que le falta un renglon esta inflado, no aproximado-.';

create view public.v_costo_produccion with (security_invoker = true) as
 SELECT pt.id AS id_producto_terminado,
    pt.sku,
    pt.nombre,
    count(*) AS insumos_en_receta,
    count(*) FILTER (WHERE COALESCE(pi.costo_unitario, 0::numeric) = 0::numeric) AS insumos_sin_costo,
    string_agg(pi.sku::text, ', '::text ORDER BY (pi.sku::text)) FILTER (WHERE COALESCE(pi.costo_unitario, 0::numeric) = 0::numeric) AS faltan_costo,
    round(sum(r.cantidad_requerida * COALESCE(pi.costo_unitario, 0::numeric)), 4) AS costo_parcial_conocido,
        CASE
            WHEN count(*) FILTER (WHERE COALESCE(pi.costo_unitario, 0::numeric) = 0::numeric) = 0 AND bool_or(pi.es_materia_prima) THEN round(sum(r.cantidad_requerida * pi.costo_unitario), 4)
            ELSE NULL::numeric
        END AS costo_insumos,
    lp.precio_final AS precio_zacatecas,
        CASE
            WHEN count(*) FILTER (WHERE COALESCE(pi.costo_unitario, 0::numeric) = 0::numeric) = 0 AND bool_or(pi.es_materia_prima) AND lp.precio_final IS NOT NULL THEN round(lp.precio_final - sum(r.cantidad_requerida * pi.costo_unitario), 4)
            ELSE NULL::numeric
        END AS margen_bruto_antes_de_impuestos,
    bool_or(pi.es_materia_prima) AS receta_incluye_materia_prima
   FROM recetas_produccion r
     JOIN catalogo_productos pt ON pt.id = r.id_producto_terminado
     JOIN catalogo_productos pi ON pi.id = r.id_insumo
     LEFT JOIN listas_precios lp ON lp.id_producto = pt.id AND lp.zona::text = 'Zacatecas'::text
  GROUP BY pt.id, pt.sku, pt.nombre, lp.precio_final;

comment on view public.v_costo_produccion is 'ERP-26. Costo de cada terminado calculado desde recetas_produccion. costo_insumos y margen salen NULL si falta el costo de un insumo O si la receta no incluye materia prima: un margen sin el liquido esta inflado, no aproximado.';

create view public.v_costo_completo with (security_invoker = true) as
 WITH par AS (
         SELECT max(parametros_costo.valor) FILTER (WHERE parametros_costo.clave = 'nomina_mensual'::text) AS nomina,
            max(parametros_costo.valor) FILTER (WHERE parametros_costo.clave = 'capacidad_botellas_750_mes'::text) AS capacidad,
            max(parametros_costo.valor) FILTER (WHERE parametros_costo.clave = 'ml_lote_estandar'::text) AS ml_lote,
            max(parametros_costo.valor) FILTER (WHERE parametros_costo.clave = 'comision_dst_estandar'::text) AS comision,
            max(parametros_costo.valor) FILTER (WHERE parametros_costo.clave = 'factor_reconstruccion_fiscal'::text) AS factor,
            max(parametros_costo.valor) FILTER (WHERE parametros_costo.clave = 'costo_marbete_por_botella'::text) AS marbete,
            max(parametros_costo.valor) FILTER (WHERE parametros_costo.clave = 'costo_caja_por_botella'::text) AS caja
           FROM parametros_costo
        ), liquido_std AS (
         SELECT
                CASE
                    WHEN count(*) FILTER (WHERE COALESCE(c.costo_unitario, 0::numeric) = 0::numeric AND NOT c.costo_cero_confirmado) = 0 THEN sum(COALESCE(r.cantidad_por_lote, 0::numeric) * COALESCE(c.costo_unitario, 0::numeric))
                    ELSE NULL::numeric
                END AS costo_lote
           FROM receta_liquido_estandar r
             JOIN catalogo_productos c ON c.id = r.id_insumo
        ), lote_real AS (
         SELECT v_lote_rendimiento.codigo_lote,
            v_lote_rendimiento.costo_por_ml
           FROM v_lote_rendimiento
          WHERE v_lote_rendimiento.costo_por_ml IS NOT NULL
          ORDER BY v_lote_rendimiento.fecha_inicio DESC NULLS LAST
         LIMIT 1
        ), empaque AS (
         SELECT r.id_producto_terminado AS id,
                CASE
                    WHEN count(*) FILTER (WHERE COALESCE(i.costo_unitario, 0::numeric) = 0::numeric AND NOT i.costo_cero_confirmado) = 0 THEN sum(r.cantidad_requerida * i.costo_unitario)
                    ELSE NULL::numeric
                END AS costo,
            string_agg(i.sku::text, ', '::text ORDER BY i.sku) FILTER (WHERE COALESCE(i.costo_unitario, 0::numeric) = 0::numeric AND NOT i.costo_cero_confirmado) AS sin_costo
           FROM recetas_produccion r
             JOIN catalogo_productos i ON i.id = r.id_insumo
          GROUP BY r.id_producto_terminado
        )
 SELECT pt.id AS id_producto,
    pt.sku,
    pt.nombre,
    pt.ml_por_unidad AS ml,
    round(e.costo, 2) AS costo_empaque,
    e.sin_costo AS empaque_sin_costo,
        CASE
            WHEN lr.costo_por_ml IS NOT NULL THEN 'LOTE_REAL'::text
            ELSE 'ESTANDAR'::text
        END AS fuente_costo_liquido,
    lr.codigo_lote AS lote_usado,
    round(COALESCE(lr.costo_por_ml, ls.costo_lote / NULLIF(par.ml_lote, 0::numeric)), 6) AS liquido_por_ml,
    k.costo_liquido,
    k.costo_mano_obra,
    par.marbete AS costo_marbete,
    par.caja AS costo_caja,
    k.costo_total,
    lp.precio_final AS precio_publico,
    k.precio_distribuidor,
    k.base_fiscal,
    k.margen_publico,
    k.margen_publico_pct,
    k.margen_distribuidor,
    k.margen_distribuidor_pct,
    k.margen_publico_fiscal,
    k.margen_publico_fiscal_pct,
    k.faltan,
    k.costo_completo,
    par.capacidad AS capacidad_supuesta_botellas_750_mes
   FROM catalogo_productos pt
     CROSS JOIN par
     CROSS JOIN liquido_std ls
     LEFT JOIN lote_real lr ON true
     LEFT JOIN empaque e ON e.id = pt.id
     LEFT JOIN listas_precios lp ON lp.id_producto = pt.id AND lp.zona::text = 'Zacatecas'::text
     CROSS JOIN LATERAL costo_completo_de(pt.ml_por_unidad, e.costo, COALESCE(lr.costo_por_ml, ls.costo_lote / NULLIF(par.ml_lote, 0::numeric)), par.nomina / NULLIF(par.capacidad * 750::numeric, 0::numeric), par.marbete, par.caja, lp.precio_final, par.comision, par.factor) k(costo_liquido, costo_mano_obra, costo_total, precio_distribuidor, base_fiscal, margen_publico, margen_publico_pct, margen_distribuidor, margen_distribuidor_pct, margen_publico_fiscal, margen_publico_fiscal_pct, faltan, costo_completo)
  WHERE pt.tipo::text = 'TERMINADO'::text AND pt.ml_por_unidad IS NOT NULL;

comment on view public.v_costo_completo is 'Fase 8 D85: costo completo y margen por presentacion. Fuentes en parametros_costo y receta_liquido_estandar. faltan/costo_completo dicen lo que no se sabe.';

-- Los permisos de antes (information_schema.role_table_grants, 2026-11-10):
-- authenticated y service_role todo, gia_lectura solo SELECT, anon nada.
revoke all on public.v_lote_rendimiento, public.v_costo_produccion, public.v_costo_completo from public, anon;
grant all on public.v_lote_rendimiento, public.v_costo_produccion, public.v_costo_completo to authenticated, service_role;
grant select on public.v_lote_rendimiento, public.v_costo_produccion, public.v_costo_completo to gia_lectura;

-- 2. catalogo: precio por gramo. Cada update con su condicion de antes: si ya
--    cambio, no hace nada (y la verificacion de abajo lo grita).
update public.catalogo_productos set costo_unitario = 0.024
 where sku = 'mosto-1' and unidad_medida = 'GRAMOS' and costo_unitario = 24;
update public.catalogo_productos set costo_unitario = 0.035
 where sku = 'aditivo-2' and unidad_medida = 'GRAMOS' and costo_unitario = 35;
update public.catalogo_productos set unidad_medida = 'GRAMOS', costo_unitario = 1.58
 where sku = 'levadura-enzimas' and unidad_medida = 'KILOGRAMOS' and costo_unitario = 1580;

-- 3. inventario_ledger (sin rol de sesion el trigger de columnas protegidas no
--    aplica; la bitacora registra el antes y el despues de cada fila).
--    Aditivos: la cantidad NO se toca (las existencias, como estan); el costo
--    del movimiento pasa de por kilo a por gramo.
update public.inventario_ledger il
   set costo_unitario_movimiento = il.costo_unitario_movimiento / 1000,
       notas = coalesce(il.notas, '') || ' [2026-11-10: costo por kg -> por g]'
  from public.catalogo_productos p
 where p.id = il.id_producto and p.sku in ('mosto-1', 'aditivo-2')
   and coalesce(il.notas, '') not like '%[2026-11-10:%';
--    Levadura: kilos -> gramos, mismo valor.
update public.inventario_ledger il
   set cantidad = il.cantidad * 1000,
       costo_unitario_movimiento = il.costo_unitario_movimiento / 1000,
       notas = coalesce(il.notas, '') || ' [2026-11-10: kg -> g]'
  from public.catalogo_productos p
 where p.id = il.id_producto and p.sku = 'levadura-enzimas'
   and coalesce(il.notas, '') not like '%[2026-11-10:%';

-- 4. lote_entradas: la levadura que se haya escrito en kilos (el bot de antes
--    la mandaba en kilos) pasa a gramos. Los aditivos ya estan en gramos.
update public.lote_entradas e
   set cantidad = e.cantidad * 1000
  from public.catalogo_productos p
 where p.id = e.id_insumo and p.sku = 'levadura-enzimas';

-- 5. receta (fuente: "~8 kg" para el aditivo 1).
update public.receta_liquido_estandar r
   set cantidad_por_lote = r.cantidad_por_lote * 1000,
       fuente = r.fuente || ' | 2026-11-10: en gramos'
  from public.catalogo_productos p
 where p.id = r.id_insumo and p.sku in ('mosto-1', 'levadura-enzimas') and r.cantidad_por_lote < 100;

-- Verificacion: si algo no quedo como se espera, se deshace TODO.
do $$
declare
  v_malos int;
begin
  select count(*) into v_malos from public.catalogo_productos
   where (sku = 'mosto-1' and (unidad_medida <> 'GRAMOS' or costo_unitario <> 0.024))
      or (sku = 'aditivo-2' and (unidad_medida <> 'GRAMOS' or costo_unitario <> 0.035))
      or (sku = 'levadura-enzimas' and (unidad_medida <> 'GRAMOS' or costo_unitario <> 1.58));
  if v_malos > 0 then
    raise exception 'catalogo: % insumo(s) no quedaron en gramos con su precio por gramo', v_malos;
  end if;
  select count(*) into v_malos from public.receta_liquido_estandar r join public.catalogo_productos p on p.id = r.id_insumo
   where (p.sku = 'mosto-1' and r.cantidad_por_lote <> 8000) or (p.sku = 'levadura-enzimas' and r.cantidad_por_lote <> 20);
  if v_malos > 0 then
    raise exception 'receta: % renglon(es) no quedaron en gramos', v_malos;
  end if;
end $$;

-- 6. registrar_etapa_lote: litros y nota por garrafa
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

-- create or replace conserva los permisos; se repiten por si acaso (como en 20261019150000).
revoke all on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.registrar_etapa_lote(uuid, text, date, bigint, text, jsonb, jsonb, jsonb)
  to service_role;

commit;
