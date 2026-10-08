-- wa_ecos_norman (2026-10-05, Socio ejecutor). LucIA ve lo que Norman contesta a mano en WhatsApp.
-- Norman contesta desde la app WhatsApp Business (Coexistence). Lo que manda desde la app NO genera status
-- webhooks; Meta lo avisa con el campo `smb_message_echoes` (value.message_echoes[]). whatsapp-escucha 2.1.0
-- guarda la firma de cada POST y llama a agente.ecos_wa(); el cron 'ecos-wa' barre cada minuto lo que se escape.
-- 1. whatsapp_escucha.firma: 'ok' | 'sin_firma' | 'firma_invalida' | 'sin_secreto' | 'error' (null = previa a 2.1.0).
-- 2. cerebro_config.humano_wa: 'apagado' (nada) | 'sombra' (texto al historial, sin pausa) | 'on' (texto + pausa).
-- 3. agente.ecos_wa(): SOLO filas firmadas, del numero del negocio, de las ultimas 48 h. Inserta
--    direccion='saliente', origen='humano:wa', ext_id=wamid (idempotente por mensajes_ext_id_uniq). En 'on' y si el
--    eco tiene menos de 30 min, marcar_humano() pausa a LucIA (misma funcion que el vigia de statuses).
--    Solo tipos text/image/video/document/audio/sticker. Un texto identico ya mandado a OTRO cliente en 48 h
--    (ausencia, saludo, respuesta rapida) entra al historial pero NO pausa. Cada eco va en su propio bloque: uno
--    malo se cuenta en 'errores' y no frena a los demas. (Cambios del auditor #3 #4 #5 #14.)
--    El bot NO produce ecos (manda por Cloud API via ManyChat); aun asi se descarta un eco con el mismo texto que un
--    saliente no-humano del mismo contacto a +-20 s.
-- DESHACER rapido: select cron.unschedule('ecos-wa'); update agente.cerebro_config set humano_wa='apagado' where id=1;
-- DESHACER completo (tras redesplegar la escucha 2.0.1 y borrar las filas origen='humano:wa'):
--   drop function agente.ecos_wa(); drop index agente.ix_whatsapp_escucha_ecos;
--   alter table agente.cerebro_config drop column humano_wa; alter table agente.whatsapp_escucha drop column firma;
alter table agente.whatsapp_escucha add column if not exists firma text;
alter table agente.cerebro_config add column if not exists humano_wa text not null default 'on'
  check (humano_wa in ('apagado', 'sombra', 'on'));
create index if not exists ix_whatsapp_escucha_ecos on agente.whatsapp_escucha (recibido_en)
  where campo = 'smb_message_echoes';

create or replace function agente.ecos_wa()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
declare
  v_modo text; v_excluir text[]; r record; v_contacto text; v_conv uuid; v_texto text;
  n_ecos int := 0; n_ins int := 0; n_sin int := 0; n_bot int := 0; n_exc int := 0; n_pausa int := 0; n_nofirma int := 0;
  n_tipo int := 0; n_rep int := 0; n_err int := 0;
begin
  if not pg_try_advisory_xact_lock(115109) then return jsonb_build_object('ocupado', true); end if;
  select coalesce(humano_wa, 'apagado'), coalesce(humano_excluir, '{}') into v_modo, v_excluir
    from agente.cerebro_config where id = 1;
  if coalesce(v_modo, 'apagado') = 'apagado' then return jsonb_build_object('modo', 'apagado'); end if;
  perform agente.wa_ligar();

  for r in
    select w.id wid, w.firma, e->>'id' wamid, e->>'to' para, e->>'type' tipo,
           case when e->>'timestamp' ~ '^[0-9]{9,11}$' then to_timestamp((e->>'timestamp')::bigint) end ts,
           coalesce(e->'text'->>'body', e->(e->>'type')->>'caption') cuerpo
      from agente.whatsapp_escucha w
      cross join lateral jsonb_path_query(w.payload,
        '$.entry[*].changes[*] ? (@.field == "smb_message_echoes").value ? (@.metadata.phone_number_id == "1215580838295192").message_echoes[*]') e
     where w.campo = 'smb_message_echoes' and w.recibido_en > now() - interval '48 hours'
     order by w.id
  loop
    n_ecos := n_ecos + 1;
    if coalesce(r.firma, '') <> 'ok' then n_nofirma := n_nofirma + 1; continue; end if;
    if r.wamid is null or r.para is null or r.ts is null or r.para = '5218111767313' then continue; end if;
    -- reacciones, ediciones, borrados, unsupported: ni historial ni pausa
    if coalesce(r.tipo, '') not in ('text', 'image', 'video', 'document', 'audio', 'sticker') then
      n_tipo := n_tipo + 1; continue;
    end if;
    if exists (select 1 from agente.mensajes m where m.ext_id = r.wamid) then continue; end if;
    begin
      v_contacto := null; v_conv := null;
      select wt.contacto_id into v_contacto from agente.wa_telefonos wt where wt.tel10 = right(r.para, 10);
      if v_contacto is null then n_sin := n_sin + 1; continue; end if;
      v_texto := coalesce(nullif(r.cuerpo, ''), '[adjunto de Norman]');
      -- automatismos (bienvenida de ManyChat, etc.): mismos patrones que FB/IG
      if exists (select 1 from unnest(v_excluir) x where v_texto like x) then n_exc := n_exc + 1; continue; end if;
      -- el mismo texto que acaba de mandar LucIA no es Norman
      if exists (select 1 from agente.mensajes m where m.contacto_id = v_contacto and m.direccion = 'saliente'
                    and coalesce(m.origen, '') not like 'humano:%' and m.texto = v_texto
                    and m.creado_en between r.ts - interval '20 seconds' and r.ts + interval '20 seconds') then
        n_bot := n_bot + 1; continue;
      end if;
      select c.id into v_conv from agente.conversaciones c where c.contacto_id = v_contacto order by c.ultima_en desc limit 1;
      if v_conv is null then n_sin := n_sin + 1; continue; end if;
      insert into agente.mensajes (conversacion_id, contacto_id, direccion, texto, origen, canal, creado_en, ext_id)
      values (v_conv, v_contacto, 'saliente', v_texto, 'humano:wa', 'whatsapp', r.ts, r.wamid)
      on conflict (ext_id) where ext_id is not null do nothing;
      if not found then continue; end if;
      n_ins := n_ins + 1;
      insert into agente.decisiones (tipo, detalle)
      values ('humano_wa', jsonb_build_object('contacto', v_contacto, 'ts', r.ts, 'modo', v_modo, 'escucha_id', r.wid,
              'tipo', r.tipo, 'texto', left(regexp_replace(v_texto, '[0-9]', '', 'g'), 60)));
      -- texto identico ya mandado a OTRO cliente en 48 h = automatismo de la app o respuesta rapida: no pausa
      if r.tipo = 'text' and exists (select 1 from agente.mensajes m where m.origen = 'humano:wa' and m.texto = v_texto
                                       and m.contacto_id <> v_contacto and m.creado_en > r.ts - interval '48 hours') then
        n_rep := n_rep + 1;
      elsif v_modo = 'on' and r.ts > now() - interval '30 minutes' then
        n_pausa := n_pausa + agente.marcar_humano(v_contacto, r.ts, 'whatsapp');
      end if;
    exception when others then
      n_err := n_err + 1;
      raise warning 'ecos_wa: eco % fallo: %', r.wamid, sqlerrm;
    end;
  end loop;

  insert into agente.salud (clave, en, detalle)
  values ('ecos_wa', now(), jsonb_build_object('modo', v_modo, 'ecos', n_ecos, 'al_historial', n_ins, 'sin_ligar', n_sin,
          'bot', n_bot, 'excluidos', n_exc, 'avisos', n_pausa, 'sin_firma', n_nofirma, 'otro_tipo', n_tipo,
          'repetidos', n_rep, 'errores', n_err))
  on conflict (clave) do update set en = excluded.en, detalle = excluded.detalle;
  return jsonb_build_object('modo', v_modo, 'ecos', n_ecos, 'al_historial', n_ins, 'sin_ligar', n_sin, 'bot', n_bot,
    'excluidos', n_exc, 'avisos', n_pausa, 'sin_firma', n_nofirma, 'otro_tipo', n_tipo, 'repetidos', n_rep,
    'errores', n_err);
end $function$;

revoke all on function agente.ecos_wa() from public, anon, authenticated;
select cron.schedule('ecos-wa', '* * * * *', 'select agente.ecos_wa()');
