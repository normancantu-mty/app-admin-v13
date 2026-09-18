-- ERP-26, parte 2: el chile entra al catalogo, y la vista deja de creerse completa.
--
-- Escrito el 2026-09-17 por el Socio Estrategico. Aplicada con apply_migration del MCP.
--
-- EL DEFECTO QUE ARREGLA, Y ES DE LA MIGRACION ANTERIOR, MIA
-- ---------------------------------------------------------------------------
-- `v_costo_produccion` (20260918022847) declara el costo COMPLETO cuando todos
-- los insumos DE LA RECETA tienen precio. Eso protege contra un costo faltante,
-- pero NO contra un RENGLON faltante: hoy ninguna receta incluye el liquido, asi
-- que en cuanto se carguen los precios del empaque la vista anunciaria un margen
-- "completo" que solo cuenta vidrio, tapa, etiqueta y lamina. **Un margen al que
-- le falta la materia prima no esta aproximado: esta inflado**, y es exactamente
-- la cifra que se le ensena a alguien que va a poner dinero.
--
-- La guarda nueva: el costo se declara completo solo si la receta contiene **al
-- menos un insumo marcado como materia prima**. Mientras el chile no este en la
-- receta, el margen sale NULL aunque todo el empaque tenga precio.
--
-- POR QUE EL CHILE ENTRA AHORA Y SU RECETA NO
-- ---------------------------------------------------------------------------
-- Norman, en el chat del 2026-09-17: *"El Chile no estoy muy seguro, pero si yo
-- digo que si hay que meterlo"*. Se crea el SKU, que es lo que habilita capturar
-- la compra. **No se escribe el renglon de receta**, porque eso exige saber
-- cuantos kilos van por botella y eso NO se sabe: las fuentes hablan de 12 kg
-- por LOTE, y cuantas botellas salen de un lote no esta escrito en ningun lado.
-- Inventar ese numero contaminaria el COGS entero.
--
-- DE DONDE SALE CADA COSTO NUEVO
--   chile-guajillo  75.00 MXN/kg  Fresnillo/Negocio/MARGENES_2026-09-02.md,
--                                 dictado por Norman el 2026-09-02.
--   mosto-1         24.00 MXN/kg  DERIVADO DE UNA COMPRA REAL: el ticket
--                                 44a25b51 que Norman capturo por voz el
--                                 2026-09-12, 2,400 MXN por 100 kg. Existe
--                                 tambien un 25.00 dictado el 09-02; gana el 24
--                                 por jerarquia -verificacion mas reciente- y
--                                 porque es una transaccion, no una estimacion.
--
-- Lo que NO se crea, y se declara: **alcohol / etanol / neutro**. Cero menciones
-- como insumo comprado en todo el arbol, y la FICHA describe el proceso como
-- coccion -> fermentacion propia -> destilacion, no dilucion de alcohol comprado.
-- Probablemente ese SKU no debe existir, pero eso lo confirma Norman.
--
-- ES ADITIVA: ADD COLUMN con default, INSERT de dos SKU nuevos, y CREATE OR
-- REPLACE de una vista que yo mismo cree hace diez minutos. No borra ni altera
-- ninguna fila existente.
--
-- ROLLBACK:
--   delete from public.catalogo_productos where sku in ('chile-guajillo','mosto-1');
--   alter table public.catalogo_productos drop column if exists es_materia_prima;
--   (y re-aplicar la vista de 20260918022847)

alter table public.catalogo_productos
  add column if not exists es_materia_prima boolean not null default false;

comment on column public.catalogo_productos.es_materia_prima is
  'ERP-26. TRUE = es el contenido, no el envase. v_costo_produccion se niega a declarar un costo completo si la receta no incluye al menos uno.';

insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario, es_materia_prima)
values
  ('chile-guajillo', 'Chile Guajillo', 'INSUMO', 'KILOGRAMOS', 75.00, true),
  ('mosto-1',        'Aditivo Mosto 1', 'INSUMO', 'KILOGRAMOS', 24.00, true)
on conflict (sku) do nothing;

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
        and bool_or(pi.es_materia_prima)
       then round(sum(r.cantidad_requerida * pi.costo_unitario), 4)
  end                                     as costo_insumos,
  lp.precio_final                         as precio_zacatecas,
  case when count(*) filter (where coalesce(pi.costo_unitario, 0) = 0) = 0
        and bool_or(pi.es_materia_prima)
        and lp.precio_final is not null
       then round(lp.precio_final - sum(r.cantidad_requerida * pi.costo_unitario), 4)
  end                                     as margen_bruto_antes_de_impuestos,
  -- Va al FINAL y no en medio a proposito: `create or replace view` no deja
  -- insertar una columna entre dos que ya existen, y tirar la vista para
  -- recrearla metaria un DROP en una migracion que se declara aditiva.
  bool_or(pi.es_materia_prima)            as receta_incluye_materia_prima
from public.recetas_produccion r
  join public.catalogo_productos pt on pt.id = r.id_producto_terminado
  join public.catalogo_productos pi on pi.id = r.id_insumo
  left join public.listas_precios lp
    on lp.id_producto = pt.id and lp.zona = 'Zacatecas'
group by pt.id, pt.sku, pt.nombre, lp.precio_final;

comment on view public.v_costo_produccion is
  'ERP-26. Costo de cada terminado calculado desde recetas_produccion. costo_insumos y margen salen NULL si falta el costo de un insumo O si la receta no incluye materia prima: un margen sin el liquido esta inflado, no aproximado.';

revoke all on public.v_costo_produccion from public, anon;
grant select on public.v_costo_produccion to authenticated, service_role;
