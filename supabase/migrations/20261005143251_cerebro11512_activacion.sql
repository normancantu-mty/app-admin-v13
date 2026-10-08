-- cerebro 1.15.12: activacion. Escrito el 2026-10-05 por el Socio (ejecutor).
-- (1b) el texto del cliente citado en el recordatorio de 2 h pierde cualquier '#P<n>': responder_retoma toma el PRIMER #P
--      del mensaje citado y un cliente podia desviar el 'retoma' de Norman a otra pausa (auditoria #6).
-- (1) caducar_pausas: el aviso nombra al cliente con su nombre completo (max 30), no con la 1a palabra ('La', emoji).
-- (2) cron caducar-pausas cada 5 min. (3) IG pasa de apagado a sombra (T3; 'on' es decision de Norman).
-- DESHACER:
--   select cron.unschedule('caducar-pausas');
--   update agente.cerebro_config set humano_ig = 'apagado' where id = 1;
--   (la funcion: volver a correr su bloque de cerebro/migracion_20261005140807_cerebro11512_humanos_y_caducidad.sql,
--    o drop function agente.caducar_pausas(boolean) si se deshace todo)
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
    select q.id, q.contacto_id, left(coalesce(nullif(trim(k.nombre), ''), q.contacto_id), 30) nombre
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
    select q.id, q.contacto_id, left(coalesce(nullif(trim(k.nombre), ''), q.contacto_id), 30) nombre, q.ultimo_entrante_en,
           (select left(regexp_replace(regexp_replace(m.texto, '#\s*[Pp]\s*\d+', '', 'g'), '\s+', ' ', 'g'), 90) from agente.mensajes m
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

select cron.schedule('caducar-pausas', '*/5 * * * *', 'select agente.caducar_pausas()');
update agente.cerebro_config set humano_ig = 'sombra' where id = 1;
