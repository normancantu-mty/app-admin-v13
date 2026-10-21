-- migracion_cerebro11520.sql -- cerebro 1.15.20 (B, D, F, G y el CHECK de C). Escrito el 2026-10-08 por el ejecutor del
-- Socio. NO APLICADO. Se aplica ANTES de desplegar la v65 del cerebro y la PROPUESTA ig2pasos de vigia (las dos lo leen).
--   D  agente.reglas_vivas.vence_en timestamptz NULL (null = no vence). abrir_turno solo lee las no vencidas.
--      agente.caducar_reglas() apaga las vencidas; corre en el cron caducar-pausas (cada 5 min).
--   C  guardian_dudas.fuente admite 'a_mano' (lo que Norman escribe a mano -> duda si/no).
--   B  cierre inmediato de las dudas abiertas que citan una regla apagada (hoy #D25-27 citan R33): respuesta
--      'regla_apagada'. Los ids quedan en agente.decisiones tipo 'migracion_11520' para el DESHACER.
--   F  humanos_meta respeta p_hasta tambien fuera del modo seco (vigia topa el cursor sobre lo que no leyo).
--   G  agente.canales_muertos(): una linea en reporte_30min si humanos lleva >30 min con error en un canal.
-- No borra filas. Definiciones VIVAS del 2026-10-08 (md5): abrir_turno 7b8f8de4..., humanos_meta 96f31df9...,
-- reporte_30min a9f2c618..., cron caducar-pausas = 'select agente.caducar_pausas()'.
-- Deshacer: sql/migracion_cerebro11520_DESHACER.sql
-- Probado 2026-10-08 con execute_sql dentro de begin ... rollback (ver DESDE_EJECUTOR_cerebro_1.15.20_2026-10-08.md).

-- D: caducidad
alter table agente.reglas_vivas add column if not exists vence_en timestamptz null;
comment on column agente.reglas_vivas.vence_en is '1.15.20 D: la regla deja de valer en este instante (null = no vence). caducar_reglas() la apaga.';

-- C: la fuente nueva de dudas
alter table agente.guardian_dudas drop constraint if exists guardian_dudas_fuente_check;
alter table agente.guardian_dudas add constraint guardian_dudas_fuente_check
  check (fuente = any (array['texto', 'codigo', 'conducta', 'a_mano']));

create or replace function agente.caducar_reglas()
 returns integer
 language sql
 security definer
 set search_path to 'agente', 'public'
as $function$
  with f as (
    update agente.reglas_vivas
       set activa = false, apagada_en = now(),
           nota = coalesce(nota, '') || ' | vencio ' || to_char(vence_en at time zone 'America/Mexico_City', 'DD/MM HH24:MI') ||
                  ' (caducar_reglas)'
     where activa and vence_en is not null and vence_en <= now()
    returning id)
  select count(*)::int from f
$function$;

-- G: canal muerto (vigia escribe n7fb_error / n7ig_error con detalle.activo y detalle.desde = primer error de la racha)
create or replace function agente.canales_muertos()
 returns table(clave text, orden integer, linea text)
 language sql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
  select 'canal_muerto|' || s.clave || '|' || (s.detalle->>'desde'), 0,
         '🔴 No estoy viendo lo que contestas a mano en ' ||
         case s.clave when 'n7ig_error' then 'Instagram' else 'Messenger' end || ' desde ' ||
         to_char((s.detalle->>'desde')::timestamptz at time zone 'America/Mexico_City', 'DD/MM HH24:MI')
    from agente.salud s
   where s.clave in ('n7fb_error', 'n7ig_error')
     and coalesce((s.detalle->>'activo')::boolean, false)
     and s.detalle ? 'desde'
     and s.en > now() - interval '10 minutes'
     and (s.detalle->>'desde')::timestamptz < now() - interval '30 minutes'
$function$;

-- D abrir_turno / F humanos_meta / G reporte_30min: reemplazo ANCLADO sobre la definicion VIVA (pg_get_functiondef). Si un ancla no aparece
-- exactamente 1 vez, la migracion entera se cae (raise) y no cambia nada.
do $do$
declare f text; viejo text; nuevo text; def text; n int;
begin
  f := $q$agente.abrir_turno(text,text,text,integer,integer,integer)$q$; viejo := $q$where activa and (quien not like$q$; nuevo := $q$where activa and (vence_en is null or vence_en > now()) and (quien not like$q$;
  def := pg_get_functiondef(f::regprocedure);
  n := (length(def) - length(replace(def, viejo, ''))) / length(viejo);
  if n <> 1 then raise exception 'ancla en % aparece % veces (se esperaba 1)', f, n; end if;
  execute replace(def, viejo, nuevo);
  f := $q$agente.humanos_meta(text,jsonb,boolean,timestamp with time zone,timestamp with time zone)$q$; viejo := $q$v_hasta := now() - interval '20 seconds';$q$; nuevo := $q$v_hasta := least(now() - interval '20 seconds', coalesce(p_hasta, 'infinity'::timestamptz));$q$;
  def := pg_get_functiondef(f::regprocedure);
  n := (length(def) - length(replace(def, viejo, ''))) / length(viejo);
  if n <> 1 then raise exception 'ancla en % aparece % veces (se esperaba 1)', f, n; end if;
  execute replace(def, viejo, nuevo);
  f := $q$agente.reporte_30min(boolean)$q$; viejo := $q$from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a$q$; nuevo := $q$from (select * from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) union all select * from agente.canales_muertos()) a$q$;
  def := pg_get_functiondef(f::regprocedure);
  n := (length(def) - length(replace(def, viejo, ''))) / length(viejo);
  if n <> 1 then raise exception 'ancla en % aparece % veces (se esperaba 1)', f, n; end if;
  execute replace(def, viejo, nuevo);
end $do$;

-- D: el cron que ya corre cada 5 min tambien caduca reglas (se comprueba el comando vivo antes de cambiarlo)
do $do$
declare j bigint; c text;
begin
  select jobid, command into j, c from cron.job where jobname = 'caducar-pausas';
  if j is null then raise exception 'no existe el cron caducar-pausas'; end if;
  if c <> 'select agente.caducar_pausas()' then raise exception 'cron caducar-pausas cambio: %', c; end if;
  perform cron.alter_job(j, command := 'select agente.caducar_pausas(); select agente.caducar_reglas();');
end $do$;

-- B: dudas abiertas que citan una regla que ya no esta viva (R<n> en opciones, o "Regla #n:" / "#n:" al inicio de una cita)
with cit as (
  select d.id, (regexp_match(o, '^R(\d+)$'))[1]::bigint as regla
    from agente.guardian_dudas d, unnest(d.opciones) o
   where d.respuesta is null and o ~ '^R\d+$'
  union
  select d.id, (regexp_match(c, '^(?:Regla\s*)?#(\d+)\s*:', 'i'))[1]::bigint
    from agente.guardian_dudas d, unnest(array[d.cita_a, d.cita_b]) c
   where d.respuesta is null and c ~* '^(Regla\s*)?#\d+\s*:'),
apag as (
  select distinct cit.id from cit
   where not exists (select 1 from agente.reglas_vivas r where r.id = cit.regla and r.activa
                       and (r.vence_en is null or r.vence_en > now()))),
f as (
  update agente.guardian_dudas d set respuesta = 'regla_apagada', contestada_en = now()
    from apag where d.id = apag.id and d.respuesta is null
  returning d.id)
insert into agente.decisiones (tipo, detalle)
select 'migracion_11520', jsonb_build_object('cerradas_regla_apagada', coalesce(jsonb_agg(id order by id), '[]'::jsonb)) from f;
