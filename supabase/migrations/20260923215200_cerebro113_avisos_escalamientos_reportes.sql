create or replace function agente.avisar_grupo(
  p_texto text, p_botones jsonb default null, p_foto text default null, p_destino text default 'principal')
returns bigint language plpgsql security definer
set search_path = agente, net, vault, public as $$
declare v_token text; v_chat text; v_body jsonb; v_req bigint; v_metodo text; v_dest text;
begin
  v_dest := case when p_destino in ('principal','envios','pasta') then p_destino else 'principal' end;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_mensajeria_token';
  select decrypted_secret into v_chat from vault.decrypted_secrets where name = 'telegram_chat_' || v_dest;
  if v_token is null or v_chat is null then
    return agente.avisar('[sin grupo ' || v_dest || '] ' || p_texto, p_botones, p_foto);
  end if;
  if p_foto is not null then
    v_metodo := 'sendPhoto';
    v_body := jsonb_build_object('chat_id', v_chat, 'photo', p_foto, 'caption', left(p_texto, 1000));
  else
    v_metodo := 'sendMessage';
    v_body := jsonb_build_object('chat_id', v_chat, 'text', left(p_texto, 4000),
                                 'disable_web_page_preview', true);
  end if;
  if p_botones is not null then
    v_body := v_body || jsonb_build_object('reply_markup', jsonb_build_object('inline_keyboard', p_botones));
  end if;
  select net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/' || v_metodo,
    headers := jsonb_build_object('Content-Type','application/json'),
    body := v_body) into v_req;
  insert into agente.decisiones (tipo, detalle)
  values ('aviso_grupo', jsonb_build_object('request_id', v_req, 'metodo', v_metodo, 'destino', v_dest,
                                            'texto', left(p_texto, 300)));
  return v_req;
end $$;

create table if not exists agente.cerebro_config (
  id               int primary key default 1 check (id = 1),
  rafaga_ms        int  not null default 4000,
  rafaga_sync_ms   int  not null default 0,
  retraso_on       boolean not null default false,
  ppm              int  not null default 80,
  retraso_min_ms   int  not null default 3000,
  retraso_max_ms   int  not null default 40000,
  reporte_on       boolean not null default true,
  sin_respuesta_min int not null default 10,
  actualizado_en   timestamptz not null default now()
);
insert into agente.cerebro_config (id) values (1) on conflict (id) do nothing;
alter table agente.cerebro_config enable row level security;

create table if not exists agente.preguntas_abiertas (
  id               bigserial primary key,
  contacto_id      text not null references agente.contactos(id) on delete cascade,
  conversacion_id  uuid references agente.conversaciones(id) on delete set null,
  canal            text,
  tipo             text not null default 'duda' check (tipo in ('duda','negocio','personalizacion')),
  pregunta         text not null,
  promesa          text,
  pausa            boolean not null default true,
  estado           text not null default 'abierta' check (estado in ('abierta','cerrada')),
  entrantes_en_pausa int not null default 0,
  ultimo_entrante_en timestamptz,
  creado_en        timestamptz not null default now(),
  cerrada_en       timestamptz,
  cerrada_por      text
);
create index if not exists ix_preguntas_abiertas on agente.preguntas_abiertas (contacto_id) where estado = 'abierta';
alter table agente.preguntas_abiertas enable row level security;

create or replace function agente.cerrar_pregunta(p_id bigint, p_por text)
returns text language plpgsql security definer set search_path = agente, public as $$
declare v agente.preguntas_abiertas; v_nombre text;
begin
  select * into v from agente.preguntas_abiertas where id = p_id for update;
  if v.id is null then return 'no existe la pregunta ' || p_id; end if;
  select nombre into v_nombre from agente.contactos where id = v.contacto_id;
  if v.estado = 'cerrada' then
    return 'ya estaba cerrada (' || coalesce(v.cerrada_por, '?') || '). LucIA ya contesta a ' || coalesce(v_nombre, v.contacto_id);
  end if;
  update agente.preguntas_abiertas set estado = 'cerrada', cerrada_en = now(), cerrada_por = p_por where id = p_id;
  return 'pregunta ' || p_id || ' cerrada. LucIA vuelve a contestar a ' || coalesce(v_nombre, v.contacto_id) ||
         case when v.entrantes_en_pausa > 0 then ' (escribio ' || v.entrantes_en_pausa || ' mensaje(s) durante la pausa)' else '' end;
end $$;

create or replace function agente.registrar_en_pausa(p_id bigint)
returns void language sql security definer set search_path = agente, public as $$
  update agente.preguntas_abiertas set entrantes_en_pausa = entrantes_en_pausa + 1, ultimo_entrante_en = now()
   where id = p_id;
$$;

alter table agente.comprobantes
  add column if not exists clase          text,
  add column if not exists monto_leido    numeric,
  add column if not exists monto_esperado numeric,
  add column if not exists avisado        boolean not null default true;

alter table agente.pedidos
  add column if not exists envio_decision   text check (envio_decision in ('va','no')),
  add column if not exists envio_decidido_en timestamptz,
  add column if not exists avisado_cerrado_en timestamptz;

create or replace function agente.abrir_turno(
  p_id text, p_canal text, p_nombre text, p_horas int, p_n int, p_max_reglas int default 25)
returns jsonb language plpgsql security definer
set search_path = agente, public as $$
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
    from (select texto, prioridad, id from agente.reglas_vivas where activa
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
end $$;

create or replace function agente.aplicar_datos(
  p_contacto text, p_mensaje bigint, p_extractor text, p_campos jsonb, p_pedido jsonb default null,
  p_conversacion uuid default null)
returns jsonb language plpgsql security definer
set search_path = agente, public as $$
declare
  k text; v text; v_conf numeric; n_datos int := 0;
  orden constant text[] := array['contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido'];
  v_ped agente.pedidos; v_nuevo_estado text; v_items jsonb; v_evento boolean := false;
begin
  v_conf := case p_extractor when 'regex' then 0.95 when 'modelo' then 0.7 else 1 end;
  for k, v in select key, value from jsonb_each_text(coalesce(p_campos, '{}'::jsonb)) loop
    continue when v is null or btrim(v) = '';
    continue when exists (select 1 from agente.dato_cliente d
                           where d.contacto_id = p_contacto and d.campo = k
                             and d.id = (select max(id) from agente.dato_cliente
                                          where contacto_id = p_contacto and campo = k)
                             and d.valor = v);
    insert into agente.dato_cliente (contacto_id, campo, valor, confianza, fuente_mensaje_id, extractor)
    values (p_contacto, k, v, v_conf, p_mensaje, p_extractor);
    n_datos := n_datos + 1;
  end loop;

  update agente.contactos c set
    telefono_e164 = coalesce(p_campos->>'telefono', c.telefono_e164),
    correo        = coalesce(p_campos->>'correo', c.correo),
    rfc           = coalesce(p_campos->>'rfc', c.rfc),
    cp            = coalesce(p_campos->>'cp', c.cp),
    ciudad        = coalesce(p_campos->>'ciudad', c.ciudad),
    estado_mx     = coalesce(p_campos->>'estado_mx', c.estado_mx),
    tipo_cliente  = coalesce(p_campos->>'tipo_cliente', c.tipo_cliente),
    genero        = coalesce(p_campos->>'genero', c.genero),
    locale        = coalesce(p_campos->>'locale', c.locale),
    origen        = coalesce(c.origen, p_campos->>'origen')
  where c.id = p_contacto;

  if p_pedido is not null and p_pedido <> '{}'::jsonb then
    select * into v_ped from agente.pedidos
     where contacto_id = p_contacto and estado = any (orden) limit 1;
    if v_ped.id is null then
      insert into agente.pedidos (contacto_id, conversacion_id, origen)
      values (p_contacto, p_conversacion, (select origen from agente.contactos where id = p_contacto))
      on conflict do nothing returning * into v_ped;
      if v_ped.id is null then
        select * into v_ped from agente.pedidos where contacto_id = p_contacto and estado = any (orden) limit 1;
      end if;
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, null, v_ped.estado, 'cerebro', p_mensaje);
    end if;

    v_items := case when jsonb_typeof(p_pedido->'items') = 'array' and jsonb_array_length(p_pedido->'items') > 0
                    then p_pedido->'items' else null end;
    v_nuevo_estado := v_ped.estado;
    if p_pedido->>'estado' = any (orden)
       and array_position(orden, p_pedido->>'estado') > array_position(orden, v_ped.estado) then
      v_nuevo_estado := p_pedido->>'estado';
      v_evento := true;
    end if;

    update agente.pedidos p set
      estado          = v_nuevo_estado,
      items           = coalesce(v_items, p.items),
      total           = coalesce((p_pedido->>'total')::numeric, p.total),
      ciudad          = coalesce(p_pedido->>'ciudad', p.ciudad),
      zona            = coalesce(p_pedido->>'zona', p.zona),
      receptor_nombre = coalesce(p_pedido->>'receptor_nombre', p.receptor_nombre),
      receptor_tel    = coalesce(p_pedido->>'receptor_tel', p.receptor_tel),
      domicilio       = coalesce(p_pedido->>'domicilio', p.domicilio),
      referencias     = coalesce(p_pedido->>'referencias', p.referencias),
      horario         = coalesce(p_pedido->>'horario', p.horario),
      metodo_pago     = coalesce(p_pedido->>'metodo_pago', p.metodo_pago),
      ocasion         = coalesce(p_pedido->>'ocasion', p.ocasion),
      objecion        = coalesce(p_pedido->>'objecion', p.objecion),
      actualizado_en  = now()
    where p.id = v_ped.id;

    if v_evento then
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, v_ped.estado, v_nuevo_estado, 'cerebro', p_mensaje);
    end if;
  end if;

  return jsonb_build_object('datos', n_datos, 'pedido_id', v_ped.id, 'estado', v_nuevo_estado,
                            'de', v_ped.estado, 'cambio', v_evento);
end $$;

create table if not exists agente.reporte_items (
  clave        text primary key,
  reportado_en timestamptz not null default now()
);
alter table agente.reporte_items enable row level security;

create or replace function agente.asuntos_abiertos(p_sin_resp_min int)
returns table (clave text, orden int, linea text) language sql stable security definer
set search_path = agente, public as $$
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
     and u.creado_en < now() - make_interval(mins => p_sin_resp_min)
     and u.contacto_id not like 'prueba\_%'
  union all
  select 'pausa:' || q.id || ':' || q.entrantes_en_pausa, 2,
         '⁉️ ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') sigue en pausa esperando tu respuesta' ||
         case when q.entrantes_en_pausa > 0 then ' y ya escribio ' || q.entrantes_en_pausa || ' mensaje(s) mas' else '' end ||
         ': "' || left(q.pregunta, 90) || '"'
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.entrantes_en_pausa > 0
     and q.creado_en > now() - interval '2 hours'
  union all
  select 'pausa2h:' || q.id, 0,
         '🔴 ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') lleva ' ||
         (extract(epoch from now() - q.creado_en) / 3600)::int || ' h en pausa sin que le contesten: "' || left(q.pregunta, 90) || '"'
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.creado_en <= now() - interval '2 hours'
  union all
  select 'comp:' || c.id || case when c.recibido_en <= now() - interval '3 hours' then ':3h' else '' end, 1,
         '🔴 Comprobante #' || c.id || ' de ' || coalesce(k.nombre, c.contacto_id) || ' sin validar desde hace ' ||
         case when c.recibido_en <= now() - interval '2 hours'
              then (extract(epoch from now() - c.recibido_en) / 3600)::int || ' h'
              else (extract(epoch from now() - c.recibido_en) / 60)::int || ' min' end ||
         coalesce(' (leido $' || c.monto_leido || ')', '')
    from agente.comprobantes c join agente.contactos k on k.id = c.contacto_id
   where c.resultado is null and c.avisado and c.recibido_en <= now() - interval '30 minutes'
     and c.recibido_en > now() - interval '7 days'
  union all
  select 'envio:' || p.id, 2,
         '⁉️ Envio nacional #' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || ' (' || coalesce(p.ciudad,'?') ||
         ') espera tu VA en el grupo de envios desde hace ' || (extract(epoch from now() - p.avisado_cerrado_en) / 3600)::int || ' h'
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where p.estado = 'pedido' and p.envio_decision is null and p.avisado_cerrado_en is not null
     and p.avisado_cerrado_en <= now() - interval '1 hour' and p.zona = 'nacional';
$$;

create or replace function agente.reporte_30min(p_forzar boolean default false)
returns text language plpgsql security definer set search_path = agente, public as $$
declare v_cfg agente.cerebro_config; v_hora int; v_lineas text[]; v_claves text[]; v_texto text;
begin
  select * into v_cfg from agente.cerebro_config where id = 1;
  v_hora := extract(hour from now() at time zone 'America/Mexico_City');
  if not p_forzar and (not coalesce(v_cfg.reporte_on, true) or v_hora < 7 or v_hora >= 23) then
    return 'fuera de ventana';
  end if;
  select array_agg(a.linea order by a.orden, a.clave), array_agg(a.clave)
    into v_lineas, v_claves
    from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a
   where not exists (select 1 from agente.reporte_items r where r.clave = a.clave);
  if v_lineas is null then return 'nada nuevo'; end if;
  v_texto := to_char(now() at time zone 'America/Mexico_City', 'HH24:MI') || E' LucIA\n' || array_to_string(v_lineas, E'\n');
  perform agente.avisar_grupo(v_texto, null, null, 'principal');
  insert into agente.reporte_items (clave) select unnest(v_claves) on conflict do nothing;
  return v_texto;
end $$;

create or replace function agente.resumen_dia(p_forzar boolean default false)
returns text language plpgsql security definer set search_path = agente, public as $$
declare v_desde timestamptz; v_n jsonb; v_lineas text[]; v_texto text; v_cfg agente.cerebro_config;
begin
  select * into v_cfg from agente.cerebro_config where id = 1;
  if not p_forzar and not coalesce(v_cfg.reporte_on, true) then return 'apagado'; end if;
  v_desde := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
  select jsonb_build_object(
    'clientes', (select count(distinct contacto_id) from agente.mensajes where creado_en >= v_desde and direccion='entrante' and contacto_id not like 'prueba\_%'),
    'entrantes', (select count(*) from agente.mensajes where creado_en >= v_desde and direccion='entrante' and contacto_id not like 'prueba\_%'),
    'callados', (select count(*) from agente.mensajes where creado_en >= v_desde and direccion='entrante' and origen like '%callado%' and contacto_id not like 'prueba\_%'),
    'salientes', (select count(*) from agente.mensajes where creado_en >= v_desde and direccion='saliente' and origen not like 'puente%' and contacto_id not like 'prueba\_%'),
    'escalados', (select count(*) from agente.preguntas_abiertas where creado_en >= v_desde and contacto_id not like 'prueba\_%'),
    'comprobantes', (select count(*) from agente.comprobantes where recibido_en >= v_desde and avisado and contacto_id not like 'prueba\_%'),
    'cerrados', (select count(*) from agente.pedido_eventos e join agente.pedidos p on p.id=e.pedido_id where e.creado_en >= v_desde and e.a='pedido' and p.contacto_id not like 'prueba\_%'),
    'pagados', (select count(*) from agente.pedido_eventos e join agente.pedidos p on p.id=e.pedido_id where e.creado_en >= v_desde and e.a='pagado' and p.contacto_id not like 'prueba\_%')
  ) into v_n;
  select array_agg(a.linea order by a.orden, a.clave) into v_lineas
    from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a;
  v_texto := 'Resumen del dia, LucIA' || E'\n' ||
    '🟢 ' || (v_n->>'clientes') || ' clientes, ' || (v_n->>'entrantes') || ' mensajes recibidos, ' ||
    (v_n->>'salientes') || ' respuestas, ' || (v_n->>'callados') || ' sin contestar a proposito' || E'\n' ||
    '🟢 ' || (v_n->>'escalados') || ' dudas escaladas, ' || (v_n->>'comprobantes') || ' comprobantes, ' ||
    (v_n->>'cerrados') || ' pedidos cerrados, ' || (v_n->>'pagados') || ' pagados' ||
    case when v_lineas is null then E'\n✅ Nada abierto que necesite de ti.'
         else E'\nAbierto al cierre:\n' || array_to_string(v_lineas, E'\n') end;
  perform agente.avisar_grupo(v_texto, null, null, 'principal');
  insert into agente.reporte_items (clave)
    select a.clave from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a on conflict do nothing;
  return v_texto;
end $$;

revoke all on function agente.avisar_grupo(text, jsonb, text, text) from public, anon, authenticated;
revoke all on function agente.cerrar_pregunta(bigint, text) from public, anon, authenticated;
revoke all on function agente.registrar_en_pausa(bigint) from public, anon, authenticated;
revoke all on function agente.asuntos_abiertos(int) from public, anon, authenticated;
revoke all on function agente.reporte_30min(boolean) from public, anon, authenticated;
revoke all on function agente.resumen_dia(boolean) from public, anon, authenticated;
