-- Semilla para probar la migracion 20261019150000 en el Postgres EFIMERO.
-- Escrito el 2026-10-19 por el ejecutor del Socio (lote v2, ronda 5).
-- El volcado es solo esquema; produccion SI tiene chile-guajillo (leido el
-- 2026-10-19: tipo INSUMO, KILOGRAMOS, es_materia_prima true). Sin el, la
-- seccion 8 de la migracion (chile-guajon copiado de chile-guajillo) no se
-- podria medir. NUNCA contra produccion.
insert into public.catalogo_productos (sku, nombre, tipo, unidad_medida, costo_unitario, es_materia_prima)
values ('chile-guajillo', 'Chile Guajillo', 'INSUMO', 'KILOGRAMOS', 75, true)
on conflict (sku) do nothing;
