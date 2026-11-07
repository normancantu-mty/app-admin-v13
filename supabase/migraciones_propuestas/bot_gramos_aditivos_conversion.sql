-- PROPUESTA, NO APLICADA. Escrito el 2026-11-07 por el ejecutor del Socio (Fase 7A).
-- LA DECIDE NORMAN: cambia cifras de costo e inventario.
--
-- El 2026-11-07 Aditivo 1 (mosto-1) y Aditivo 2 (aditivo-2) pasaron de
-- KILOGRAMOS a GRAMOS SIN convertir cantidades. Lo que quedo en kilos y ahora
-- se lee en gramos (SELECT de solo lectura del 2026-11-07):
--
--   catalogo_productos.costo_unitario  mosto-1 = 24.00  aditivo-2 = 35.00   (eran $/kg; hoy se leen $/g)
--   inventario_ledger ENTRADA_COMPRA   mosto-1 = 10     aditivo-2 = 180     (eran kg;   hoy se leen g)
--   receta_liquido_estandar            mosto-1 = 8 ("~8 kg de aditivo")     (hoy se lee 8 g)
--
-- Efecto si no se toca: el bot (Fase 7A) ya escribe el aditivo en GRAMOS
-- (8 kg dichos -> 8000). `v_lote_rendimiento` multiplica cantidad x
-- costo_unitario: 8000 x 24 = $192,000 en vez de $192. Y el stock de insumos
-- queda en 10 g / 180 g.
--
-- Si Norman confirma que esas cifras eran kilos, esta es la conversion (todo o nada):

begin;

update public.catalogo_productos
   set costo_unitario = round(costo_unitario / 1000, 6)
 where sku in ('mosto-1', 'aditivo-2')
   and unidad_medida = 'GRAMOS';

update public.inventario_ledger il
   set cantidad = il.cantidad * 1000
  from public.catalogo_productos p
 where p.id = il.id_producto
   and p.sku in ('mosto-1', 'aditivo-2')
   and il.fecha_movimiento < timestamptz '2026-11-07 00:00:00-06';

update public.receta_liquido_estandar r
   set cantidad_por_lote = r.cantidad_por_lote * 1000,
       fuente = coalesce(r.fuente, '') || ' [convertido a g el 2026-11-07]'
  from public.catalogo_productos p
 where p.id = r.id_insumo
   and p.sku = 'mosto-1';

commit;
