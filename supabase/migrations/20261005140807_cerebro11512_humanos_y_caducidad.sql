-- cerebro 1.15.12 — T3 (el bot ve lo que Norman contesta en FB/IG) + T4 (las pausas tomadas por Norman caducan).
-- Escrito el 2026-10-05 por el Socio (ejecutor de cerebro 1.15.12). ADITIVA: columnas nuevas nullable, funcion nueva,
-- cron nuevo; humanos_meta y abrir_turno se reemplazan por SUPERCONJUNTOS compatibles con la v55 (abrir_turno solo agrega
-- la llave 'origen' al historial; humanos_meta solo agrega el INSERT de lo humano y excluye 'humano:%' del cotejo +-20 s).
-- DESHACER: cerebro/DESHACER_migracion_cerebro11512.sql (definiciones anteriores literales + drops).

-- T3.1 — idempotencia por el id de mensaje de Graph
alter table agente.mensajes add column if not exists ext_id text;
create unique index if not exists mensajes_ext_id_uniq on agente.mensajes (ext_id) where ext_id is not null;
-- el CHECK de origen acepta 'humano' (lo demas, igual que antes)
alter table agente.mensajes drop constraint if exists mensajes_origen_check;
alter table agente.mensajes add constraint mensajes_origen_check
  check (split_part(split_part(origen, '@', 1), ':', 1) = any (array['modelo', 'reglas', 'puente', 'cliente', 'fijo', 'humano']));

-- T4 — marca del recordatorio de 2 h (el de 15 min usa recordado_hasta)
alter table agente.preguntas_abiertas add column if not exists recordado_2h_en timestamptz;

-- T3.2 — humanos_meta: en sombra/on, lo que Norman escribio en la pagina entra a agente.mensajes como saliente humano:fb|ig
CREATE OR REPLACE FUNCTION agente.humanos_meta(p_plataforma text, p_msgs jsonb, p_seco boolean DEFAULT false, p_desde timestamp with time zone DEFAULT NULL::timestamp with time zone, p_hasta timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  v_canal text := case p_plataforma when 'messenger' then 'facebook' else 'instagram' end;
  v_clave text := case p_plataforma when 'messenger' then 'n7fb_cursor' else 'n7ig_cursor' end;
  v_modo text; v_excluir text[]; v_links jsonb; v_cursor timestamptz; v_hasta timestamptz; v_max timestamptz;
  v_contacto text; v_t60 text; v_ult timestamptz; v_conv uuid;
  n_lig int := 0; n_amb int := 0; n_sin int := 0; n_hum int := 0; n_int int := 0; n_exc int := 0; n_av int := 0; n_ins int := 0;
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
    select x.id, x.psid, x.ts, x.texto
      from jsonb_to_recordset(p_msgs) x(id text, psid text, pagina boolean, ts timestamptz, texto text)
     where coalesce(x.pagina, false) and x.ts > v_cursor and x.ts <= v_hasta
     order by x.ts
  loop
    v_max := greatest(v_max, r.ts);
    v_contacto := v_links->>r.psid;
    if v_contacto is null then n_sin := n_sin + 1; continue; end if;
    -- 1.15.12: el cotejo es contra lo que mando el CEREBRO; las filas humano:* (que inserta esta misma funcion) no cuentan
    if exists (select 1 from agente.mensajes m where m.contacto_id = v_contacto and m.direccion = 'saliente'
                  and coalesce(m.origen, '') not like 'humano:%'
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
    -- 1.15.12 T3: el texto COMPLETO entra al historial del cliente (sombra y on). Idempotente por el id de Graph; sin id,
    -- por huella de psid+ts+texto. Sin texto (adjunto) queda '[adjunto de Norman]': Graph no da el contenido aqui.
    select c.id into v_conv from agente.conversaciones c where c.contacto_id = v_contacto order by c.ultima_en desc limit 1;
    if v_conv is not null then
      insert into agente.mensajes (conversacion_id, contacto_id, direccion, texto, origen, canal, creado_en, ext_id)
      values (v_conv, v_contacto, 'saliente', coalesce(nullif(r.texto, ''), '[adjunto de Norman]'),
              case v_canal when 'facebook' then 'humano:fb' else 'humano:ig' end, v_canal, r.ts,
              coalesce(r.id, 'h:' || md5(coalesce(r.psid, '') || r.ts::text || coalesce(r.texto, ''))))
      on conflict (ext_id) where ext_id is not null do nothing;
      if found then n_ins := n_ins + 1; end if;
    end if;
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
            'ligados_nuevos', n_lig, 'ambiguos', n_amb, 'sin_ligar', n_sin, 'humanos', n_hum, 'avisos', n_av,
            'al_historial', n_ins))
    on conflict (clave) do update set en = excluded.en, detalle = excluded.detalle;
  end if;
  return jsonb_build_object('modo', v_modo, 'msgs', jsonb_array_length(p_msgs), 'ligados_nuevos', n_lig,
    'ligados', (select count(*) from jsonb_object_keys(v_links)), 'ambiguos', n_amb, 'sin_ligar', n_sin,
    'humanos', n_hum, 'intervenciones', n_int, 'excluidos', n_exc, 'avisos', n_av, 'al_historial', n_ins, 'det', v_det,
    'links', case when p_seco then v_links end);
end $function$;

-- T3.3 — abrir_turno: el historial lleva 'origen' (para que el cerebro marque lo que dijo Norman). Lo demas, identico.
CREATE OR REPLACE FUNCTION agente.abrir_turno(p_id text, p_canal text, p_nombre text, p_horas integer, p_n integer, p_max_reglas integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
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
           'en', t.creado_en, 'conv', t.conversacion_id, 'origen', t.origen) order by t.creado_en, t.id), '[]'::jsonb)
    into v_hist
    from (select m.direccion, m.texto, m.creado_en, m.id, m.conversacion_id, m.origen
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
                             order by p.id desc limit 1)))
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

-- T4 — caducidad de pausas tomadas por Norman (12 h sin actividad humana) + recordatorio de 2 h si el cliente escribio.
-- Actividad humana = la mas reciente de: creacion de la pausa, ultimo_humano_en (deteccion WA/FB/IG), recordado_hasta
-- ("la sigo yo" lo pone en now()), y la ultima fila humano:* del contacto. Prueba (prueba_*): se cierra igual, sin aviso.
-- p_seco = true: no cambia nada ni avisa; devuelve lo que haria (para pruebas y para medir).
create or replace function agente.caducar_pausas(p_seco boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
declare
  r record; v_real text := ''; v_prueba text := ''; n_c int := 0; n_r int := 0; v_avisos jsonb := '[]'::jsonb; v_txt text;
begin
  if not p_seco and not pg_try_advisory_xact_lock(115112) then return jsonb_build_object('ocupado', true); end if;
  -- 1. caducan
  for r in
    select q.id, q.contacto_id, split_part(coalesce(k.nombre, q.contacto_id), ' ', 1) nombre
      from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
     where q.estado = 'abierta' and q.pausa and q.tomada_por = 'norman'
       and greatest(q.creado_en, coalesce(q.ultimo_humano_en, q.creado_en), coalesce(q.recordado_hasta, q.creado_en),
             coalesce((select max(m.creado_en) from agente.mensajes m
                        where m.contacto_id = q.contacto_id and m.origen like 'humano:%'), q.creado_en))
           < now() - interval '12 hours'
     order by q.id
  loop
    n_c := n_c + 1;
    if r.contacto_id like 'prueba\_%' then
      v_prueba := v_prueba || case when v_prueba = '' then '' else ', ' end || r.nombre || ' (#P' || r.id || ')';
    else
      v_real := v_real || case when v_real = '' then '' else ', ' end || r.nombre || ' (#P' || r.id || ')';
    end if;
    if not p_seco then
      update agente.preguntas_abiertas set estado = 'cerrada', cerrada_en = now(), cerrada_por = 'caducada_12h'
       where id = r.id and estado = 'abierta';
      insert into agente.decisiones (tipo, detalle)
      values ('pausa_caducada', jsonb_build_object('pregunta', r.id, 'contacto', r.contacto_id));
    end if;
  end loop;
  if v_real <> '' then
    v_txt := '⏱️ 12 h sin actividad tuya: cerre la pausa y LucIA retoma a ' || v_real ||
             '. Si alguno lo sigues tu, escribe "ya no contestes a <nombre>".';
    v_avisos := v_avisos || to_jsonb(v_txt);
    if not p_seco then perform agente.avisar_grupo(v_txt, null, null, 'principal'); end if;
  end if;
  if v_prueba <> '' then
    v_avisos := v_avisos || to_jsonb('[PRUEBA] (sin aviso) caducadas: ' || v_prueba);
  end if;

  -- 2. recordatorio de 2 h: el cliente escribio durante la pausa, hace >= 2 h, despues de la ultima actividad humana,
  --    y de ese mensaje todavia no se recordo a las 2 h. Uno por mensaje (el de 15 min sigue donde estaba).
  for r in
    select q.id, q.contacto_id, split_part(coalesce(k.nombre, q.contacto_id), ' ', 1) nombre, q.ultimo_entrante_en,
           (select left(regexp_replace(m.texto, '\s+', ' ', 'g'), 90) from agente.mensajes m
             where m.contacto_id = q.contacto_id and m.direccion = 'entrante' order by m.id desc limit 1) texto
      from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
     where q.estado = 'abierta' and q.pausa and q.tomada_por = 'norman'
       and q.ultimo_entrante_en is not null
       and q.ultimo_entrante_en < now() - interval '2 hours'
       and q.ultimo_entrante_en > now() - interval '12 hours'
       and q.ultimo_entrante_en > coalesce(q.recordado_2h_en, '-infinity'::timestamptz)
       and q.ultimo_entrante_en > greatest(coalesce(q.ultimo_humano_en, '-infinity'::timestamptz),
             coalesce((select max(m.creado_en) from agente.mensajes m
                        where m.contacto_id = q.contacto_id and m.origen like 'humano:%'), '-infinity'::timestamptz))
  loop
    n_r := n_r + 1;
    v_txt := case when r.contacto_id like 'prueba\_%' then '[PRUEBA] ' else '' end || '⏰ ' || r.nombre ||
             ' te escribio hace ' || floor(extract(epoch from now() - r.ultimo_entrante_en) / 3600)::int ||
             ' h y sigue sin respuesta: "' || coalesce(r.texto, '(adjunto)') || '". ¿La retomo? retoma · la sigo yo (#P' || r.id || ')';
    v_avisos := v_avisos || to_jsonb(v_txt);
    if not p_seco then
      update agente.preguntas_abiertas set recordado_2h_en = r.ultimo_entrante_en, avisado_en = now() where id = r.id;
      if r.contacto_id not like 'prueba\_%' then perform agente.avisar_grupo(v_txt, null, null, 'principal'); end if;
    end if;
  end loop;

  return jsonb_build_object('caducadas', n_c, 'recordadas_2h', n_r, 'avisos', v_avisos, 'seco', p_seco);
end $function$;

