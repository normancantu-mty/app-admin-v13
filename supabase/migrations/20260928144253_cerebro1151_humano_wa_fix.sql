-- cerebro-1.15.1 (2026-09-28) — N7 fix: en detectar_humano_wa la variable plpgsql `q` chocaba con el alias `q`
-- del SQL del recordatorio ("record q is not assigned yet"); la variable pasa a `pq`. Misma logica.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- DESHACER: el de 20260928144140_cerebro1151_humano_wa.sql.

-- Cada 20 s. (1) `sent` a un cliente sin saliente de LucIA a ±20 s = lo mando un humano: pausa tomada_por norman y
-- UN ✋ por intervencion. (2) Cliente que escribe durante esa pausa y 15 min sin `sent` humano: recordatorio con cita.
create or replace function agente.detectar_humano_wa()
returns int language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare
  v_cursor bigint; v_max bigint; n int := 0; r record; pq record; v_id bigint; v_nombre text; v_pref text;
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
    select * into pq from agente.preguntas_abiertas
     where contacto_id = r.contacto_id and estado = 'abierta' and pausa order by id desc limit 1;
    if pq.id is null then
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
             avisado_en = case when pq.tomada_por = 'norman' then coalesce(avisado_en, now()) else now() end
       where id = pq.id;
      -- pausa escalada (LucIA esperaba a Norman) y Norman contesto por fuera: se avisa una vez. Si ya era suya, callado.
      if coalesce(pq.tomada_por, '') <> 'norman' then
        perform agente.avisar_grupo(v_pref || '✋ Vi que le contestaste a ' || v_nombre ||
          '. Me callo. ¿La retomo? Contesta: retoma · la sigo yo (#P' || pq.id || ')', null, null, 'principal');
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
