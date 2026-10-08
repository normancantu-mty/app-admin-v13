-- cerebro 1.15.17 — las ventas de LucIA vuelven al ERP (Norman, 2026-10-06; revoca S3 del 09-28).
-- Escrito el 2026-10-06 por el ejecutor del Socio (cerebro 1.15.17). ADITIVA: dos columnas en cerebro_config, una funcion nueva,
-- y resumen_dia() con UNA linea mas al final. La v61 (1.15.16) no lee nada de esto: se aplica ANTES del deploy de la v62.
--   erp_auto  : interruptor sin deploy del disparador automatico ("✅ #E entregado" -> ERP). false = no escribe, dice "ERP apagado".
--   erp_desde : corte; solo entran solos los pedidos cuyo evento 'entregado' es >= este instante (lo viejo = "erp #E<id>").
--   linea_sin_costo_envio(p_prueba): "💸 En el ERP sin costo de envio: #E12, #E13 — contesta ..." o null. Solo 'registrada'.
-- resumen_dia() se edita en sitio (replace sobre pg_get_functiondef): si el texto esperado no esta, la migracion truena.
--
-- DESHACER (despues de regresar el codigo a la v61): cerebro/DESHACER_migracion_cerebro11517.sql

alter table agente.cerebro_config add column if not exists erp_auto boolean not null default true;
alter table agente.cerebro_config add column if not exists erp_desde timestamptz;
update agente.cerebro_config set erp_desde = now() where id = 1 and erp_desde is null;
comment on column agente.cerebro_config.erp_auto is 'cerebro 1.15.17: true = cada "✅ #E entregado" del grupo entra al ERP; false = no escribe (dice ERP apagado)';
comment on column agente.cerebro_config.erp_desde is 'cerebro 1.15.17: corte; solo entran solos los pedidos con evento entregado >= este instante';

create or replace function agente.linea_sin_costo_envio(p_prueba boolean default false)
 returns text
 language sql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
  select '💸 En el ERP sin costo de envio: ' || string_agg('#E' || v.pedido_id, ', ' order by v.pedido_id) ||
         ' — contesta "costo #E<id> <monto>"'
    from agente.ventas_erp v join agente.pedidos p on p.id = v.pedido_id
   where v.estado = 'registrada' and v.envio_costo is null
     and (p.contacto_id like 'prueba\_%') = p_prueba;
$function$;

do $do$
declare
  d text := pg_get_functiondef('agente.resumen_dia(boolean)'::regprocedure);
  viejo text := $v$array_to_string(v_lineas, E'\n') end;$v$;
  nuevo text := $n$array_to_string(v_lineas, E'\n') end ||
    coalesce(E'\n' || agente.linea_sin_costo_envio(false), '');  -- 1.15.17: ventas en el ERP sin costo de envio$n$;
begin
  if (length(d) - length(replace(d, viejo, ''))) / length(viejo) <> 1 then
    raise exception 'cerebro11517: resumen_dia no trae el texto esperado (exactamente 1 vez); no toco nada';
  end if;
  execute replace(d, viejo, nuevo);
end $do$;