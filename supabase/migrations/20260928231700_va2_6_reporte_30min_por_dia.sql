CREATE OR REPLACE FUNCTION agente.reporte_30min(p_forzar boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v_cfg agente.cerebro_config; v_hora int; v_lineas text[]; v_claves text[]; v_texto text;
        v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
begin
  select * into v_cfg from agente.cerebro_config where id = 1;
  v_hora := extract(hour from now() at time zone 'America/Mexico_City');
  if not p_forzar and (not coalesce(v_cfg.reporte_on, true) or v_hora < 7 or v_hora >= 23) then
    return 'fuera de ventana';
  end if;
  select array_agg(a.linea order by a.orden, a.clave), array_agg(a.clave)
    into v_lineas, v_claves
    from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a
   -- Va2 (i): lo reportado se calla solo el mismo dia (hora MX). Lo que siga abierto al dia siguiente vuelve a salir
   -- una vez (tambien lo que marco el resumen de las 23:05).
   where not exists (select 1 from agente.reporte_items r where r.clave = a.clave and r.reportado_en >= v_hoy);
  if v_lineas is null then return 'nada nuevo'; end if;
  v_texto := to_char(now() at time zone 'America/Mexico_City', 'HH24:MI') || E' LucIA\n' || array_to_string(v_lineas, E'\n');
  perform agente.avisar_grupo(v_texto, null, null, 'principal');
  insert into agente.reporte_items (clave) select unnest(v_claves)
  on conflict (clave) do update set reportado_en = now();
  return v_texto;
end $function$
;
