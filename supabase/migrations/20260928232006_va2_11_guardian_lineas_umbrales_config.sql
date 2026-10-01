CREATE OR REPLACE FUNCTION agente.guardian_lineas(p_modo text DEFAULT 'real'::text, p_tono boolean DEFAULT NULL::boolean)
 RETURNS TABLE(seccion text, orden integer, clave text, linea text, cuenta boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  v_prueba boolean := (p_modo = 'prueba');
  v_min int; v_envio_min int; v_puente_min int;
  v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
  v_tono boolean := coalesce(p_tono, extract(dow from now() at time zone 'America/Mexico_City') = 0);
  v_puente timestamptz; v_ult timestamptz; v_n int; v_p95 numeric; v_err int; v_tarde int; v_alarm int;
  v_vig record; v_t record;
begin
  select coalesce(sin_respuesta_min, 10), coalesce(envio_decidir_min, 60), coalesce(puente_caido_min, 25)
    into v_min, v_envio_min, v_puente_min from agente.cerebro_config where id = 1;
  v_min := coalesce(v_min, 10); v_envio_min := coalesce(v_envio_min, 60); v_puente_min := coalesce(v_puente_min, 25);

  return query
  select 'atender', 1, null::text,
         '⏸️ #P' || q.id || ' ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') lleva ' ||
         (extract(epoch from now() - q.creado_en) / 3600)::int || ' h en pausa' ||
         case when q.tomada_por = 'norman' then ' (la tomaste tu)' else '' end ||
         ': "' || left(regexp_replace(q.pregunta, '\s+', ' ', 'g'), 100) || '"', true
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.creado_en <= now() - interval '2 hours'
     and (q.contacto_id like 'prueba\_%') = v_prueba
   order by q.id;

  return query
  select 'atender', 2, null::text,
         '💰 Comprobante #C' || c.id || ' de ' || coalesce(k.nombre, c.contacto_id) ||
         coalesce(' por ' || '$' || c.monto_leido::text, '') || ' sin marcar desde hace ' ||
         (extract(epoch from now() - c.recibido_en) / 3600)::int || ' h' ||
         coalesce(' (pedido #E' || c.pedido_id || ')', ''), true
    from agente.comprobantes c join agente.contactos k on k.id = c.contacto_id
   where c.resultado is null and coalesce(c.clase, '') <> 'otra_imagen'
     and c.recibido_en <= now() - interval '24 hours' and c.recibido_en > now() - interval '14 days'
     and (c.contacto_id like 'prueba\_%') = v_prueba
   order by c.id;

  return query
  select 'atender', 3, null::text,
         '🚚 Envio nacional #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || ' (' || coalesce(p.ciudad,'?') ||
         ') sin decidir desde hace ' || (extract(epoch from now() - p.avisado_cerrado_en) / 3600)::int ||
         ' h (contesta "va" o "no va" al aviso)', true
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where p.zona = 'nacional' and p.envio_decision is null and p.avisado_cerrado_en is not null
     and p.avisado_cerrado_en <= now() - make_interval(mins => v_envio_min) and p.estado not in ('cancelado','entregado')
     and (p.contacto_id like 'prueba\_%') = v_prueba
   order by p.id;

  return query
  select 'atender', s.orden, null::text, s.linea, true
    from agente.seguimiento_ventas(v_prueba) s
   order by s.orden, s.pedido_id;

  return query
  with ult as (
    select distinct on (m.contacto_id) m.contacto_id, m.id, m.direccion, m.origen, m.texto, m.creado_en
      from agente.mensajes m
     where m.creado_en > now() - interval '24 hours' and coalesce(m.origen,'') not like 'puente%'
     order by m.contacto_id, m.creado_en desc, m.id desc)
  select 'atender', 5, null::text,
         '🔴 ' || coalesce(k.nombre, u.contacto_id) || ' (' || coalesce(k.canal,'?') || ') escribio hace ' ||
         case when now() - u.creado_en < interval '2 hours' then (extract(epoch from now() - u.creado_en) / 60)::int || ' min'
              else (extract(epoch from now() - u.creado_en) / 3600)::int || ' h' end ||
         ' y no recibio respuesta: "' || left(regexp_replace(u.texto, '\s+', ' ', 'g'), 90) || '"', true
    from ult u join agente.contactos k on k.id = u.contacto_id
   where u.direccion = 'entrante'
     and coalesce(u.origen,'') not like '%callado%' and coalesce(u.origen,'') not like '%pausa%'
     and coalesce(u.origen,'') not like '%rafaga%'
     and u.creado_en < now() - make_interval(mins => v_min)
     and (u.contacto_id like 'prueba\_%') = v_prueba;

  return query
    select 'atender', 6, null::text,
           '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
           (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h y en la bandeja nadie le contesto: "' ||
           left(coalesce(v.texto,''), 90) || '"', true
      from agente.vigia_alertas v
     where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
       and (coalesce(v.hilo, '') like 'prueba%') = v_prueba
       and lower(coalesce(v.texto, '')) !~ '^\s*(ok[a-z]*|okey|okay|va|vale|sale|listo|gracias|muchas gracias|mil gracias|grax|thx|👍|🙏|😊|🙌|👌|❤️)[\s.!¡]*$'
       and not exists (
         select 1 from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
          where q.pausa and (q.estado = 'abierta' or q.tomada_por = 'norman' and q.creado_en > now() - interval '24 hours')
            and ((v.canal = 'whatsapp' and k.telefono_e164 is not null
                  and right(regexp_replace(k.telefono_e164, '\D', '', 'g'), 10) = right(regexp_replace(v.hilo, '\D', '', 'g'), 10))
                 or (k.nombre is not null and k.nombre = v.quien and k.canal = v.canal)))
     order by v.id;

  return query
  select 'reglas', 1, 'guardian:vieja:' || r.id || ':' || to_char(now() at time zone 'America/Mexico_City', 'IYYY-IW'),
         '📌 Regla #' || r.id || ' lleva ' || (extract(epoch from now() - r.creada_en) / 86400)::int ||
         ' dias viva: "' || left(r.texto, 140) || '". ¿La subo al NUCLEO?', true
    from agente.reglas_vivas r
   where r.activa and r.creada_en <= now() - interval '7 days' and (r.quien like 'prueba%') = v_prueba
   order by r.id;

  return query
  select 'reglas', 2, null::text,
         '⏳ Regla #' || r.id || ' sigue pendiente desde hace ' || (extract(epoch from now() - r.creada_en) / 3600)::int ||
         ' h: "' || left(r.texto, 140) || '". Contesta "si" a su aviso para ponerla o "quita la regla ' || r.id || '"', true
    from agente.reglas_vivas r
   where not r.activa and r.apagada_en is null and r.nota = 'pendiente' and (r.quien like 'prueba%') = v_prueba
   order by r.id;

  if v_prueba then return; end if;

  select en into v_puente from agente.salud s where s.clave = 'puente';
  if v_puente is null then
    return query select 'salud', 1, null::text, '⚪ Puente del grupo: sin medir (todavia no manda latido)', false;
  elsif v_puente < now() - make_interval(mins => v_puente_min) then
    return query select 'salud', 1, null::text,
      '🔴 Puente del grupo sin latido desde hace ' ||
      case when now() - v_puente < interval '2 hours' then (extract(epoch from now() - v_puente) / 60)::int || ' min'
           else (extract(epoch from now() - v_puente) / 3600)::int || ' h' end ||
      ': lo que escribes en el grupo no le llega al cerebro', true;
  end if;

  select max(creado_en) into v_ult from agente.mensajes where direccion = 'entrante' and contacto_id not like 'prueba\_%';
  if v_ult is null or v_ult < now() - interval '24 hours' then
    return query select 'salud', 2, null::text,
      '🔴 Ningun cliente le ha escrito al cerebro en ' ||
      coalesce((extract(epoch from now() - v_ult) / 3600)::int::text, '??') || ' h (ultimo: ' ||
      coalesce(to_char(v_ult at time zone 'America/Mexico_City', 'DD-MM HH24:MI'), 'nunca') ||
      '). ¿ManyChat sigue mandando los mensajes?', true;
  end if;

  select count(*) filter (where origen like 'reglas%'), count(*) filter (where origen like '%tarde_fallo%')
    into v_err, v_tarde
    from agente.mensajes where direccion = 'saliente' and creado_en >= v_hoy and contacto_id not like 'prueba\_%';
  select count(*) into v_alarm from agente.latido where corrida_en >= v_hoy and estado = 'alarma';
  if v_err + v_tarde + v_alarm > 0 then
    return query select 'salud', 3, null::text,
      '🟠 Errores hoy: ' || v_err || ' respuestas de la red de seguridad (Anthropic fallo), ' || v_tarde ||
      ' envios que no salieron, ' || v_alarm || ' alarmas del latido', true;
  end if;

  select count(*), percentile_cont(0.95) within group (order by ms) into v_n, v_p95
    from agente.mensajes where direccion = 'saliente' and origen like 'modelo%' and ms is not null
     and creado_en >= v_hoy and contacto_id not like 'prueba\_%';
  if v_n > 0 and v_p95 > 7000 then
    return query select 'salud', 4, null::text,
      '🟠 Latencia p95 hoy: ' || round(v_p95 / 1000.0, 1) || ' s en ' || v_n || ' respuestas (ManyChat corta a los 10 s)', true;
  end if;

  select * into v_vig from agente.vigia_corridas order by id desc limit 1;
  if v_vig is null then
    return query select 'salud', 5, null::text, '⚪ Vigia de la bandeja: sin medir (no ha corrido nunca)', false;
  else
    if v_vig.corrida_en < now() - interval '1 hour' then
      return query select 'salud', 5, null::text,
        '🔴 El vigia de la bandeja no corre desde hace ' || (extract(epoch from now() - v_vig.corrida_en) / 3600)::int || ' h', true;
    end if;
    if v_vig.errores ? 'meta' then
      return query select 'salud', 6, null::text,
        '⚪ Messenger/Instagram sin contestar: sin medir (no hay fb_page_token en el vault; el vigia solo ve WhatsApp Cloud API)', false;
    elsif v_vig.errores ? 'instagram' then
      return query select 'salud', 6, null::text, '⚪ Instagram sin contestar: sin medir (Graph dio error o timeout)', false;
    end if;
  end if;

  if v_tono then
    select count(*) n,
           round(100.0 * count(*) filter (where left(ltrim(texto), 1) = '¡') / nullif(count(*), 0)) abre,
           round(100.0 * count(*) filter (where rtrim(texto) ~ '\?[^[:alnum:]]{0,4}$') / nullif(count(*), 0)) preg,
           percentile_cont(0.5) within group (order by char_length(texto)) med,
           round(100.0 * count(*) filter (where texto ~ '[\U0001F300-\U0001FAFF☀-➿⭐❤]') / nullif(count(*), 0)) emo
      into v_t
      from agente.mensajes
     where direccion = 'saliente' and origen like 'modelo%' and creado_en > now() - interval '7 days'
       and contacto_id not like 'prueba\_%' and coalesce(texto, '') <> '';
    if coalesce(v_t.n, 0) = 0 then
      return query select 'tono', 1, null::text, '⚪ Tono de la semana: sin medir (0 respuestas reales en 7 dias)', true;
    else
      return query select 'tono', 1, null::text,
        '🗣️ Tono, ' || v_t.n || ' respuestas de la semana: ' || v_t.abre || '% abre con ¡ (antes 57%), ' ||
        v_t.preg || '% termina en pregunta (antes 46%), mediana ' || v_t.med::int || ' car (antes 145), ' ||
        v_t.emo || '% con emoji (antes 100%)', true;
    end if;
  end if;
end $function$
;
