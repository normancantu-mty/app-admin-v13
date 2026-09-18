-- ERP-26: el costo de produccion se CALCULA de la receta, y se niega a fingir que esta completo.
--
-- Escrito el 2026-09-17 por el Socio Estrategico. Aplicada con apply_migration del MCP.
--
-- POR QUE UNA VISTA Y NO TECLEAR UN COSTO EN catalogo_productos.costo_unitario
-- ---------------------------------------------------------------------------
-- `recetas_produccion` ya existe y ya trae el desglose exacto de cada terminado.
-- Se verifico contra el ledger, por dos caminos independientes: los consumos
-- historicos de lamina de plata resuelven un sistema de tres ecuaciones cuyos
-- coeficientes son 0.0666 / 0.3333 / 1.0000 por botella de 50 / 250 / 750 ml,
-- que es EXACTAMENTE lo que dice la tabla. La receta no es una suposicion.
--
-- Con eso, el costo de un terminado es una CUENTA, no un dato que se captura:
-- suma de (cantidad_requerida * costo_unitario del insumo). Teclearlo a mano en
-- `costo_unitario` seria una segunda fuente de verdad que se desincroniza en
-- cuanto suba el vidrio.
--
-- Y HAY UNA RAZON MAS FUERTE PARA NO TOCAR catalogo_productos.costo_unitario
-- ---------------------------------------------------------------------------
-- Esa columna NO significa costo en todo el codigo. Medido, no recordado:
--   lib/pricing-waterfall.ts:33     la usa como COSTO (tuCostoNeto). Correcto.
--   app/actions/auditoria.ts:301    la usa como PRECIO de cobranza de emergencia
--                                   cuando falta el precio de lista de Zacatecas.
--   app/dashboard/inventario/page.tsx:217  la usa como PRECIO de respaldo para
--                                   valuar el inventario terminado.
-- O sea que subir el "costo" de un terminado tambien subiria lo que se le cobra
-- a un distribuidor y el valor declarado del inventario. Hoy no explota porque
-- los 4 terminados tienen precio de lista en Zacatecas y el respaldo nunca se
-- dispara -verificado-, pero el dia que nazca un producto sin precio de lista,
-- el sistema cobraria al costo en silencio. Esta vista deja esa columna en paz.
--
-- LO QUE LA VISTA SE NIEGA A HACER, Y ES SU RAZON DE SER
-- ---------------------------------------------------------------------------
-- Si un solo insumo de la receta tiene costo 0, el costo total y el margen salen
-- en NULL, no en un numero optimista. Un margen calculado sobre una receta
-- incompleta no esta "aproximado": esta INFLADO, y es justo la cifra que se le
-- ensena a alguien que va a poner dinero. La vista prefiere no contestar.
--
-- Y la incompletitud que hoy manda sobre todo lo demas: NINGUNA receta incluye
-- el liquido. No hay chile, ni alcohol, ni mosto, ni destilado a granel en
-- `catalogo_productos` ni en `recetas_produccion`. El desglose de una botella
-- de Destilado Plata dice hoy: vidrio, tapa, etiqueta y lamina. La columna
-- `insumos_en_receta` esta para que ese hueco se vea sin tener que saberlo.
--
-- ES ADITIVA: solo CREATE VIEW. No cambia ni una fila ni una columna.
-- ROLLBACK: drop view if exists public.v_costo_produccion;

create or replace view public.v_costo_produccion
with (security_invoker = true) as
select
  pt.id                                   as id_producto_terminado,
  pt.sku,
  pt.nombre,
  count(*)                                as insumos_en_receta,
  count(*) filter (where coalesce(pi.costo_unitario, 0) = 0) as insumos_sin_costo,
  string_agg(pi.sku, ', ' order by pi.sku)
    filter (where coalesce(pi.costo_unitario, 0) = 0)        as faltan_costo,
  round(sum(r.cantidad_requerida * coalesce(pi.costo_unitario, 0)), 4)
                                          as costo_parcial_conocido,
  case when count(*) filter (where coalesce(pi.costo_unitario, 0) = 0) = 0
       then round(sum(r.cantidad_requerida * pi.costo_unitario), 4)
  end                                     as costo_insumos,
  lp.precio_final                         as precio_zacatecas,
  case when count(*) filter (where coalesce(pi.costo_unitario, 0) = 0) = 0
        and lp.precio_final is not null
       then round(lp.precio_final - sum(r.cantidad_requerida * pi.costo_unitario), 4)
  end                                     as margen_bruto_antes_de_impuestos
from public.recetas_produccion r
  join public.catalogo_productos pt on pt.id = r.id_producto_terminado
  join public.catalogo_productos pi on pi.id = r.id_insumo
  left join public.listas_precios lp
    on lp.id_producto = pt.id and lp.zona = 'Zacatecas'
group by pt.id, pt.sku, pt.nombre, lp.precio_final;

comment on view public.v_costo_produccion is
  'ERP-26. Costo de cada terminado calculado desde recetas_produccion. Si un insumo de la receta no tiene costo, costo_insumos y margen salen NULL a proposito: un margen sobre receta incompleta esta inflado, no aproximado. Ojo: ninguna receta incluye todavia el liquido (chile/alcohol).';

revoke all on public.v_costo_produccion from public, anon;
grant select on public.v_costo_produccion to authenticated, service_role;
