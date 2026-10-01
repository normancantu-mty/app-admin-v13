CREATE OR REPLACE FUNCTION agente.vigia_puente(p_prueba boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'net', 'vault', 'public'
AS $function$
declare
  v_en timestamptz; v_caido boolean; v_desde timestamptz; v_ahora boolean;
  v_texto text; v_token text; v_req bigint;
begin
  select s.en into v_en from agente.salud s where s.clave = 'puente';
  select coalesce((s.detalle->>'caido')::boolean, false), (s.detalle->>'desde')::timestamptz
    into v_caido, v_desde from agente.salud s where s.clave = 'puente_vigia';
  v_caido := coalesce(v_caido, false);
  v_ahora := v_en is null or now() - v_en > make_interval(mins => coalesce(
               (select c.puente_caido_min from agente.cerebro_config c where c.id = 1), 25));
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
$function$
;
