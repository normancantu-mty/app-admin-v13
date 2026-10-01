-- cerebro-1.15.1 (2026-09-28) — N4 guardian filtrado, N6 una pregunta por pedido, N10 parametros.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- DESHACER: volver a aplicar guardian_lineas, seguimiento_ventas y asuntos_abiertos de
--   migracion_meta/agente_schema_v6_cerebro115_2026-09-26.sql (o del respaldo en decisiones);
--   drop function agente.entregas_pendientes(boolean), agente.preguntar_entregas(boolean, boolean),
--   agente.responder_entregas(text, text, boolean), agente.nombre_items(jsonb);
--   select cron.unschedule('preguntar-entregas');
--   alter table agente.cerebro_config drop column insistir_min, drop column insistir_fbig;

alter table agente.cerebro_config add column if not exists insistir_min integer not null default 7;
alter table agente.cerebro_config add column if not exists insistir_fbig boolean not null default false;

-- "2 Plata 750, 1 Plata 250" (sin regalos)
create or replace function agente.nombre_items(p_items jsonb)
returns text language sql immutable set search_path to 'agente', 'public' as $f$
  select coalesce(string_agg((i->>'cantidad') || ' ' || initcap(split_part(i->>'sku', '-', 1)) ||
           coalesce(' ' || nullif(regexp_replace(split_part(i->>'sku', '-', 2), '\D', '', 'g'), ''), ''), ', '), '')
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) i
   where coalesce((i->>'regalo')::boolean, false) = false;
$f$;

-- Pedidos abiertos de entrega y cuantas veces se le pregunto a Norman. La marca vive en pedido_eventos:
-- nota 'pregunta_entrega' (se pregunto), 'entrega:no' (contesto que no), 'entrega:si' / 'entrega:cancelado'.
create or replace function agente.entregas_pendientes(p_prueba boolean)
returns table(pedido_id bigint, estado text, nombre text, renglon text, preguntas int, ultima timestamptz, dijo_no boolean)
language sql stable security definer set search_path to 'agente', 'public' as $f$
  select p.id, p.estado, coalesce(k.nombre, p.contacto_id),
         '#E' || p.id || ' ' || coalesce(split_part(k.nombre, ' ', 1), p.contacto_id) ||
           coalesce(', ' || nullif(agente.nombre_items(p.items), ''), '') ||
           coalesce(', $' || to_char(p.total, 'FM999,999'), ''),
         (select count(*) from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'pregunta_entrega')::int,
         (select max(e.creado_en) from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'pregunta_entrega'),
         exists (select 1 from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'entrega:no'
                  and e.creado_en > (select max(e2.creado_en) from agente.pedido_eventos e2
                                      where e2.pedido_id = p.id and e2.nota = 'pregunta_entrega'))
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where (p.estado = 'pagado' or (p.estado = 'pedido' and p.avisado_cerrado_en is not null))
     and coalesce(p.envio_decision, 'va') <> 'no'
     and (p.contacto_id like 'prueba\_%') = p_prueba;
$f$;

-- 21:30: UN mensaje con un renglon por pedido. Se pregunta si nunca se pregunto, o si contesto "no" (una vez mas).
create or replace function agente.preguntar_entregas(p_prueba boolean default false, p_enviar boolean default true)
returns text language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
        v_ids bigint[]; v_txt text; v_a text; v_b text;
begin
  select array_agg(e.pedido_id order by e.pedido_id),
         string_agg(e.renglon, ' · ' order by e.pedido_id)
    into v_ids, v_txt
    from agente.entregas_pendientes(p_prueba) e
   where e.preguntas = 0 or (e.preguntas = 1 and e.dijo_no and e.ultima < v_hoy);
  if v_ids is null then return null; end if;
  v_a := '#E' || v_ids[1];
  v_b := '#E' || v_ids[array_length(v_ids, 1)];
  v_txt := case when p_prueba then '[PRUEBA] ' else '' end || '📦 ¿Se entregaron? ' || v_txt || E'\nContesta: todos · ' ||
           v_a || ' si' || case when v_b <> v_a then ' · ' || v_b || ' no · cancelado ' || v_b
                                else ' · ' || v_a || ' no · cancelado ' || v_a end;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
  select p.id, p.estado, p.estado, 'cerebro', 'pregunta_entrega' from agente.pedidos p where p.id = any(v_ids);
  if p_enviar then perform agente.avisar_grupo(v_txt, null, null, 'principal'); end if;
  return v_txt;
end $f$;

-- Lo que Norman contesta en el grupo. null = no es de entregas (el cerebro sigue con su interprete).
create or replace function agente.responder_entregas(p_texto text, p_responde_a text, p_prueba boolean)
returns text language plpgsql security definer set search_path to 'agente', 'public' as $f$
declare
  t text := translate(lower(coalesce(p_texto, '')), 'áéíóúü', 'aeiouu');
  ra text := coalesce(p_responde_a, '');
  v_reply boolean := ra ~ '¿Se entregaron\?|¿Hablas de #E';
  v_reciente boolean;
  v_pend bigint[]; v_ctx bigint[]; v_obj bigint[]; v_si bigint[] := '{}'; v_no bigint[] := '{}'; v_can bigint[] := '{}';
  m text[]; r record; v_out text := ''; v_primero text;
begin
  select array_agg(e.pedido_id order by e.pedido_id) into v_pend
    from agente.entregas_pendientes(p_prueba) e where e.preguntas >= 1 and e.ultima > now() - interval '8 days';
  -- "entregado #E" fuera de pregunta tambien vale (sin ERP): se incluyen los pendientes aun no preguntados
  if t ~ '^\s*entregad' then
    select array_agg(e.pedido_id order by e.pedido_id) into v_pend from agente.entregas_pendientes(p_prueba) e;
  end if;
  if v_pend is null then return null; end if;
  select array_agg(x::bigint) into v_ctx
    from (select (regexp_matches(ra, '#E(\d+)', 'g'))[1] x) s where x::bigint = any(v_pend);
  select exists (select 1 from agente.decisiones d where d.tipo = 'aviso_grupo' and d.creado_en > now() - interval '60 minutes'
                   and (d.detalle->>'texto' like '[PRUEBA]%') = p_prueba
                   and d.detalle->>'texto' ~ '¿Se entregaron\?|¿Hablas de #E'
                   and d.id = (select max(d2.id) from agente.decisiones d2 where d2.tipo = 'aviso_grupo'
                                 and (d2.detalle->>'texto' like '[PRUEBA]%') = p_prueba)) into v_reciente;

  -- 1) pares explicitos: "#E42 si", "#E43 no", "cancelado #E43", "entregado #E42"
  for m in select regexp_matches(t, '#?e\s*(\d+)\s*[:,-]?\s*(si|no|entregad[oa]s?|cancelad[oa]s?)\M', 'g') loop
    if m[1]::bigint = any(v_pend) then
      if m[2] = 'no' then v_no := v_no || m[1]::bigint;
      elsif m[2] like 'cancel%' then v_can := v_can || m[1]::bigint;
      else v_si := v_si || m[1]::bigint; end if;
    end if;
  end loop;
  for m in select regexp_matches(t, '(cancelad[oa]s?|entregad[oa]s?)\s+#?e\s*(\d+)', 'g') loop
    if m[2]::bigint = any(v_pend) and not (m[2]::bigint = any(v_si || v_no || v_can)) then
      if m[1] like 'cancel%' then v_can := v_can || m[2]::bigint; else v_si := v_si || m[2]::bigint; end if;
    end if;
  end loop;

  if cardinality(v_si || v_no || v_can) = 0 then
    v_obj := coalesce(v_ctx, case when v_reply or v_reciente or t ~ '^\s*(todos|entregad)' then v_pend end);
    if t ~ '^\s*(s[ií]|si,? todos|todos( si)?|ya|listo|ya quedo|ya quedaron|entregad[oa]s?( todos)?|ya se entreg\w*|si,? ya se entreg\w*|ya se los? entreg\w*)[\s.!👍]*$'
       and v_obj is not null then
      if t !~ 'todos' and cardinality(v_obj) > 1 and v_ctx is null and t !~ '^\s*(ya se entregaron|entregad[oa]s)\s*$' then
        v_obj := null;  -- "si" suelto con varios pedidos: se pregunta cual
      else v_si := v_obj; end if;
    elsif t ~ '^\s*no[\s.!]*$' and v_obj is not null and cardinality(v_obj) = 1 then
      v_no := v_obj;
    elsif t ~ '^\s*cancelad[oa]s?[\s.!]*$' and v_obj is not null and cardinality(v_obj) = 1 then
      v_can := v_obj;
    else
      -- el nombre del cliente
      for r in select e.pedido_id, lower(translate(split_part(e.nombre, ' ', 1), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) n
                 from agente.entregas_pendientes(p_prueba) e where e.pedido_id = any(v_pend) loop
        if length(r.n) >= 3 and t ~ ('\m' || r.n || '\M') then
          if t ~ '\mno\M' then v_no := v_no || r.pedido_id;
          elsif t ~ 'cancel' then v_can := v_can || r.pedido_id;
          else v_si := v_si || r.pedido_id; end if;
        end if;
      end loop;
    end if;
  end if;

  if cardinality(v_si || v_no || v_can) = 0 then
    m := regexp_match(t, '#?\me\s*(\d+)');
    if m is not null and not (m[1]::bigint = any(v_pend)) then
      return coalesce((select '#E' || p.id || ' esta ' || p.estado || '; no esta pendiente de entrega.'
                         from agente.pedidos p where p.id = m[1]::bigint
                          and (p.contacto_id like 'prueba\_%') = p_prueba), '#E' || m[1] || ' no existe.');
    end if;
    if v_reply or (v_reciente and array_length(regexp_split_to_array(trim(t), '\s+'), 1) <= 4) or t ~ '^\s*entregad' then
      select e.renglon into v_primero from agente.entregas_pendientes(p_prueba) e
       where e.pedido_id = coalesce(v_ctx[1], v_pend[1]);
      return '¿Hablas de ' || split_part(v_primero, ',', 1) || '? Contesta si o no.';
    end if;
    return null;
  end if;

  for r in select p.id, p.estado from agente.pedidos p where p.id = any(v_si) and p.estado in ('pedido','pagado') loop
    update agente.pedidos set estado = 'entregado', actualizado_en = now() where id = r.id;
    insert into agente.pedido_eventos (pedido_id, de, a, por, nota) values (r.id, r.estado, 'entregado', 'humano', 'entrega:si');
    v_out := v_out || E'\n✅ #E' || r.id || ' entregado. No te lo vuelvo a preguntar.';
  end loop;
  for r in select p.id, p.estado from agente.pedidos p where p.id = any(v_can) and p.estado in ('pedido','pagado') loop
    update agente.pedidos set estado = 'cancelado', actualizado_en = now() where id = r.id;
    insert into agente.pedido_eventos (pedido_id, de, a, por, nota) values (r.id, r.estado, 'cancelado', 'humano', 'entrega:cancelado');
    v_out := v_out || E'\n🚫 #E' || r.id || ' cancelado. Sale del seguimiento.';
  end loop;
  for r in select p.id, p.estado, (select count(*) from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'pregunta_entrega') n
             from agente.pedidos p where p.id = any(v_no) loop
    insert into agente.pedido_eventos (pedido_id, de, a, por, nota) values (r.id, r.estado, r.estado, 'humano', 'entrega:no');
    v_out := v_out || E'\n⏳ #E' || r.id || ' sigue abierto. ' ||
             case when r.n < 2 then 'Te lo pregunto una vez mas mañana a las 21:30.' else 'Ya no te lo pregunto; sale en el resumen del domingo.' end;
  end loop;
  return nullif(ltrim(v_out, E'\n'), '');
end $f$;

-- seguimiento_ventas: el renglon 📦 (orden 4) ya no se repite cada noche. Sale la noche siguiente a una pregunta sin
-- respuesta (una vez) y despues solo el domingo (resumen semanal del guardian). Lo no preguntado lo pregunta el de 21:30.
create or replace function agente.seguimiento_ventas(p_prueba boolean)
returns table(orden integer, pedido_id bigint, dias integer, linea text)
language sql stable security definer set search_path to 'agente', 'public' as $f$
  with hoy as (select (now() at time zone 'America/Mexico_City')::date d),
  p as (
    select p.*, coalesce(p.avisado_cerrado_en,
             (select min(e.creado_en) from agente.pedido_eventos e where e.pedido_id = p.id and e.a = p.estado),
             p.creado_en) as desde, ep.preguntas, ep.ultima, ep.dijo_no
      from agente.pedidos p join agente.entregas_pendientes(p_prueba) ep on ep.pedido_id = p.id)
  select 4, p.id, (extract(epoch from now() - p.desde) / 86400)::int,
         '📦 Pedido #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || coalesce(' (' || p.ciudad || ')', '') ||
         ' ' || p.estado || ' hace ' || (extract(epoch from now() - p.desde) / 86400)::int ||
         ' d, sin entrega (te lo pregunte ' || to_char(p.ultima at time zone 'America/Mexico_City', 'DD-MM') ||
         '): "#E' || p.id || ' si" o "cancelado #E' || p.id || '"'
    from p join agente.contactos k on k.id = p.contacto_id, hoy
   where p.preguntas >= 1 and extract(hour from now() at time zone 'America/Mexico_City') >= 21
     and ((p.preguntas = 1 and not p.dijo_no and (p.ultima at time zone 'America/Mexico_City')::date = hoy.d - 1)
          or extract(dow from hoy.d) = 0)
  union all
  select 7, v.pedido_id, (extract(epoch from now() - coalesce(v.registrada_en, v.creado_en)) / 86400)::int,
         '🧾 #E' || v.pedido_id || ' de ' || coalesce(k.nombre, p.contacto_id) || coalesce(' (' || v.ciudad || ')', '') ||
         ' esta en el ERP sin costo de ' || case when v.zona = 'nacional' then 'guia' else 'envio' end || ' desde hace ' ||
         (extract(epoch from now() - coalesce(v.registrada_en, v.creado_en)) / 86400)::int ||
         ' d (contesta el monto al aviso del #E' || v.pedido_id || ', 0 si no hubo)'
    from agente.ventas_erp v join agente.pedidos p on p.id = v.pedido_id join agente.contactos k on k.id = p.contacto_id
   where v.estado = 'registrada' and v.envio_costo is null
     and coalesce(v.registrada_en, v.creado_en) <= now() - interval '2 hours'
     and (p.contacto_id like 'prueba\_%') = p_prueba
  union all
  select 8, v.pedido_id, (extract(epoch from now() - v.creado_en) / 86400)::int,
         '⚠️ #E' || v.pedido_id || ' de ' || coalesce(k.nombre, p.contacto_id) || ' NO entro al ERP (' ||
         case when v.estado = 'registrando' then 'quedo a medias, revisa si hay ticket' else left(coalesce(v.error, '?'), 120) end ||
         '). Arreglalo y vuelve a escribir "entregado #E' || v.pedido_id || '", o "cancelado #E' || v.pedido_id || '"'
    from agente.ventas_erp v join agente.pedidos p on p.id = v.pedido_id join agente.contactos k on k.id = p.contacto_id
   where (v.estado = 'error' or (v.estado = 'registrando' and v.creado_en <= now() - interval '10 minutes'))
     and (p.contacto_id like 'prueba\_%') = p_prueba;
$f$;

select cron.schedule('preguntar-entregas', '30 3 * * *', 'select agente.preguntar_entregas(false, true)');

-- N4: el 👀 del guardian aplica el mismo filtro que asuntos_abiertos (1.15 D): fuera acuses, fuera contactos con
-- pausa abierta o tomada por Norman en 24 h. En modo prueba lee las alertas de hilo 'prueba%' (antes no leia ninguna).
do $d$
declare v_def text; v_viejo text; v_nuevo text;
begin
  v_def := pg_get_functiondef('agente.guardian_lineas(text, boolean)'::regprocedure);
  v_viejo := $v$  if not v_prueba then
    return query
    select 'atender', 6, null::text,
           '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
           (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h y en la bandeja nadie le contesto: "' ||
           left(coalesce(v.texto,''), 90) || '"', true
      from agente.vigia_alertas v
     where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
     order by v.id;
  end if;$v$;
  v_nuevo := $v$  return query
    select 'atender', 6, null::text,
           '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
           (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h y en la bandeja nadie le contesto: "' ||
           left(coalesce(v.texto,''), 90) || '"', true
      from agente.vigia_alertas v
     where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
       and (coalesce(v.hilo, '') like 'prueba%') = v_prueba
       and lower(coalesce(v.texto, '')) !~ '^\s*(ok[a-z]*|okey|okay|va|vale|sale|listo|gracias|muchas gracias|mil gracias|grax|thx|👍|🙏|😊|🙌|👌|❤️)[\s.!¡]*$'
       and not exists (
         select 1 from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
          where q.pausa and (q.estado = 'abierta' or q.tomada_por = 'norman' and q.creado_en > now() - interval '24 hours')
            and ((v.canal = 'whatsapp' and k.telefono_e164 is not null
                  and right(regexp_replace(k.telefono_e164, '\D', '', 'g'), 10) = right(regexp_replace(v.hilo, '\D', '', 'g'), 10))
                 or (k.nombre is not null and k.nombre = v.quien and k.canal = v.canal)))
     order by v.id;$v$;
  if position(v_viejo in v_def) = 0 then raise exception 'guardian_lineas no trae el bloque 👀 esperado'; end if;
  execute replace(v_def, v_viejo, v_nuevo);
end $d$;
