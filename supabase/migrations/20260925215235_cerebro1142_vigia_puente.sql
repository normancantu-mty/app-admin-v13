-- cerebro-1.14.2 (2026-09-25, Socio): vigia del puente del grupo + latido sin trafico de prueba.
-- 1) agente.vigia_puente(): cada 5 min mira el latido del puente (agente.salud 'puente', cada 10 min).
--    Sin latido > 25 min -> UN aviso por Telegram; al volver -> UN aviso de regreso. Estado en salud 'puente_vigia'.
--    p_prueba = true devuelve el texto y no envia ni guarda estado.
-- 2) agente.latido(): los salientes a contactos prueba_* ya no cuentan para las alarmas de region/puente/reglas
--    (el 2026-09-25, 19 de 21 'region fuera de us-west-1' eran pruebas del Socio).
create or replace function agente.vigia_puente(p_prueba boolean default false)
returns text
language plpgsql
security definer
set search_path to 'agente', 'net', 'vault', 'public'
as $function$
declare
  v_en timestamptz; v_caido boolean; v_desde timestamptz; v_ahora boolean;
  v_texto text; v_token text; v_req bigint;
begin
  select s.en into v_en from agente.salud s where s.clave = 'puente';
  select coalesce((s.detalle->>'caido')::boolean, false), (s.detalle->>'desde')::timestamptz
    into v_caido, v_desde from agente.salud s where s.clave = 'puente_vigia';
  v_caido := coalesce(v_caido, false);
  v_ahora := v_en is null or now() - v_en > interval '25 minutes';
  if v_ahora = v_caido then
    return null;
  end if;
  if v_ahora then
    v_texto := '⚠️ PUENTE DEL GRUPO CAIDO: sin latido desde '
            || coalesce(to_char(v_en at time zone 'America/Mexico_City', 'DD/MM HH24:MI'), 'nunca') || ' (hora MX).'
            || chr(10) || 'Lo que escribas en el grupo (entregado #E, costos) no llega al cerebro hasta que vuelva;'
            || ' no se pierde, se procesa al volver (hasta 24 h).'
            || chr(10) || 'Si la PC esta prendida: doble clic en 9_INICIAR_PUENTE.bat.';
  else
    v_texto := '✅ Puente del grupo de vuelta. Estuvo caido '
            || coalesce(round(extract(epoch from (now() - v_desde)) / 60)::text, '?') || ' min.';
  end if;
  if p_prueba then
    return v_texto;
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';
  if v_token is not null then
    select net.http_post(
      url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := jsonb_build_object('chat_id', 6571822622, 'text', v_texto)) into v_req;
  end if;
  insert into agente.salud (clave, en, detalle)
  values ('puente_vigia', now(), jsonb_build_object('caido', v_ahora, 'desde', case when v_ahora then v_en end,
                                                    'request_id', v_req, 'sin_token', v_token is null))
  on conflict (clave) do update set en = excluded.en, detalle = excluded.detalle;
  return v_texto;
end
$function$;

create or replace function agente.latido()
returns void
language plpgsql
security definer
set search_path to 'agente', 'net', 'vault', 'public'
as $function$
declare
  v_huerf int; v_reglas int; v_puente int; v_sal int; v_region int;
  v_hueco numeric; v_alarmas text[] := array[]::text[];
  v_prev record; v_estado text; v_req bigint; v_texto text; v_token text;
begin
  select l.id, l.request_id into v_prev from agente.latido l
   where l.request_id is not null order by l.corrida_en desc limit 1;
  if v_prev.request_id is not null then
    update agente.latido set detectores = detectores || jsonb_build_object(
      'telegram_status', (select status_code from net._http_response where id = v_prev.request_id))
     where id = v_prev.id;
  end if;

  select count(*) into v_huerf from agente.conversaciones v
   where v.abierta_en between now() - interval '24 hours' and now() - interval '15 minutes'
     and v.contacto_id not like 'prueba_%'
     and not exists (select 1 from agente.mensajes m where m.conversacion_id = v.id);

  select count(*) filter (where m.origen like 'reglas%'),
         count(*) filter (where m.origen like 'puente%'),
         count(*),
         count(*) filter (where split_part(m.origen,'@',2) <> 'us-west-1')
    into v_reglas, v_puente, v_sal, v_region
    from agente.mensajes m
    left join agente.conversaciones v on v.id = m.conversacion_id
   where m.direccion = 'saliente' and m.creado_en > now() - interval '24 hours'
     and coalesce(v.contacto_id, '') not like 'prueba_%';

  select extract(epoch from (now() - max(creado_en)))/3600 into v_hueco
    from agente.mensajes where direccion = 'saliente';

  if v_huerf  > 0 then v_alarmas := v_alarmas || ('conversaciones huerfanas en 24h: ' || v_huerf); end if;
  if v_reglas > 0 then v_alarmas := v_alarmas || ('contesto la red de seguridad, Anthropic fallo: ' || v_reglas); end if;
  if v_region > 0 then v_alarmas := v_alarmas || ('region fuera de us-west-1: ' || v_region); end if;
  if v_sal >= 5 and v_puente::numeric / v_sal > 0.30
    then v_alarmas := v_alarmas || ('puente en ' || round(100.0*v_puente/v_sal) || '% de ' || v_sal || ' salientes'); end if;

  v_estado := case when cardinality(v_alarmas) = 0 then 'ok' else 'alarma' end;

  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';

  if v_estado = 'alarma' and v_token is not null and not exists (
       select 1 from agente.latido where corrida_en > now() - interval '6 hours' and aviso) then
    v_texto := 'LATIDO - el cerebro de LucIA esta fallando:' || chr(10) || chr(10)
            || array_to_string(v_alarmas, chr(10)) || chr(10) || chr(10)
            || 'Ultima respuesta hace ' || coalesce(round(v_hueco,1)::text, 'n/d') || ' h.';
    select net.http_post(
      url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      headers := jsonb_build_object('Content-Type','application/json'),
      body    := jsonb_build_object('chat_id', 6571822622, 'text', v_texto)) into v_req;
  end if;

  insert into agente.latido (estado, detectores, aviso, request_id)
  values (v_estado,
          jsonb_build_object('huerfanas',v_huerf,'reglas',v_reglas,'puente',v_puente,
                             'salientes',v_sal,'region_mala',v_region,'hueco_h',round(v_hueco,2),
                             'sin_token', v_token is null),
          v_req is not null, v_req);
end
$function$;

select cron.schedule('vigia-puente', '*/5 * * * *', 'select agente.vigia_puente()');
