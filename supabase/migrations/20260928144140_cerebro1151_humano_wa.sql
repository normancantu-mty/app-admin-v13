-- cerebro-1.15.1 (2026-09-28) — N7: detectar cuando Norman le contesta a un cliente de WhatsApp.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- Va en SQL + pg_cron (cada 20 s) y NO dentro de whatsapp-escucha: el `sent` de Meta llega antes de que el cerebro
-- guarde su saliente (medido 0-13 s), asi que la comparacion ±20 s solo es fiable 20 s DESPUES. Ademas no toca el
-- camino caliente del 200 a Meta ni obliga a redesplegar escucha. Lee lo que escucha ya guarda crudo.
-- DESHACER: select cron.unschedule('detectar-humano-wa');
--   drop function agente.detectar_humano_wa(), agente.responder_retoma(text, text, boolean), agente.wa_ligar(interval);
--   drop table agente.wa_telefonos;
--   alter table agente.preguntas_abiertas drop column origen, drop column ultimo_humano_en, drop column avisado_en,
--     drop column recordado_hasta;
--   delete from agente.salud where clave = 'n7_cursor';

alter table agente.preguntas_abiertas add column if not exists origen text;
alter table agente.preguntas_abiertas add column if not exists ultimo_humano_en timestamptz;
alter table agente.preguntas_abiertas add column if not exists avisado_en timestamptz;
alter table agente.preguntas_abiertas add column if not exists recordado_hasta timestamptz;

-- Telefono (ultimos 10 digitos) -> contacto. ManyChat no manda el telefono al cerebro: se liga por texto+hora
-- (el mismo mensaje entra por escucha y por el cerebro con < 60 s de diferencia) y solo si el ligue es unico.
create table if not exists agente.wa_telefonos (
  tel10 text primary key,
  contacto_id text not null,
  fuente text not null default 'texto',
  visto_en timestamptz not null default now()
);

create or replace function agente.wa_ligar(p_ventana interval default interval '15 minutes')
returns int language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare n int;
begin
  with ent as (
    select right(msg->>'from', 10) tel10, msg->>'from' tel, msg->'text'->>'body' body,
           to_timestamp((msg->>'timestamp')::bigint) ts
      from agente.whatsapp_escucha w
      cross join lateral jsonb_path_query(w.payload, '$.entry[*].changes[*].value.messages[*]') msg
     where w.recibido_en > now() - p_ventana and msg->'text'->>'body' is not null),
  lig as (
    select e.tel10, min(m.contacto_id) contacto_id
      from ent e join agente.mensajes m
        on m.direccion = 'entrante' and m.canal = 'whatsapp' and m.texto = e.body
       and abs(extract(epoch from m.creado_en - e.ts)) < 60
     where e.tel <> '5218111767313'
     group by e.tel10 having count(distinct m.contacto_id) = 1)
  insert into agente.wa_telefonos (tel10, contacto_id, fuente, visto_en)
  select tel10, contacto_id, 'texto', now() from lig
  on conflict (tel10) do update set contacto_id = excluded.contacto_id, visto_en = now()
   where agente.wa_telefonos.fuente <> 'prueba';
  get diagnostics n = row_count;
  return n;
end $f$;

-- Cada 20 s. (1) `sent` a un cliente sin saliente de LucIA a ±20 s = lo mando un humano: pausa tomada_por norman y
-- UN ✋ por intervencion. (2) Cliente que escribe durante esa pausa y 15 min sin `sent` humano: recordatorio con cita.
create or replace function agente.detectar_humano_wa()
returns int language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare
  v_cursor bigint; v_max bigint; n int := 0; r record; q record; v_id bigint; v_nombre text; v_pref text;
  v_acuse text := '^\s*(ok[a-z]*|okey|okay|va|vale|sale|listo|gracias|muchas gracias|mil gracias|grax|thx|👍|🙏|😊|🙌|👌|❤️)[\s.!¡]*$';
begin
  if not pg_try_advisory_xact_lock(115107) then return 0; end if;
  perform agente.wa_ligar();
  select coalesce((detalle->>'id')::bigint, 0) into v_cursor from agente.salud where clave = 'n7_cursor';
  if v_cursor is null then
    select coalesce(max(id), 0) into v_cursor from agente.whatsapp_escucha;
  end if;
  select coalesce(max(id), v_cursor) into v_max from agente.whatsapp_escucha
   where id > v_cursor and recibido_en < now() - interval '20 seconds';

  for r in
    select distinct on (t.contacto_id) t.contacto_id, t.ts, t.nombre
      from (select wt.contacto_id, to_timestamp((st->>'timestamp')::bigint) ts, coalesce(k.nombre, wt.contacto_id) nombre
              from agente.whatsapp_escucha w
              cross join lateral jsonb_path_query(w.payload, '$.entry[*].changes[*].value.statuses[*]') st
              join agente.wa_telefonos wt on wt.tel10 = right(st->>'recipient_id', 10)
              join agente.contactos k on k.id = wt.contacto_id
             where w.id > v_cursor and w.id <= v_max and st->>'status' = 'sent'
               and st->>'recipient_id' <> '5218111767313') t
     where not exists (select 1 from agente.mensajes m where m.contacto_id = t.contacto_id and m.direccion = 'saliente'
                         and m.creado_en between t.ts - interval '20 seconds' and t.ts + interval '20 seconds')
     order by t.contacto_id, t.ts desc
  loop
    v_pref := case when r.contacto_id like 'prueba\_%' then '[PRUEBA] ' else '' end;
    v_nombre := split_part(r.nombre, ' ', 1);
    select * into q from agente.preguntas_abiertas
     where contacto_id = r.contacto_id and estado = 'abierta' and pausa order by id desc limit 1;
    if q.id is null then
      insert into agente.preguntas_abiertas (contacto_id, conversacion_id, canal, tipo, pregunta, pausa, estado, tomada_por,
                                             origen, ultimo_humano_en, avisado_en, recordado_hasta)
      values (r.contacto_id,
              (select c.id from agente.conversaciones c where c.contacto_id = r.contacto_id order by c.ultima_en desc limit 1),
              'whatsapp', 'duda', 'Norman le contesto por WhatsApp', true, 'abierta', 'norman',
              'norman_wa', r.ts, now(), r.ts)
      returning id into v_id;
      perform agente.avisar_grupo(v_pref || '✋ Vi que le contestaste a ' || v_nombre || '. Me callo con ' || v_nombre ||
        '. ¿La retomo? Contesta: retoma · la sigo yo (#P' || v_id || ')', null, null, 'principal');
      n := n + 1;
    else
      update agente.preguntas_abiertas
         set ultimo_humano_en = greatest(coalesce(ultimo_humano_en, r.ts), r.ts),
             recordado_hasta = greatest(coalesce(recordado_hasta, r.ts), r.ts),
             tomada_por = 'norman', origen = coalesce(origen, 'norman_wa'),
             avisado_en = case when q.tomada_por = 'norman' then coalesce(avisado_en, now()) else now() end
       where id = q.id;
      -- pausa escalada (LucIA esperaba a Norman) y Norman contesto por fuera: se avisa una vez. Si ya era suya, callado.
      if coalesce(q.tomada_por, '') <> 'norman' then
        perform agente.avisar_grupo(v_pref || '✋ Vi que le contestaste a ' || v_nombre ||
          '. Me callo. ¿La retomo? Contesta: retoma · la sigo yo (#P' || q.id || ')', null, null, 'principal');
        n := n + 1;
      end if;
    end if;
  end loop;

  -- recordatorio: el cliente escribio (escucha) despues del ultimo humano y del ultimo recordatorio, hace >= 15 min
  for r in
    select q.id, q.contacto_id, coalesce(k.nombre, q.contacto_id) nombre, x.body, x.ts
      from agente.preguntas_abiertas q
      join agente.contactos k on k.id = q.contacto_id
      cross join lateral (
        select msg->'text'->>'body' body, to_timestamp((msg->>'timestamp')::bigint) ts
          from agente.whatsapp_escucha w
          cross join lateral jsonb_path_query(w.payload, '$.entry[*].changes[*].value.messages[*]') msg
          join agente.wa_telefonos wt on wt.tel10 = right(msg->>'from', 10) and wt.contacto_id = q.contacto_id
         where w.recibido_en > greatest(q.recordado_hasta, q.ultimo_humano_en, now() - interval '2 days') - interval '1 minute'
           and to_timestamp((msg->>'timestamp')::bigint) > greatest(q.recordado_hasta, q.ultimo_humano_en)
           and lower(coalesce(msg->'text'->>'body', '')) !~ v_acuse
         order by (msg->>'timestamp')::bigint desc limit 1) x
     where q.estado = 'abierta' and q.pausa and q.tomada_por = 'norman' and q.origen is not null
       and q.ultimo_humano_en is not null
       and x.ts < now() - interval '15 minutes'
  loop
    v_pref := case when r.contacto_id like 'prueba\_%' then '[PRUEBA] ' else '' end;
    perform agente.avisar_grupo(v_pref || split_part(r.nombre, ' ', 1) || ' escribio "' ||
      left(regexp_replace(coalesce(r.body, '(adjunto)'), '\s+', ' ', 'g'), 90) || '" hace ' ||
      (extract(epoch from now() - r.ts) / 60)::int || ' min y no le has contestado. ¿La retomo? retoma · la sigo yo (#P' ||
      r.id || ')', null, null, 'principal');
    update agente.preguntas_abiertas set recordado_hasta = r.ts, avisado_en = now() where id = r.id;
    n := n + 1;
  end loop;

  insert into agente.salud (clave, en, detalle) values ('n7_cursor', now(), jsonb_build_object('id', v_max, 'avisos', n))
  on conflict (clave) do update set en = excluded.en, detalle = excluded.detalle;
  return n;
end $f$;

-- "retoma" / "la sigo yo" en el grupo (forzado por regex, antes del interprete). null = no es para esto.
create or replace function agente.responder_retoma(p_texto text, p_responde_a text, p_prueba boolean)
returns text language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare
  t text := translate(lower(trim(coalesce(p_texto, ''))), 'áéíóú', 'aeiou');
  v_retoma boolean; v_sigo boolean; v_id bigint; q record; v_nombre text;
begin
  v_retoma := t ~ '^(retoma(la|lo)?|si,? retoma(la|lo)?|retomala tu)[\s.!]*$';
  v_sigo := t ~ '^((yo )?(la|lo) sigo( yo)?|la sigo yo|sigo yo|yo la sigo|yo lo sigo)[\s.!]*$';
  if not (v_retoma or v_sigo) then return null; end if;
  v_id := nullif((regexp_match(coalesce(p_responde_a, ''), '#P(\d+)'))[1], '')::bigint;
  if v_id is null then
    -- sin reply: la ultima pausa tomada a la que se le pregunto (✋ o recordatorio) en 24 h
    select id into v_id from agente.preguntas_abiertas
     where estado = 'abierta' and pausa and tomada_por = 'norman' and avisado_en > now() - interval '24 hours'
       and (contacto_id like 'prueba\_%') = p_prueba
     order by avisado_en desc limit 1;
  end if;
  if v_id is null then return '¿A quien? Contesta "retoma" o "la sigo yo" al aviso ✋ del cliente.'; end if;
  select q2.*, coalesce(k.nombre, q2.contacto_id) nombre into q
    from agente.preguntas_abiertas q2 join agente.contactos k on k.id = q2.contacto_id where q2.id = v_id;
  if q.id is null then return 'No existe la pausa #P' || v_id || '.'; end if;
  v_nombre := split_part(q.nombre, ' ', 1);
  if v_retoma then
    if q.estado = 'cerrada' then return 'LucIA ya atiende a ' || v_nombre || ' (#P' || v_id || ' estaba cerrada).'; end if;
    perform agente.cerrar_pregunta(v_id, 'norman_retoma');
    return '✅ Retomo a ' || v_nombre || '. Le contesto su siguiente mensaje. (#P' || v_id || ')';
  end if;
  if q.estado = 'cerrada' then
    return 'LucIA ya estaba atendiendo a ' || v_nombre || '. Si la quieres tu, escribe "dejalo" al aviso.';
  end if;
  update agente.preguntas_abiertas set recordado_hasta = greatest(coalesce(recordado_hasta, now()), now()),
         tomada_por = 'norman', avisado_en = null
   where id = v_id;
  return '👍 La sigues tu con ' || v_nombre || '. No te pregunto hasta que te escriba y pasen 15 min sin respuesta. (#P' || v_id || ')';
end $f$;

select cron.schedule('detectar-humano-wa', '20 seconds', 'select agente.detectar_humano_wa()');
