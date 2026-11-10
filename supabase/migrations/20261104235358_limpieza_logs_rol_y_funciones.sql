-- D-278: copia y limpieza de cron.job_run_details sin BYPASSRLS ni USAGE en cron.
-- Escrito el 2026-11-04 por el Socio (ejecutor de limpieza).
-- La clave NO va aqui: el rol nace NOLOGIN y la clave se pone aparte, fuera del registro de migraciones.
-- Reversa:
--   drop function limpieza_logs.borrar_cron_lote(timestamptz, integer);
--   drop function limpieza_logs.leer_cron_pagina(timestamptz, timestamptz, bigint, integer);
--   drop schema limpieza_logs;
--   drop role limpiador_logs;

create schema limpieza_logs;
revoke all on schema limpieza_logs from public;

create role limpiador_logs nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication connection limit 2;
alter role limpiador_logs set statement_timeout = '60s';
alter role limpiador_logs set lock_timeout = '5s';
alter role limpiador_logs set idle_in_transaction_session_timeout = '60s';

-- Lee una pagina por runid. La ventana es por end_time: una fila con end_time ya no cambia,
-- asi que (p_desde, p_corte] reparte las filas sin huecos ni repetidos entre corridas.
create function limpieza_logs.leer_cron_pagina(
  p_corte timestamptz,
  p_desde timestamptz default '-infinity',
  p_despues_de_runid bigint default 0,
  p_limite integer default 5000
)
returns table (
  jobid bigint, runid bigint, job_pid integer, database text, username text,
  command text, status text, return_message text,
  start_time timestamptz, end_time timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.jobid, d.runid, d.job_pid, d.database, d.username,
         d.command, d.status, d.return_message, d.start_time, d.end_time
    from cron.job_run_details d
   where d.end_time > p_desde
     and d.end_time <= p_corte
     and d.runid > p_despues_de_runid
   order by d.runid
   limit greatest(1, least(coalesce(p_limite, 5000), 5000))
$$;

-- Borra un lote de filas terminadas antes del corte. El piso de 7 dias vive aqui, no en el cliente.
create function limpieza_logs.borrar_cron_lote(
  p_corte timestamptz,
  p_limite integer default 1000
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_filas integer;
begin
  if p_corte is null then
    raise exception 'corte requerido';
  end if;
  delete from cron.job_run_details d
   where d.runid in (
     select s.runid
       from cron.job_run_details s
      where s.end_time <= p_corte
        and s.end_time < pg_catalog.now() - interval '7 days'
      order by s.runid
      limit greatest(1, least(coalesce(p_limite, 1000), 5000))
   );
  get diagnostics v_filas = row_count;
  return v_filas;
end
$$;

revoke all on function limpieza_logs.leer_cron_pagina(timestamptz, timestamptz, bigint, integer) from public, anon, authenticated, service_role;
revoke all on function limpieza_logs.borrar_cron_lote(timestamptz, integer) from public, anon, authenticated, service_role;

grant usage on schema limpieza_logs to limpiador_logs;
grant execute on function limpieza_logs.leer_cron_pagina(timestamptz, timestamptz, bigint, integer) to limpiador_logs;
grant execute on function limpieza_logs.borrar_cron_lote(timestamptz, integer) to limpiador_logs;
