create or replace function agente.asuntos_abiertos(p_sin_resp_min integer)
 returns table(clave text, orden integer, linea text)
 language sql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
  with ult as (
    select distinct on (m.contacto_id) m.contacto_id, m.id, m.direccion, m.origen, m.texto, m.creado_en
      from agente.mensajes m
     where m.creado_en > now() - interval '24 hours'
       and coalesce(m.origen,'') not like 'puente%'
     order by m.contacto_id, m.creado_en desc, m.id desc),
  cita as (
    select q.id,
           (select string_agg('"' || left(regexp_replace(x.texto, '\s+', ' ', 'g'), 90) || '"', ' / ' order by x.id)
              from (select m.id, m.texto from agente.mensajes m
                     where m.contacto_id = q.contacto_id and m.direccion = 'entrante'
                       and coalesce(m.origen,'') like '%:pausa%' and m.creado_en >= q.creado_en
                     order by m.id desc limit 3) x) as ultimos
      from agente.preguntas_abiertas q
     where q.estado = 'abierta' and q.pausa),
  acuse as (
    select '^\s*(ok[a-z]*|okey|okay|va|vale|sale|listo|gracias|muchas gracias|mil gracias|grax|thx|👍|🙏|😊|🙌|👌|❤️)[\s.!¡]*$'::text as rx)
  select 'sinresp:' || u.id, 1,
         '🔴 ' || coalesce(k.nombre, u.contacto_id) || ' (' || coalesce(k.canal,'?') || ') escribio hace ' ||
         (extract(epoch from now() - u.creado_en) / 60)::int || ' min y nadie le contesto: "' ||
         left(regexp_replace(u.texto, '\s+', ' ', 'g'), 90) || '"'
    from ult u join agente.contactos k on k.id = u.contacto_id
   where u.direccion = 'entrante'
     and coalesce(u.origen,'') not like '%callado%' and coalesce(u.origen,'') not like '%pausa%'
     and coalesce(u.origen,'') not like '%rafaga%'
     and u.creado_en < now() - make_interval(mins => p_sin_resp_min)
     and u.contacto_id not like 'prueba\_%'
  union all
  select 'pausa:' || q.id || ':' || q.entrantes_en_pausa, 2,
         '⁉️ #P' || q.id || ' ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') ||
         ') sigue en pausa esperando que me digas si la retomo yo o tu. Lo ultimo que escribio: ' ||
         coalesce(c.ultimos, '"' || left(q.pregunta, 90) || '"')
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
    left join cita c on c.id = q.id
   where q.estado = 'abierta' and q.pausa and q.entrantes_en_pausa > 0
     and coalesce(q.tomada_por, '') <> 'norman'
     and q.creado_en > now() - interval '2 hours'
  union all
  select 'pausa2h:' || q.id, 0,
         '🔴 #P' || q.id || ' ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') lleva ' ||
         (extract(epoch from now() - q.creado_en) / 3600)::int || ' h en pausa. ' ||
         case when c.ultimos is not null then 'Lo ultimo que escribio: ' || c.ultimos
              else 'Pregunto: "' || left(q.pregunta, 90) || '"' end
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
    left join cita c on c.id = q.id
   where q.estado = 'abierta' and q.pausa and q.creado_en <= now() - interval '2 hours'
     and coalesce(q.tomada_por, '') <> 'norman'
  union all
  select 'envio:' || p.id, 2,
         '⁉️ Envio nacional #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || ' (' || coalesce(p.ciudad,'?') ||
         ') espera que me digas si va, desde hace ' || (extract(epoch from now() - p.avisado_cerrado_en) / 3600)::int || ' h'
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where p.estado = 'pedido' and p.envio_decision is null and p.avisado_cerrado_en is not null
     and p.avisado_cerrado_en <= now() - interval '1 hour' and p.zona = 'nacional'
  union all
  select 'vigia:' || v.id, 1,
         '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
         case when now() - v.ultimo_ts < interval '2 hours'
              then (extract(epoch from now() - v.ultimo_ts) / 60)::int || ' min'
              else (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h' end ||
         ' y en la bandeja nadie le contesto (lo vio el vigia, fuera del cerebro): "' || left(coalesce(v.texto,''), 90) || '"'
    from agente.vigia_alertas v, acuse a
   where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
     and lower(coalesce(v.texto,'')) !~ a.rx
     and not exists (
       select 1 from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
        where q.pausa and (q.estado = 'abierta' or q.tomada_por = 'norman' and q.creado_en > now() - interval '24 hours')
          and ((v.canal = 'whatsapp' and k.telefono_e164 is not null
                and right(regexp_replace(k.telefono_e164, '\D', '', 'g'), 10) = right(regexp_replace(v.hilo, '\D', '', 'g'), 10))
               or (k.nombre is not null and k.nombre = v.quien and k.canal = v.canal)))
  union all
  select 'vigia:' || v.id, 3, '⚠️ El token de la pagina de Facebook caduco: el vigia no ve Messenger ni Instagram.'
    from agente.vigia_alertas v
   where v.canal = 'sistema' and v.hilo = 'token_meta' and v.ultimo_ts > now() - interval '24 hours'
  union all
  select 'venta3d:' || s.orden || ':' || s.pedido_id || ':' || to_char(now() at time zone 'America/Mexico_City', 'YYYY-MM-DD'),
         4, s.linea
    from agente.seguimiento_ventas(false) s
   where s.dias >= 3 and extract(hour from now() at time zone 'America/Mexico_City') = 9;
$function$;