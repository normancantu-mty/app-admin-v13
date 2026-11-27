-- Semilla para probar 20261127120000_comision_con_decimales.sql en el Postgres
-- EFIMERO (nunca en produccion). Se carga ANTES de la migracion, con las
-- columnas todavia en numeric(5,2). 2026-11-27.
--
-- Las 15 filas son los valores REALES de produccion (SELECT del 2026-11-27).
-- La 16 es el valor mas ancho que numeric(5,2) puede guardar (999.99): si ese
-- cabe exacto en numeric(7,4), cabe cualquiera.

CREATE TABLE semilla_comision (nombre text, rol text, cb numeric, cbl numeric, chl numeric, cl numeric);
INSERT INTO semilla_comision VALUES
  ('Ale Ortega Expressate','DST',0.20,0,0.15,0),
  ('Rey Tiburon','LOC',0,0.20,0,0),
  ('Delirio 85','LOC',0,0.20,0,0),
  ('Casa Verde','LOC',0,0.20,0,0),
  ('Martin Reyes','DST',0.20,0,0.15,0),
  ('Luis Rodriguez','DST',0.20,0,0.10,0),
  ('David Flores','DST',0.20,0,0.15,0),
  ('Aeropuerto','LOC',0,0.20,0,0),
  ('Dulceria el Eden','LOC',0,0.15,0,0),
  ('Dulceria ruiz','LOC',0,0.15,0,0),
  ('Birrierias Jaramillo','LOC',0,0.20,0,0),
  ('Al son del Mezcal','LOC',0,0.15,0,0),
  ('Mi dulce catrina','LOC',0,0.15,0,0),
  ('Gilberto Franco','DST',0.20,0,0.15,0),
  ('Nuevo Ideal','LOC',0,0.20,0,0),
  ('Borde numeric(5,2)','LOC',0,999.99,0,0);

INSERT INTO public.entidades (nombre, rol, zona, comision_base, comision_base_local, comision_hijo_local, comision_logistica)
SELECT nombre, rol, 'Zacatecas', cb, cbl, chl, cl FROM semilla_comision;

-- Para que las comprobaciones 3 y 4 midan el cambio, se guardan aparte los
-- valores que despues se van a editar (la comprobacion 2 corre antes de editar).
