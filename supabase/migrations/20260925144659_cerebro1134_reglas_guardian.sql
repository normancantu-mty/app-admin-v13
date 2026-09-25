alter table agente.reglas_vivas add column if not exists choca_con bigint references agente.reglas_vivas(id);

create table if not exists agente.salud (
  clave text primary key,
  en timestamptz not null default now(),
  detalle jsonb not null default '{}'::jsonb
);
alter table agente.salud enable row level security;

create or replace function agente.abrir_turno(p_id text, p_canal text, p_nombre text, p_horas integer, p_n integer, p_max_reglas integer DEFAULT 25)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
declare
  v_nuevo boolean; v_forzar boolean := false; v_conv uuid; v_ultima timestamptz;
  v_reusada boolean := false; v_hist jsonb; v_reglas jsonb; v_cli jsonb;
  v_pausa jsonb; v_cfg jsonb; v_comp jsonb;
begin
  insert into agente.contactos as c (id, canal, nombre, ultimo_visto)
  values (p_id, p_canal, nullif(p_nombre, ''), now())
  on conflict (id) do update
     set ultimo_visto = now(), canal = excluded.canal,
         nombre = coalesce(excluded.nombre, c.nombre)
  returning (xmax = 0) into v_nuevo;

  update agente.contactos set datos = datos - 'forzar_bienvenida'
   where id = p_id and datos ? 'forzar_bienvenida'
  returning true into v_forzar;

  select id, ultima_en into v_conv, v_ultima from agente.conversaciones
   where contacto_id = p_id and estado = 'abierta' order by ultima_en desc limit 1;
  if v_conv is not null and v_ultima > now() - make_interval(hours => p_horas) then
    update agente.conversaciones set ultima_en = now() where id = v_conv;
    v_reusada := true;
  else
    if v_conv is not null then
      update agente.conversaciones set estado = 'cerrada' where id = v_conv;
    end if;
    v_conv := null;
    insert into agente.conversaciones (contacto_id, canal) values (p_id, p_canal)
    on conflict (contacto_id) where estado = 'abierta' do nothing
    returning id into v_conv;
    if v_conv is null then
      select id into v_conv from agente.conversaciones
       where contacto_id = p_id and estado = 'abierta' limit 1;
      v_reusada := true;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('direccion', t.direccion, 'texto', t.texto,
           'en', t.creado_en, 'conv', t.conversacion_id) order by t.creado_en, t.id), '[]'::jsonb)
    into v_hist
    from (select m.direccion, m.texto, m.creado_en, m.id, m.conversacion_id
            from agente.mensajes m
           where m.contacto_id = p_id and m.texto <> ''
             and coalesce(m.origen, '') not like 'puente%'
             and coalesce(m.origen, '') not like '%tarde_fallo%'
             and coalesce(m.origen, '') not like '%callado%'
           order by m.creado_en desc, m.id desc limit p_n) t;

  select coalesce(jsonb_agg(r.texto order by r.prioridad, r.id), '[]'::jsonb) into v_reglas
    from (select texto, prioridad, id from agente.reglas_vivas
           where activa and (quien not like 'prueba%' or p_id like 'prueba\_%')
           order by prioridad, id limit p_max_reglas) r;

  select jsonb_strip_nulls(jsonb_build_object(
           'telefono', c.telefono_e164, 'correo', c.correo, 'ciudad', c.ciudad, 'cp', c.cp,
           'tipo_cliente', c.tipo_cliente, 'origen', c.origen, 'n_pedidos', nullif(c.n_pedidos, 0),
           'ultimo_pedido', c.ultimo_pedido, 'primer_visto', c.primer_visto,
           'pedido_vivo', (select jsonb_strip_nulls(jsonb_build_object('id', p.id, 'estado', p.estado,
                             'items', p.items, 'total', p.total, 'ciudad', p.ciudad, 'domicilio', p.domicilio,
                             'receptor', p.receptor_nombre, 'horario', p.horario, 'metodo_pago', p.metodo_pago))
                             from agente.pedidos p where p.contacto_id = c.id
                              and p.estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido')
                             limit 1)))
    into v_cli from agente.contactos c where c.id = p_id;

  select jsonb_build_object('id', q.id, 'desde', q.creado_en, 'pregunta', left(q.pregunta, 200))
    into v_pausa from agente.preguntas_abiertas q
   where q.contacto_id = p_id and q.estado = 'abierta' and q.pausa
   order by q.id desc limit 1;

  select to_jsonb(k) - 'id' - 'actualizado_en' into v_cfg from agente.cerebro_config k where k.id = 1;

  select jsonb_build_object('id', x.id, 'clase', x.clase, 'recibido_en', x.recibido_en)
    into v_comp from agente.comprobantes x
   where x.contacto_id = p_id and not x.avisado and x.resultado is null
     and x.recibido_en > now() - interval '2 hours'
   order by x.id desc limit 1;

  return jsonb_build_object('conversacion_id', v_conv, 'reusada', v_reusada, 'nuevo', v_nuevo,
    'forzar', coalesce(v_forzar, false), 'historial', v_hist, 'reglas', v_reglas, 'cliente', v_cli,
    'pausa', v_pausa, 'config', v_cfg, 'comprobante_pendiente', v_comp);
end $function$;

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
     order by m.contacto_id, m.creado_en desc, m.id desc)
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
         '⁉️ ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') sigue en pausa' ||
         case when q.tomada_por = 'norman' then ', la tomaste tu' else ' esperando que me digas si la retomo yo o tu' end ||
         case when q.entrantes_en_pausa > 0 then ', y ya escribio ' || q.entrantes_en_pausa || ' mensaje(s) mas' else '' end ||
         ': "' || left(q.pregunta, 90) || '"'
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.entrantes_en_pausa > 0
     and q.creado_en > now() - interval '2 hours'
  union all
  select 'pausa2h:' || q.id, 0,
         '🔴 ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') lleva ' ||
         (extract(epoch from now() - q.creado_en) / 3600)::int || ' h en pausa' ||
         case when q.tomada_por = 'norman' then ' (la tomaste tu)' else '' end ||
         ': "' || left(q.pregunta, 90) || '"'
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.creado_en <= now() - interval '2 hours'
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
    from agente.vigia_alertas v
   where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
  union all
  select 'vigia:' || v.id, 3, '⚠️ El token de la pagina de Facebook caduco: el vigia no ve Messenger ni Instagram.'
    from agente.vigia_alertas v
   where v.canal = 'sistema' and v.hilo = 'token_meta' and v.ultimo_ts > now() - interval '24 hours';
$function$;

create or replace function agente.guardian_lineas(p_modo text default 'real', p_tono boolean default null)
 returns table(seccion text, orden integer, clave text, linea text, cuenta boolean)
 language plpgsql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
declare
  v_prueba boolean := (p_modo = 'prueba');
  v_min int;
  v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
  v_tono boolean := coalesce(p_tono, extract(dow from now() at time zone 'America/Mexico_City') = 0);
  v_puente timestamptz; v_ult timestamptz; v_n int; v_p95 numeric; v_err int; v_tarde int; v_alarm int;
  v_vig record; v_t record;
begin
  select coalesce(sin_respuesta_min, 10) into v_min from agente.cerebro_config where id = 1;
  v_min := coalesce(v_min, 10);

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
     and p.avisado_cerrado_en <= now() - interval '4 hours' and p.estado not in ('cancelado','entregado')
     and (p.contacto_id like 'prueba\_%') = v_prueba
   order by p.id;

  return query
  select 'atender', 4, null::text,
         '📦 Pedido #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || coalesce(' (' || p.ciudad || ')', '') ||
         ' cerrado hace ' || (extract(epoch from now() - p.avisado_cerrado_en) / 86400)::int || ' d y sin entrega registrada' ||
         ' (si ya se entrego: "entregado #E' || p.id || '")', true
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where p.estado in ('pedido','pagado') and p.avisado_cerrado_en is not null
     and p.avisado_cerrado_en <= now() - interval '24 hours' and p.avisado_cerrado_en > now() - interval '14 days'
     and coalesce(p.envio_decision, 'va') <> 'no'
     and (p.contacto_id like 'prueba\_%') = v_prueba
   order by p.id;

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

  if not v_prueba then
    return query
    select 'atender', 6, null::text,
           '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
           (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h y en la bandeja nadie le contesto: "' ||
           left(coalesce(v.texto,''), 90) || '"', true
      from agente.vigia_alertas v
     where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
     order by v.id;
  end if;

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

  select en into v_puente from agente.salud where clave = 'puente';
  if v_puente is null then
    return query select 'salud', 1, null::text, '⚪ Puente del grupo: sin medir (todavia no manda latido)', false;
  elsif v_puente < now() - interval '20 minutes' then
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
end $function$;

create or replace function agente.guardian_diario(p_modo text default 'real', p_tono boolean default null)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'agente', 'net', 'vault', 'public'
as $function$
declare v_clave text; v_req bigint;
begin
  select decrypted_secret into v_clave from vault.decrypted_secrets where name = 'vigia_clave';
  if v_clave is null then
    return agente.avisar_grupo('⚠️ Guardian: no corrio, falta vigia_clave en el vault', null, null, 'principal');
  end if;
  select net.http_post(
    url := 'https://gnnqxtsdrbvmlkhfemjw.supabase.co/functions/v1/manychat-cerebro?accion=guardian',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-guardian-clave', v_clave),
    body := jsonb_build_object('modo', p_modo, 'tono', p_tono),
    timeout_milliseconds := 90000) into v_req;
  insert into agente.salud (clave, en, detalle) values ('guardian_disparo', now(), jsonb_build_object('request_id', v_req, 'modo', p_modo))
  on conflict (clave) do update set en = excluded.en, detalle = excluded.detalle;
  return v_req;
end $function$;
