-- Fase 8, D69 (2026-09-22). `v_cotizaciones` decidia VENCIDA y dias_restantes
-- contra CURRENT_DATE (UTC). Desde las 18:00 de Zacatecas una cotizacion que
-- vence hoy salia VENCIDA seis horas antes. Mismo criterio que ya usa
-- `anular_ticket_venta` (migracion 20260919153518). Solo la vista: mismas
-- columnas, mismo orden, mismas opciones; no toca filas.
create or replace view public.v_cotizaciones
with (security_invoker = true) as
select id, folio, fecha, id_vendedor, id_comprador, nombre_prospecto, zona,
       vigencia_dias, vigente_hasta, total, estado, id_ticket, notas,
       usuario_creador, creado_en,
       case
         when estado = 'VIGENTE'
              and vigente_hasta < (now() at time zone 'America/Mexico_City')::date
           then 'VENCIDA'::text
         else estado
       end as estado_efectivo,
       (vigente_hasta - (now() at time zone 'America/Mexico_City')::date) as dias_restantes,
       coalesce((select e.nombre from entidades e where e.id = c.id_comprador),
                (nombre_prospecto)::character varying) as para_quien
from cotizaciones c;

grant select on public.v_cotizaciones to authenticated, service_role;
