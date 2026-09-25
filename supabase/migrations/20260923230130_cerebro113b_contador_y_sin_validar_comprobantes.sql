create table if not exists agente.contador_transferencias (
  id            bigserial primary key,
  reiniciado_en timestamptz not null default now(),
  por           text
);
alter table agente.contador_transferencias enable row level security;
insert into agente.contador_transferencias (por)
  select 'inicio' where not exists (select 1 from agente.contador_transferencias);

create or replace function agente.contador_monto()
returns jsonb language sql stable security definer set search_path = agente, public as $$
  with r as (select max(reiniciado_en) as desde from agente.contador_transferencias)
  select jsonb_build_object(
    'desde', r.desde,
    'total', coalesce(sum(c.monto_leido), 0),
    'n', count(c.id),
    'sin_monto', count(c.id) filter (where c.monto_leido is null))
  from r left join agente.comprobantes c
    on c.recibido_en >= r.desde and c.clase = 'comprobante' and c.contacto_id not like 'prueba\_%'
  group by r.desde
$$;

alter table agente.preguntas_abiertas add column if not exists tomada_por text;

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
     and p.avisado_cerrado_en <= now() - interval '1 hour' and p.zona = 'nacional';
$$;

create or replace function agente.resumen_dia(p_forzar boolean default false)
returns text language plpgsql security definer set search_path = agente, public as $$
declare v_desde timestamptz; v_n jsonb; v_lineas text[]; v_texto text; v_cfg agente.cerebro_config; v_c jsonb;
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
    'pagos', (select count(*) from agente.comprobantes where recibido_en >= v_desde and clase='comprobante' and contacto_id not like 'prueba\_%'),
    'pagos_monto', (select coalesce(sum(monto_leido),0) from agente.comprobantes where recibido_en >= v_desde and clase='comprobante' and contacto_id not like 'prueba\_%'),
    'cerrados', (select count(*) from agente.pedido_eventos e join agente.pedidos p on p.id=e.pedido_id where e.creado_en >= v_desde and e.a='pedido' and p.contacto_id not like 'prueba\_%')
  ) into v_n;
  v_c := agente.contador_monto();
  select array_agg(a.linea order by a.orden, a.clave) into v_lineas
    from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a;
  v_texto := 'Resumen del dia, LucIA' || E'\n' ||
    '🟢 ' || (v_n->>'clientes') || ' clientes, ' || (v_n->>'entrantes') || ' mensajes recibidos, ' ||
    (v_n->>'salientes') || ' respuestas, ' || (v_n->>'callados') || ' sin contestar a proposito' || E'\n' ||
    '🟢 ' || (v_n->>'escalados') || ' dudas escaladas, ' || (v_n->>'cerrados') || ' pedidos cerrados' || E'\n' ||
    '💰 Hoy: ' || (v_n->>'pagos') || ' pago(s) por transferencia, $' || (v_n->>'pagos_monto') ||
    '. Contador: $' || (v_c->>'total') || ' desde el ' ||
    to_char((v_c->>'desde')::timestamptz at time zone 'America/Mexico_City', 'DD-MM HH24:MI') ||
    case when (v_c->>'sin_monto')::int > 0 then ' (' || (v_c->>'sin_monto') || ' sin monto legible)' else '' end ||
    case when v_lineas is null then E'\n✅ Nada abierto que necesite de ti.'
         else E'\nAbierto al cierre:\n' || array_to_string(v_lineas, E'\n') end;
  perform agente.avisar_grupo(v_texto, null, null, 'principal');
  insert into agente.reporte_items (clave)
    select a.clave from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a on conflict do nothing;
  return v_texto;
end $$;

revoke all on function agente.contador_monto() from public, anon, authenticated;
revoke all on function agente.asuntos_abiertos(int) from public, anon, authenticated;
revoke all on function agente.resumen_dia(boolean) from public, anon, authenticated;
