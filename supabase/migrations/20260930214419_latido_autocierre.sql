create or replace function agente.latido()
returns void language plpgsql security definer
set search_path = agente, net, vault, public
as $latido$
declare
  v_huerf int; v_reglas int; v_puente int; v_sal int; v_region int;
  v_hueco numeric; v_alarmas text[] := array[]::text[];
  v_prev record; v_estado text; v_req bigint; v_texto text; v_token text;
  v_ult_ok timestamptz; v_ult_aviso text;
begin
  select l.id, l.request_id into v_prev from agente.latido l
   where l.request_id is not null order by l.corrida_en desc limit 1;
  if v_prev.request_id is not null then
    update agente.latido set detectores = detectores || jsonb_build_object(
      'telegram_status', (select status_code from net._http_response where id = v_prev.request_id))
     where id = v_prev.id;
  end if;

  -- Ultima prueba de que el modelo contesto: respuesta a cliente o accion del grupo.
  -- Las fallas anteriores a esto ya se curaron y no deben seguir sonando.
  select greatest((select max(creado_en) from agente.mensajes where origen like 'modelo%'),
                  (select max(creado_en) from agente.decisiones where tipo = 'grupo'))
    into v_ult_ok;

  select count(*) into v_huerf from agente.conversaciones v
   where v.abierta_en between now() - interval '24 hours' and now() - interval '15 minutes'
     and v.contacto_id not like 'prueba_%'
     and not exists (select 1 from agente.mensajes m where m.conversacion_id = v.id);

  select count(*) filter (where m.origen like 'reglas%'
                            and m.creado_en > coalesce(v_ult_ok, '-infinity'::timestamptz)),
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

  select estado into v_ult_aviso from agente.latido where aviso order by corrida_en desc limit 1;

  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';

  if v_estado = 'alarma' and v_token is not null and not exists (
       select 1 from agente.latido where corrida_en > now() - interval '6 hours' and aviso and estado = 'alarma') then
    v_texto := 'LATIDO - el cerebro de LucIA esta fallando:' || chr(10) || chr(10)
            || array_to_string(v_alarmas, chr(10)) || chr(10) || chr(10)
            || 'Ultima respuesta hace ' || coalesce(round(v_hueco,1)::text, 'n/d') || ' h.';
  elsif v_estado = 'ok' and v_ult_aviso = 'alarma' and v_token is not null then
    -- Cierre automatico: el ultimo aviso fue alarma y ya no hay nada sonando.
    v_texto := 'LATIDO - LucIA se recupero. Ya no hay alarmas.' || chr(10)
            || 'Ultima respuesta buena del modelo: '
            || coalesce(to_char(v_ult_ok at time zone 'America/Mexico_City', 'DD-MM HH24:MI'), 'n/d') || '.';
  end if;

  if v_texto is not null then
    select net.http_post(
      url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      headers := jsonb_build_object('Content-Type','application/json'),
      body    := jsonb_build_object('chat_id', 6571822622, 'text', v_texto)) into v_req;
  end if;

  insert into agente.latido (estado, detectores, aviso, request_id)
  values (v_estado,
          jsonb_build_object('huerfanas',v_huerf,'reglas',v_reglas,'puente',v_puente,
                             'salientes',v_sal,'region_mala',v_region,'hueco_h',round(v_hueco,2),
                             'sin_token', v_token is null, 'ultimo_ok', v_ult_ok),
          v_req is not null, v_req);
end
$latido$;
