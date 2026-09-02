-- ============================================================================
-- MIGRATION: update-catalog-pasta-recipe.sql
-- Purpose   : Update Plata zone prices, add pasta packaging SKUs + finished
--             good, wire BOM recipe for B-MVP-Pasta2kg.
-- Idempotent: Safe to run multiple times (ON CONFLICT / WHERE NOT EXISTS).
-- Run via   : Supabase SQL editor.
-- ============================================================================
--
-- SCHEMA NOTES (verified against live public.* constraints):
--   catalogo_productos : UNIQUE(sku); CHECK tipo IN ('INSUMO','TERMINADO')
--   listas_precios     : CHECK zona IN ('Zacatecas','Foraneo')
--   recetas_produccion : FK id_producto_terminado, id_insumo → catalogo_productos
--
-- Packaging SKUs use tipo='INSUMO' to stay compatible with frontend filters
-- (compra insumos, inventario KPIs, production BOM).
-- Unidad: DB convention is uppercase 'PIEZAS'.
-- ============================================================================

BEGIN;

-- ── 1) UPDATE existing Plata retail prices (Zacatecas + Foraneo) ────────────
UPDATE public.listas_precios AS lp
SET precio_final = v.nuevo_precio
FROM public.catalogo_productos AS cp
JOIN (
  VALUES
    ('plata-250ml', 'Zacatecas', 179.00),
    ('plata-250ml', 'Foraneo',   199.00),
    ('plata-50ml',  'Zacatecas',  69.00),
    ('plata-50ml',  'Foraneo',    99.00),
    ('plata-750ml', 'Zacatecas', 599.00),
    ('plata-750ml', 'Foraneo',   799.00)
) AS v(sku, zona, nuevo_precio)
  ON cp.sku = v.sku
WHERE lp.id_producto = cp.id
  AND lp.zona = v.zona
  AND lp.precio_final IS DISTINCT FROM v.nuevo_precio;

-- ── 2) INSERT new packaging SKUs (INSUMO — compatible with frontend filters) ─
INSERT INTO public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario)
VALUES
  ('Etiqueta-pasta', 'Etiqueta-pasta', 'INSUMO', 'PIEZAS', 0.00),
  ('Bolsa-pasta',    'Bolsa-pasta',    'INSUMO', 'PIEZAS', 0.00)
ON CONFLICT (sku) DO UPDATE
SET
  nombre        = EXCLUDED.nombre,
  tipo          = EXCLUDED.tipo,
  unidad_medida = EXCLUDED.unidad_medida;

-- ── 3) INSERT new finished good (Pasta 2kg) ───────────────────────────────────
INSERT INTO public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario)
VALUES
  ('B-MVP-Pasta2kg', 'Pasta-Guajillo-2kg', 'TERMINADO', 'PIEZAS', 0.00)
ON CONFLICT (sku) DO UPDATE
SET
  nombre        = EXCLUDED.nombre,
  tipo          = EXCLUDED.tipo,
  unidad_medida = EXCLUDED.unidad_medida;

-- ── 4) INSERT zone prices for B-MVP-Pasta2kg ($130 both zones) ────────────────
INSERT INTO public.listas_precios (id_producto, zona, precio_final)
SELECT cp.id, v.zona, v.precio_final
FROM public.catalogo_productos AS cp
CROSS JOIN (
  VALUES
    ('Zacatecas', 130.00),
    ('Foraneo',   130.00)
) AS v(zona, precio_final)
WHERE cp.sku = 'B-MVP-Pasta2kg'
  AND NOT EXISTS (
    SELECT 1
    FROM public.listas_precios AS lp
    WHERE lp.id_producto = cp.id
      AND lp.zona = v.zona
  );

UPDATE public.listas_precios AS lp
SET precio_final = 130.00
FROM public.catalogo_productos AS cp
WHERE lp.id_producto = cp.id
  AND cp.sku = 'B-MVP-Pasta2kg'
  AND lp.zona IN ('Zacatecas', 'Foraneo')
  AND lp.precio_final IS DISTINCT FROM 130.00;

-- ── 5) BOM recipe: B-MVP-Pasta2kg ← 1× Etiqueta-pasta + 1× Bolsa-pasta ─────
DELETE FROM public.recetas_produccion
WHERE id_producto_terminado = (
  SELECT id FROM public.catalogo_productos WHERE sku = 'B-MVP-Pasta2kg'
);

INSERT INTO public.recetas_produccion (id_producto_terminado, id_insumo, cantidad_requerida)
SELECT
  pt.id,
  ins.id,
  v.cantidad
FROM public.catalogo_productos AS pt
CROSS JOIN (
  VALUES
    ('Etiqueta-pasta', 1.0000),
    ('Bolsa-pasta',    1.0000)
) AS v(insumo_sku, cantidad)
JOIN public.catalogo_productos AS ins
  ON ins.sku = v.insumo_sku
WHERE pt.sku = 'B-MVP-Pasta2kg';

COMMIT;

-- ── Verification queries (run manually after COMMIT) ────────────────────────
-- SELECT cp.sku, lp.zona, lp.precio_final
-- FROM listas_precios lp
-- JOIN catalogo_productos cp ON cp.id = lp.id_producto
-- WHERE cp.sku LIKE 'plata-%' OR cp.sku = 'B-MVP-Pasta2kg'
-- ORDER BY cp.sku, lp.zona;
--
-- SELECT pt.sku AS terminado, ins.sku AS insumo, rp.cantidad_requerida
-- FROM recetas_produccion rp
-- JOIN catalogo_productos pt ON pt.id = rp.id_producto_terminado
-- JOIN catalogo_productos ins ON ins.id = rp.id_insumo
-- WHERE pt.sku = 'B-MVP-Pasta2kg';
