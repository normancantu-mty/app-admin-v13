-- fbig-vigia-humano (2026-09-28) — E2 ajuste tras el backtest (19-09 a 28-09, Messenger). El backtest en seco dio 3
-- intervenciones: las 2 esperadas (Angel 23-09 00:39, Nubia 23-09 21:05-21:15, 5/5 mensajes) y 1 falsa: la bienvenida
-- automatica de ManyChat a Alexis (19-09 14:46:01 + su imagen), 26 s antes de la respuesta del cerebro (fuera de +-20 s).
-- Arreglo, como dice la tabla de fallas: una lista de exclusion en cerebro_config (patrones LIKE), no en el codigo.
-- Un adjunto sin texto a +-5 s de un mensaje excluido del mismo hilo cuenta como parte de ese flujo.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- DESHACER: reaplicar agente.humanos_meta de 20260928161046_fbig_humano_meta.sql y
--   update agente.cerebro_config set humano_excluir = '{}';

comment on column agente.cerebro_config.humano_excluir is
  'Patrones LIKE del texto de la PAGINA que no cuentan como humano (automatismos de ManyChat, avisos de Meta). Se agregan aqui, no en el codigo.';
update agente.cerebro_config set humano_excluir = array[
  '¡Hola, %! Qué bueno que nos escribes%',      -- bienvenida vieja de ManyChat (hasta 19-09)
  '¡Hola, %! Qué gusto que nos escribas%',      -- bienvenida de ManyChat (desde 23-09)
  '%Solo pasaba a recordarte%',                 -- seguimiento automatico de ManyChat
  'Aquí tienes dos excelentes opciones para conseguirlo%',
  '✨Tambien te dejo nuestro Whats app%',
  '% respondió una publicación%'                -- aviso de Meta cuando el cliente responde a una historia/publicacion
];

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
    -- automatismo (bienvenida/seguimiento de ManyChat, aviso de Meta): patron LIKE de humano_excluir; un adjunto sin
    -- texto a +-5 s de uno excluido del mismo hilo es la imagen de ese mismo flujo
    if exists (select 1 from unnest(v_excluir) e where coalesce(r.texto, '') like e)
       or (r.texto is null and exists (
             select 1 from jsonb_to_recordset(p_msgs) z(psid text, pagina boolean, ts timestamptz, texto text), unnest(v_excluir) e
              where coalesce(z.pagina, false) and z.psid = r.psid and abs(extract(epoch from z.ts - r.ts)) <= 5
                and coalesce(z.texto, '') like e)) then
      n_exc := n_exc + 1; continue;
    end if;
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
    'humanos', n_hum, 'intervenciones', n_int, 'excluidos', n_exc, 'avisos', n_av, 'det', v_det,
    'links', case when p_seco then v_links end);
end $f$;
