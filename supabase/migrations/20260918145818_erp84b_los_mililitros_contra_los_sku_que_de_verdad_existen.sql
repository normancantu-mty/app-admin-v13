-- ERP-84b: los mililitros, ahora si, contra los SKU que de verdad existen.
--
-- Escrito el 2026-09-18 por el Socio Estrategico. Aplicada con apply_migration del MCP.
--
-- POR QUE EXISTE ESTA MIGRACION: UN ERROR MIO, DE HACE TRES MINUTOS
-- ---------------------------------------------------------------------------
-- La migracion `20260918145733` (ERP-84) creo `catalogo_productos.ml_por_unidad`
-- y la intento llenar con `where sku = 'plata-750'`. **Los SKU reales llevan
-- sufijo `ml`: `plata-50ml`, `plata-250ml`, `plata-750ml`.** El UPDATE caso con
-- cero filas, no fallo, y la columna quedo NULL en los tres terminados.
--
-- **El defecto no es la falta de ortografia: es que un UPDATE que no encuentra
-- nada se ve EXACTAMENTE igual que uno que funciono.** Cero filas no es un
-- error en SQL. Por eso esta migracion **se comprueba a si misma** y revienta
-- si no deja los tres formatos con su valor -que es lo que la anterior debio
-- haber hecho y no hizo-.
--
-- Lo cazo intentar usar la vista con datos reales, no releer el archivo.
--
-- ES ADITIVA EN LA PRACTICA, Y SE DICE CON PRECISION: es un UPDATE, y un UPDATE
-- no es aditivo. Pero la columna nacio hace tres minutos, **nunca ha contenido
-- un dato**, y el valor que se escribe no es una decision de negocio: una
-- botella de 750 ml contiene 750 ml. El deshacer es `set ml_por_unidad = null`.
--
-- ROLLBACK:
--   update public.catalogo_productos set ml_por_unidad = null
--    where sku in ('plata-50ml','plata-250ml','plata-750ml');

update public.catalogo_productos set ml_por_unidad =  50 where sku = 'plata-50ml';
update public.catalogo_productos set ml_por_unidad = 250 where sku = 'plata-250ml';
update public.catalogo_productos set ml_por_unidad = 750 where sku = 'plata-750ml';

do $$
declare
  v_ok integer;
begin
  select count(*) into v_ok
    from public.catalogo_productos
   where sku in ('plata-50ml','plata-250ml','plata-750ml')
     and ml_por_unidad is not null;

  if v_ok <> 3 then
    raise exception 'ERP-84b: esperaba 3 terminados con ml_por_unidad y hay %. La migracion NO se aplica.', v_ok;
  end if;

  select count(*) into v_ok
    from public.catalogo_productos
   where sku = 'plata-750ml' and ml_por_unidad = 750;

  if v_ok <> 1 then
    raise exception 'ERP-84b: plata-750ml no quedo en 750 ml. La migracion NO se aplica.';
  end if;
end $$;
