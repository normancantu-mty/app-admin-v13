-- fbig-vigia-humano (2026-09-28) — E2: LucIA se entera cuando Norman contesta en Messenger/Instagram.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios), contra
-- DESDE_SOCIO_prompt_ejecutor_fbig_vigia_humano_2026-09-28.md.
-- Metodo (el mismo de N7 en WA): un mensaje de la PAGINA sin saliente del cerebro de ese contacto a +-20 s = lo
-- escribio un humano. El PSID de Meta se liga al contacto de ManyChat por texto igual (normalizado) y hora +-60 s del
-- mensaje del CLIENTE; si casan 2 contactos, no liga. Graph lo lee vigia-bandeja (accion "humanos") y se lo pasa a
-- agente.humanos_meta(); toda la logica vive aqui para poder probarla sin Graph (prueba_*) y en seco (backtest).
-- Refactor: el cuerpo "humano detectado -> pausa tomada_por norman + un aviso por intervencion" sale de
-- detectar_humano_wa() a agente.marcar_humano(); WA queda con el mismo comportamiento.
-- Interruptores: cerebro_config.humano_fbig / humano_ig = apagado | sombra | on. Arrancan sombra / apagado.
-- DESHACER (en este orden):
--   select cron.unschedule('humanos-meta');   -- si ya se aplico la migracion del cron
--   reaplicar detectar_humano_wa() de 20260928144253_cerebro1151_humano_wa_fix.sql;
--   drop function agente.humanos_meta(text, jsonb, boolean, timestamptz, timestamptz);
--   drop function agente.marcar_humano(text, timestamptz, text); drop function agente.norm_texto(text);
--   drop table agente.meta_psid;
--   alter table agente.cerebro_config drop column humano_fbig, drop column humano_ig, drop column humano_excluir;
--   delete from agente.salud where clave in ('n7fb_cursor', 'n7ig_cursor');

alter table agente.cerebro_config
  add column if not exists humano_fbig text not null default 'sombra' check (humano_fbig in ('apagado', 'sombra', 'on')),
  add column if not exists humano_ig text not null default 'apagado' check (humano_ig in ('apagado', 'sombra', 'on')),
  add column if not exists humano_excluir text[] not null default '{}';
comment on column agente.cerebro_config.humano_excluir is
  'Prefijos de texto de la PAGINA que no cuentan como humano (automatismos de ManyChat). Se agregan aqui, no en el codigo.';

create table if not exists agente.meta_psid (
  psid text not null,
  plataforma text not null,
  contacto_id text not null,
  ligado_por text not null,
  ligado_en timestamptz not null default now(),
  primary key (psid, plataforma)
);
alter table agente.meta_psid enable row level security;

create or replace function agente.norm_texto(t text)
returns text language sql immutable as $f$
  select nullif(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'), '')
$f$;

-- Humano detectado: pausa tomada_por norman y UN aviso por intervencion. Devuelve cuantos avisos mando (0 o 1).
create or replace function agente.marcar_humano(p_contacto text, p_ts timestamptz, p_canal text)
returns int language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare
  pq record; v_id bigint; v_nombre text; v_pref text; v_donde text; v_origen text; v_extra text;
begin
  v_pref := case when p_contacto like 'prueba\_%' then '[PRUEBA] ' else '' end;
  select split_part(coalesce(k.nombre, k.id), ' ', 1) into v_nombre from agente.contactos k where k.id = p_contacto;
  v_nombre := coalesce(v_nombre, p_contacto);
  v_origen := case p_canal when 'whatsapp' then 'norman_wa' when 'facebook' then 'norman_fb'
                           when 'instagram' then 'norman_ig' else 'norman_' || p_canal end;
  v_donde := case p_canal when 'whatsapp' then 'WhatsApp' when 'facebook' then 'Messenger'
                          when 'instagram' then 'Instagram' else p_canal end;
  v_extra := case when p_canal = 'whatsapp' then '' else ' en ' || v_donde end;
  select * into pq from agente.preguntas_abiertas
   where contacto_id = p_contacto and estado = 'abierta' and pausa order by id desc limit 1;
  if pq.id is null then
    insert into agente.preguntas_abiertas (contacto_id, conversacion_id, canal, tipo, pregunta, pausa, estado, tomada_por,
                                           origen, ultimo_humano_en, avisado_en, recordado_hasta)
    values (p_contacto,
            (select c.id from agente.conversaciones c where c.contacto_id = p_contacto order by c.ultima_en desc limit 1),
            p_canal, 'duda', 'Norman le contesto por ' || v_donde, true, 'abierta', 'norman',
            v_origen, p_ts, now(), p_ts)
    returning id into v_id;
    perform agente.avisar_grupo(v_pref || '✋ Vi que le contestaste a ' || v_nombre || v_extra || '. Me callo con ' ||
      v_nombre || '. ¿La retomo? Contesta: retoma · la sigo yo (#P' || v_id || ')', null, null, 'principal');
    return 1;
  end if;
  update agente.preguntas_abiertas
     set ultimo_humano_en = greatest(coalesce(ultimo_humano_en, p_ts), p_ts),
         recordado_hasta = greatest(coalesce(recordado_hasta, p_ts), p_ts),
         tomada_por = 'norman', origen = coalesce(origen, v_origen),
         avisado_en = case when pq.tomada_por = 'norman' then coalesce(avisado_en, now()) else now() end
   where id = pq.id;
  -- pausa escalada (LucIA esperaba a Norman) y Norman contesto por fuera: se avisa una vez. Si ya era suya, callado.
  if coalesce(pq.tomada_por, '') <> 'norman' then
    perform agente.avisar_grupo(v_pref || '✋ Vi que le contestaste a ' || v_nombre || v_extra ||
      '. Me callo. ¿La retomo? Contesta: retoma · la sigo yo (#P' || pq.id || ')', null, null, 'principal');
    return 1;
  end if;
  return 0;
end $f$;

-- WA: misma logica que 20260928144253_cerebro1151_humano_wa_fix.sql; el cuerpo del primer loop ahora es marcar_humano().
create or replace function agente.detectar_humano_wa()
returns int language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare
  v_cursor bigint; v_max bigint; n int := 0; r record; v_pref text;
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
    select distinct on (t.contacto_id) t.contacto_id, t.ts
      from (select wt.contacto_id, to_timestamp((st->>'timestamp')::bigint) ts
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
    n := n + agente.marcar_humano(r.contacto_id, r.ts, 'whatsapp');
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

-- FB/IG. p_msgs: [{id, psid, pagina, ts, texto, h}] de Graph (psid = el cliente del hilo; h = md5 del texto
-- normalizado, opcional: el backtest lo manda en vez del texto). p_seco = backtest: no escribe nada, ignora el
-- cursor y usa [p_desde, p_hasta]; devuelve las detecciones.
create or replace function agente.humanos_meta(p_plataforma text, p_msgs jsonb, p_seco boolean default false,
                                               p_desde timestamptz default null, p_hasta timestamptz default null)
returns jsonb language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare
  v_canal text := case p_plataforma when 'messenger' then 'facebook' else 'instagram' end;
  v_clave text := case p_plataforma when 'messenger' then 'n7fb_cursor' else 'n7ig_cursor' end;
  v_modo text; v_excluir text[]; v_links jsonb; v_cursor timestamptz; v_hasta timestamptz; v_max timestamptz;
  v_contacto text; v_t60 text; v_ult timestamptz;
  n_lig int := 0; n_amb int := 0; n_sin int := 0; n_hum int := 0; n_int int := 0; n_exc int := 0; n_av int := 0;
  v_det jsonb := '[]'::jsonb; r record;
  v_acuse text := '^\s*(ok[a-z]*|okey|okay|va|vale|sale|listo|gracias|muchas gracias|mil gracias|grax|thx|👍|🙏|😊|🙌|👌|❤️)[\s.!¡]*$';
begin
  if not p_seco and not pg_try_advisory_xact_lock(115108) then return jsonb_build_object('ocupado', true); end if;
  select case when p_plataforma = 'messenger' then humano_fbig else humano_ig end, humano_excluir
    into v_modo, v_excluir from agente.cerebro_config limit 1;
  if p_seco then v_modo := 'seco'; end if;
  if v_modo = 'apagado' then return jsonb_build_object('modo', v_modo); end if;

  -- 1. ligar PSID <-> contacto de ManyChat por el mensaje del CLIENTE (texto igual, +-60 s, mismo canal)
  select coalesce(jsonb_object_agg(psid, contacto_id), '{}'::jsonb) into v_links
    from agente.meta_psid where plataforma = p_plataforma;
  for r in
    with cli as (
      select x.psid, x.ts, coalesce(x.h, md5(agente.norm_texto(x.texto))) h
        from jsonb_to_recordset(p_msgs) x(psid text, pagina boolean, ts timestamptz, texto text, h text)
       where not coalesce(x.pagina, false) and x.psid is not null and coalesce(x.h, agente.norm_texto(x.texto)) is not null),
    cand as (
      select c.psid, m.contacto_id
        from cli c join agente.mensajes m
          on m.direccion = 'entrante' and coalesce(m.canal, 'facebook') = v_canal
         and m.creado_en between c.ts - interval '60 seconds' and c.ts + interval '60 seconds'
         and md5(agente.norm_texto(m.texto)) = c.h
         and (m.contacto_id like 'prueba\_%') = (c.psid like 'prueba\_%'))
    select psid, min(contacto_id) contacto_id, count(distinct contacto_id) n from cand group by psid
  loop
    if r.n = 1 then
      if v_links->>r.psid is distinct from r.contacto_id then n_lig := n_lig + 1; end if;
      v_links := v_links || jsonb_build_object(r.psid, r.contacto_id);
      if not p_seco then
        insert into agente.meta_psid (psid, plataforma, contacto_id, ligado_por)
        values (r.psid, p_plataforma, r.contacto_id, case when r.psid like 'prueba\_%' then 'prueba' else 'texto' end)
        on conflict (psid, plataforma) do update set contacto_id = excluded.contacto_id, ligado_en = now()
         where agente.meta_psid.contacto_id <> excluded.contacto_id;
      end if;
    else
      n_amb := n_amb + 1;
    end if;
  end loop;

  -- 2. mensajes de la PAGINA despues del cursor y con 20 s de antiguedad (el cerebro guarda su saliente despues)
  if p_seco then
    v_cursor := coalesce(p_desde, '-infinity'::timestamptz); v_hasta := coalesce(p_hasta, now());
  else
    select (detalle->>'ts')::timestamptz into v_cursor from agente.salud where clave = v_clave;
    v_hasta := now() - interval '20 seconds';
    if v_cursor is null then v_cursor := v_hasta; end if;   -- primera corrida: no se barre la historia
  end if;
  v_max := v_cursor;

  for r in
    select x.psid, x.ts, x.texto
      from jsonb_to_recordset(p_msgs) x(psid text, pagina boolean, ts timestamptz, texto text)
     where coalesce(x.pagina, false) and x.ts > v_cursor and x.ts <= v_hasta
     order by x.ts
  loop
    v_max := greatest(v_max, r.ts);
    v_contacto := v_links->>r.psid;
    if v_contacto is null then n_sin := n_sin + 1; continue; end if;
    if exists (select 1 from agente.mensajes m where m.contacto_id = v_contacto and m.direccion = 'saliente'
                  and m.creado_en between r.ts - interval '20 seconds' and r.ts + interval '20 seconds') then continue; end if;
    if exists (select 1 from unnest(v_excluir) e where coalesce(r.texto, '') like e || '%') then n_exc := n_exc + 1; continue; end if;
    n_hum := n_hum + 1;
    v_t60 := left(regexp_replace(regexp_replace(coalesce(r.texto, '[adjunto]'), '[0-9]', '', 'g'), '\s+', ' ', 'g'), 60);
    -- intervencion nueva = no hubo otro mensaje humano de ese contacto en las 2 h anteriores (sirve en sombra y en seco)
    if p_seco then
      select max((d->>'ts')::timestamptz) into v_ult from jsonb_array_elements(v_det) d where d->>'contacto' = v_contacto;
    else
      select max((detalle->>'ts')::timestamptz) into v_ult from agente.decisiones
       where tipo = 'humano_fbig' and detalle->>'contacto' = v_contacto and creado_en > now() - interval '3 days';
    end if;
    if v_ult is null or r.ts - v_ult > interval '2 hours' then n_int := n_int + 1; end if;
    if p_seco then
      v_det := v_det || jsonb_build_array(jsonb_build_object('contacto', v_contacto, 'ts', r.ts, 'texto', v_t60,
                 'nueva', v_ult is null or r.ts - v_ult > interval '2 hours'));
      continue;
    end if;
    insert into agente.decisiones (tipo, detalle)
    values ('humano_fbig', jsonb_build_object('contacto', v_contacto, 'ts', r.ts, 'texto', v_t60, 'canal', v_canal,
            'modo', v_modo, 'nueva', v_ult is null or r.ts - v_ult > interval '2 hours'));
    if v_modo = 'on' then n_av := n_av + agente.marcar_humano(v_contacto, r.ts, v_canal); end if;
  end loop;

  -- 3. recordatorio (solo 'on'): el cliente escribio en Graph despues del ultimo humano y del ultimo recordatorio,
  --    hace >= 15 min, y nadie le contesto. El texto se lee de Graph porque ManyChat puede retenerlo (S8).
  if v_modo = 'on' then
    for r in
      select q.id, q.contacto_id, coalesce(k.nombre, q.contacto_id) nombre, x.texto, x.ts
        from agente.preguntas_abiertas q
        join agente.contactos k on k.id = q.contacto_id
        cross join lateral (
          select y.texto, y.ts
            from jsonb_to_recordset(p_msgs) y(psid text, pagina boolean, ts timestamptz, texto text)
           where not coalesce(y.pagina, false) and v_links->>y.psid = q.contacto_id
             and y.ts > greatest(q.recordado_hasta, q.ultimo_humano_en)
             and lower(coalesce(y.texto, '')) !~ v_acuse
           order by y.ts desc limit 1) x
       where q.estado = 'abierta' and q.pausa and q.tomada_por = 'norman' and q.origen = case v_canal when 'facebook' then 'norman_fb' else 'norman_ig' end
         and q.ultimo_humano_en is not null and x.ts < now() - interval '15 minutes'
         and not exists (select 1
                           from jsonb_to_recordset(p_msgs) z(psid text, pagina boolean, ts timestamptz)
                          where coalesce(z.pagina, false) and v_links->>z.psid = q.contacto_id and z.ts > x.ts)
    loop
      perform agente.avisar_grupo(case when r.contacto_id like 'prueba\_%' then '[PRUEBA] ' else '' end ||
        split_part(r.nombre, ' ', 1) || ' escribio en ' || case v_canal when 'facebook' then 'Messenger' else 'Instagram' end ||
        ' "' || left(regexp_replace(coalesce(r.texto, '(adjunto)'), '\s+', ' ', 'g'), 90) || '" hace ' ||
        (extract(epoch from now() - r.ts) / 60)::int || ' min y no le has contestado. ¿La retomo? retoma · la sigo yo (#P' ||
        r.id || ')', null, null, 'principal');
      update agente.preguntas_abiertas set recordado_hasta = r.ts, avisado_en = now() where id = r.id;
      n_av := n_av + 1;
    end loop;
  end if;

  if not p_seco then
    insert into agente.salud (clave, en, detalle)
    values (v_clave, now(), jsonb_build_object('ts', v_max, 'modo', v_modo, 'msgs', jsonb_array_length(p_msgs),
            'ligados_nuevos', n_lig, 'ambiguos', n_amb, 'sin_ligar', n_sin, 'humanos', n_hum, 'avisos', n_av))
    on conflict (clave) do update set en = excluded.en, detalle = excluded.detalle;
  end if;
  return jsonb_build_object('modo', v_modo, 'msgs', jsonb_array_length(p_msgs), 'ligados_nuevos', n_lig,
    'ligados', (select count(*) from jsonb_object_keys(v_links)), 'ambiguos', n_amb, 'sin_ligar', n_sin,
    'humanos', n_hum, 'intervenciones', n_int, 'excluidos', n_exc, 'avisos', n_av, 'det', v_det);
end $f$;
