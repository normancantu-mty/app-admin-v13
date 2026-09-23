-- Fase 8, D69 (2026-09-22): "HOY" ES HOY EN MEXICO.
-- CURRENT_DATE es la fecha de la sesion de Postgres, que en Supabase es UTC. A
-- las 22:08 de Mexico (UTC-6) ya es el dia siguiente en UTC: COT-0002 nacio con
-- fecha 2026-09-23 y vigente_hasta 2026-10-08 cuando en Mexico era 09-22.
-- Solo cambia el DEFAULT de dos columnas: no reescribe ninguna fila existente
-- (COT-0002 se queda como esta; corregirla es decision de Norman).
alter table public.cotizaciones
  alter column fecha set default ((now() at time zone 'America/Mexico_City')::date);
alter table public.lote_envasado
  alter column fecha set default ((now() at time zone 'America/Mexico_City')::date);
