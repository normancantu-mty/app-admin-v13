-- cerebro-1.15.1 (2026-09-28) — N6 fix: responder_entregas ya no toma como entrega (1) un "si" citando otro aviso que
-- traiga #E (PEDIDO CERRADO, ¿Va la guia?), (2) un mensaje suelto con "si" cuando lo ultimo del grupo fue la pregunta pero
-- se esta citando otra cosa, ni (3) una mencion suelta del nombre del cliente fuera de contexto de entregas.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- DESHACER: el de 20260928143532_cerebro1151_entregas_guardian.sql (o reaplicar su responder_entregas).

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
  -- el #E de lo citado solo cuenta si lo citado es la pregunta de entregas (o el mensaje empieza con "entregado"):
  -- un "si" al aviso de PEDIDO CERRADO o de la guia NO es una entrega.
  select array_agg(x::bigint) into v_ctx
    from (select (regexp_matches(ra, '#E(\d+)', 'g'))[1] x) s
   where x::bigint = any(v_pend) and (v_reply or t ~ '^\s*entregad');
  -- "reciente" solo sin responder a otro mensaje: si cita otra cosa, habla de otra cosa.
  select ra = '' and exists (select 1 from agente.decisiones d where d.tipo = 'aviso_grupo' and d.creado_en > now() - interval '60 minutes'
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
      -- el nombre del cliente, solo en contexto de entregas (una mencion suelta en el grupo no marca nada)
      if v_reply or v_reciente or t ~ '^\s*entregad' then
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
