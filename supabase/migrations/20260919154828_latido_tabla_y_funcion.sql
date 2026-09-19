create table if not exists agente.latido (
  id           bigserial primary key,
  corrida_en   timestamptz not null default now(),
  estado       text        not null,
  detectores   jsonb       not null,
  aviso        boolean     not null default false,
  request_id   bigint
);
create index if not exists latido_corrida_en_desc on agente.latido (corrida_en desc);

create or replace function agente.latido()
returns void language plpgsql security definer
set search_path = agente, net, vault, public
as $latido$
declare
  v_huerf int; v_reglas int; v_puente int; v_sal int; v_region int;
  v_hueco numeric; v_alarmas text[] := array[]::text[];
  v_prev record; v_estado text; v_req bigint; v_texto text;
begin
  -- (i) carear el aviso ANTERIOR: pg_net es asincrono y "enviado" no es "aceptado"
  select l.id, l.request_id into v_prev from agente.latido l
   where l.request_id is not null order by l.corrida_en desc limit 1;
  if v_prev.request_id is not null then
    update agente.latido set detectores = detectores || jsonb_build_object(
      'telegram_status', (select status_code from net._http_response where id = v_prev.request_id))
     where id = v_prev.id;
  end if;

  -- (ii) detector 1: la conversacion huerfana. 15 min de gracia para no contar turnos en vuelo.
  -- CORRECCION 20260919: se excluyen las sondas, o las propias pruebas lo vuelven un lobo.
  select count(*) into v_huerf from agente.conversaciones v
   where v.abierta_en between now() - interval '24 hours' and now() - interval '15 minutes'
     and v.contacto_id not like 'prueba_%'
     and not exists (select 1 from agente.mensajes m where m.conversacion_id = v.id);

  -- (iii) detectores 2 y 3, de una sola pasada
  select count(*) filter (where origen like 'reglas%'),
         count(*) filter (where origen like 'puente%'),
         count(*),
         count(*) filter (where split_part(origen,'@',2) <> 'us-west-1')
    into v_reglas, v_puente, v_sal, v_region
    from agente.mensajes
   where direccion = 'saliente' and creado_en > now() - interval '24 hours';

  -- (iv) detector 4: se MIDE y se guarda, pero NO avisa. Umbral sin fijar hasta el 2026-10-15
  select extract(epoch from (now() - max(creado_en)))/3600 into v_hueco
    from agente.mensajes where direccion = 'saliente';

  if v_huerf  > 0 then v_alarmas := v_alarmas || ('conversaciones huerfanas en 24h: ' || v_huerf); end if;
  if v_reglas > 0 then v_alarmas := v_alarmas || ('contesto la red de seguridad, Anthropic fallo: ' || v_reglas); end if;
  if v_region > 0 then v_alarmas := v_alarmas || ('region fuera de us-west-1: ' || v_region); end if;
  if v_sal >= 5 and v_puente::numeric / v_sal > 0.30
    then v_alarmas := v_alarmas || ('puente en ' || round(100.0*v_puente/v_sal) || '% de ' || v_sal || ' salientes'); end if;

  v_estado := case when cardinality(v_alarmas) = 0 then 'ok' else 'alarma' end;

  -- (v) anti-lobo: un aviso cada 6 h como maximo, aunque la alarma siga puesta
  if v_estado = 'alarma' and not exists (
       select 1 from agente.latido where corrida_en > now() - interval '6 hours' and aviso) then
    v_texto := 'LATIDO - el cerebro de LucIA esta fallando:' || chr(10) || chr(10)
            || array_to_string(v_alarmas, chr(10)) || chr(10) || chr(10)
            || 'Ultima respuesta hace ' || coalesce(round(v_hueco,1)::text, 'n/d') || ' h.';
    select net.http_post(
      url := 'https://api.telegram.org/bot'
          || (select decrypted_secret from vault.decrypted_secrets where name = 'telegram_bot_token')
          || '/sendMessage',
      headers := jsonb_build_object('Content-Type','application/json'),
      body    := jsonb_build_object('chat_id', 6571822622, 'text', v_texto)) into v_req;
  end if;

  -- (vi) LA LINEA DE CADA CORRIDA, haya o no haya algo. Esto es lo que lo hace un Latido
  insert into agente.latido (estado, detectores, aviso, request_id)
  values (v_estado,
          jsonb_build_object('huerfanas',v_huerf,'reglas',v_reglas,'puente',v_puente,
                             'salientes',v_sal,'region_mala',v_region,'hueco_h',round(v_hueco,2)),
          v_req is not null, v_req);
end
$latido$;
