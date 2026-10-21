-- migracion_cerebro1169_entregas.sql -- cerebro 1.16.9 (encargo DESDE_SOCIO_prompt_ejecutor_cerebro_1.16.9_copy_contexto).
-- Escrito el 2026-10-15 por el ejecutor del Socio. NO APLICADO. Probado en Postgres 16 local (cerebro/probar_1169_pg.test.ts).
-- Se puede aplicar antes o despues del cerebro 1.16.9 (el codigo no depende de esto; el indice es el 2o candado del COPY NUEVO).
-- (1) agente.entregas_pendientes_todas(p_prueba): la entregas_pendientes de hoy, intacta, con otro nombre (sin ventana).
-- (2) agente.entregas_pendientes(p_prueba): MISMA firma y columnas (preguntar_entregas y seguimiento_ventas no cambian),
--     ventana de 10 dias. Efecto colateral: el resumen del domingo (seguimiento_ventas) tampoco lista los viejos.
-- (3) agente.responder_entregas: "Sii", "si ya", "ya, si", "si, el de <nombre>"; sin cita usa los #E del ULTIMO aviso de
--     entregas (60 min) y nunca v_pend[1]; ambiguo -> null (cae al interprete); "¿Hablas de" solo con un candidato y
--     maximo 3 preguntas por #E (pregunta_entrega + pregunta_hablas, este evento es nuevo). "#E173 si" explicito vale sin ventana.
-- (4) indice unico parcial: un solo COPY NUEVO por (pedido, base).
-- Guarda: si las funciones vivas no son las leidas el 2026-10-15 (md5 de prosrc), ABORTA todo. NO cambia estados de pedidos.
-- Comprobar despues:
--   select count(*) from agente.entregas_pendientes(false);          -- <= que la de abajo
--   select count(*) from agente.entregas_pendientes_todas(false);

begin;

do $g$
declare
  vp text := (select prosrc from pg_proc where oid = 'agente.entregas_pendientes(boolean)'::regprocedure);
  vr text := (select prosrc from pg_proc where oid = 'agente.responder_entregas(text,text,boolean)'::regprocedure);
begin
  if md5(vp) <> 'a6922040ac39a2a2fb59e07f1ede537b' and position('1.16.9' in vp) = 0 then
    raise exception 'entregas_pendientes viva distinta a la leida el 2026-10-15 (md5 %): ALTO', md5(vp);
  end if;
  if md5(vr) <> '456bf26c82d874a0eff3ce8e87f9e979' and position('1.16.9' in vr) = 0 then
    raise exception 'responder_entregas viva distinta a la leida el 2026-10-15 (md5 %): ALTO', md5(vr);
  end if;
end $g$;

CREATE OR REPLACE FUNCTION agente.entregas_pendientes_todas(p_prueba boolean)
 RETURNS TABLE(pedido_id bigint, estado text, nombre text, renglon text, preguntas integer, ultima timestamp with time zone, dijo_no boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
  select p.id, p.estado, coalesce(k.nombre, p.contacto_id),
         '#E' || p.id || ' ' || coalesce(split_part(k.nombre, ' ', 1), p.contacto_id) ||
           coalesce(', ' || nullif(agente.nombre_items(p.items), ''), '') ||
           coalesce(', $' || to_char(coalesce(p.total_cobrado, p.total), 'FM999,999'), ''),
         (select count(*) from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'pregunta_entrega')::int,
         (select max(e.creado_en) from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'pregunta_entrega'),
         exists (select 1 from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'entrega:no'
                  and e.creado_en > (select max(e2.creado_en) from agente.pedido_eventos e2
                                      where e2.pedido_id = p.id and e2.nota = 'pregunta_entrega'))
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where (p.estado = 'pagado' or (p.estado = 'pedido' and p.avisado_cerrado_en is not null))
     and coalesce(p.envio_decision, 'va') <> 'no'
     and (p.contacto_id like 'prueba\_%') = p_prueba;
$function$;

CREATE OR REPLACE FUNCTION agente.entregas_pendientes(p_prueba boolean)
 RETURNS TABLE(pedido_id bigint, estado text, nombre text, renglon text, preguntas integer, ultima timestamp with time zone, dijo_no boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
  -- 1.16.9: misma firma y columnas; solo los pedidos con movimiento en los ultimos 10 dias (pedido, contacto o evento
  -- que no sea una pregunta del bot). Los viejos NO cambian de estado: solo salen del contexto (cierre = decision de Norman).
  select e.*
    from agente.entregas_pendientes_todas(p_prueba) e
    join agente.pedidos p on p.id = e.pedido_id
    join agente.contactos k on k.id = p.contacto_id
   where greatest(p.actualizado_en, p.creado_en, p.avisado_cerrado_en, k.ultimo_visto,
                  (select max(x.creado_en) from agente.pedido_eventos x where x.pedido_id = p.id
                      and coalesce(x.nota, '') not in ('pregunta_entrega', 'pregunta_hablas', 'entrega:no')))
         > now() - interval '10 days';
$function$;

CREATE OR REPLACE FUNCTION agente.responder_entregas(p_texto text, p_responde_a text, p_prueba boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
-- 1.16.9: "Sii"/"si ya"/"ya, si"/"si, el de <nombre>"; sin cita manda el ULTIMO #E preguntado (nunca v_pend[1]);
-- lo ambiguo devuelve null (cae al interprete); "¿Hablas de" solo con UN candidato y maximo 3 preguntas por #E.
declare
  t text := translate(lower(coalesce(p_texto, '')), 'áéíóúü', 'aeiouu');
  ra text := coalesce(p_responde_a, '');
  v_reply boolean := ra ~ '¿Se entregaron\?|¿Hablas de #E';
  v_reciente boolean := false; v_aviso text;
  v_pend bigint[]; v_todos bigint[]; v_ctx bigint[]; v_ult bigint[]; v_obj bigint[]; v_cand bigint[];
  v_si bigint[] := '{}'; v_no bigint[] := '{}'; v_can bigint[] := '{}';
  m text[]; r record; v_out text := ''; v_primero text; v_res jsonb; v_n int;
begin
  -- ventana (10 d, agente.entregas_pendientes) y recencia: el ultimo preguntado primero
  select array_agg(e.pedido_id order by e.ultima desc nulls last, e.pedido_id desc) into v_pend
    from agente.entregas_pendientes(p_prueba) e where e.preguntas >= 1;
  if t ~ '^\s*entregad' then
    select array_agg(e.pedido_id order by e.ultima desc nulls last, e.pedido_id desc) into v_pend
      from agente.entregas_pendientes(p_prueba) e;
  end if;
  -- sin ventana: un "#E173 si" escrito a proposito (o la cita de su pregunta) vale aunque el pedido sea viejo
  select array_agg(e.pedido_id) into v_todos from agente.entregas_pendientes_todas(p_prueba) e;
  if v_todos is null then return null; end if;
  v_pend := coalesce(v_pend, '{}');
  select array_agg(x::bigint) into v_ctx
    from (select (regexp_matches(ra, '#E(\d+)', 'g'))[1] x) s
   where x::bigint = any(v_todos) and (v_reply or t ~ '^\s*entregad');
  -- sin cita: el ultimo aviso del grupo (60 min, mismo carril) si fue la pregunta de entregas -> sus #E
  if ra = '' then
    select d.detalle->>'texto' into v_aviso from agente.decisiones d
     where d.tipo = 'aviso_grupo' and d.creado_en > now() - interval '60 minutes'
       and (d.detalle->>'texto' like '[PRUEBA]%') = p_prueba
       and d.id = (select max(d2.id) from agente.decisiones d2 where d2.tipo = 'aviso_grupo'
                     and (d2.detalle->>'texto' like '[PRUEBA]%') = p_prueba);
    v_reciente := coalesce(v_aviso ~ '¿Se entregaron\?|¿Hablas de #E', false);
    if v_reciente then
      select array_agg(x::bigint) into v_ult
        from (select (regexp_matches(v_aviso, '#E(\d+)', 'g'))[1] x) s where x::bigint = any(v_todos);
    end if;
  end if;

  -- 1) pares explicitos: "#E42 si", "#E43 no", "cancelado #E43", "entregado #E42"
  for m in select regexp_matches(t, '#?e\s*(\d+)\s*[:,-]?\s*(s[ií]+|no|entregad[oa]s?|cancelad[oa]s?)\M', 'g') loop
    if m[1]::bigint = any(v_todos) then
      if m[2] = 'no' then v_no := v_no || m[1]::bigint;
      elsif m[2] like 'cancel%' then v_can := v_can || m[1]::bigint;
      else v_si := v_si || m[1]::bigint; end if;
    end if;
  end loop;
  for m in select regexp_matches(t, '(cancelad[oa]s?|entregad[oa]s?)\s+#?e\s*(\d+)', 'g') loop
    if m[2]::bigint = any(v_todos) and not (m[2]::bigint = any(v_si || v_no || v_can)) then
      if m[1] like 'cancel%' then v_can := v_can || m[2]::bigint; else v_si := v_si || m[2]::bigint; end if;
    end if;
  end loop;

  if cardinality(v_si || v_no || v_can) = 0 then
    v_obj := coalesce(v_ctx, v_ult, case when t ~ '^\s*(todos|entregad)' then nullif(v_pend, '{}') end);
    -- "si, el de Julio" / "ya, la de Monica": el nombre decide entre los candidatos (o los pendientes de la ventana)
    m := regexp_match(t, '^\s*(s[ií]+|ya)\s*,?\s*(ya\s*,?\s*)?(el|la|lo)\s+de\s+([a-zñ]{3,})');
    if m is not null then
      select array_agg(e.pedido_id) into v_cand from agente.entregas_pendientes_todas(p_prueba) e
       where e.pedido_id = any(coalesce(v_obj, v_pend))
         and lower(translate(split_part(e.nombre, ' ', 1), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = m[4];
      if cardinality(v_cand) = 1 then v_si := v_cand; else return null; end if;
    elsif t ~ '^\s*(s[ií]+|s[ií]+,? todos|todos( s[ií]+)?|ya|s[ií]+,? ya|ya,? s[ií]+|listo|ya quedo|ya quedaron|entregad[oa]s?( todos)?|ya se entreg\w*|s[ií]+,? ya se entreg\w*|ya se los? entreg\w*)[\s.!👍]*$'
       and v_obj is not null then
      if t !~ 'todos' and cardinality(v_obj) > 1 and t !~ '^\s*(ya se entregaron|entregad[oa]s)\s*$' then
        return null;  -- "si" suelto con varios pedidos: ambiguo, lo resuelve el interprete (no "¿Hablas de")
      else v_si := v_obj; end if;
    elsif t ~ '^\s*no[\s.!]*$' and v_obj is not null and cardinality(v_obj) = 1 then
      v_no := v_obj;
    elsif t ~ '^\s*cancelad[oa]s?[\s.!]*$' and v_obj is not null and cardinality(v_obj) = 1 then
      v_can := v_obj;
    else
      -- el nombre del cliente, solo en contexto de entregas (una mencion suelta en el grupo no marca nada)
      if v_reply or t ~ '^\s*entregad'
         or (v_reciente and array_length(regexp_split_to_array(trim(t), '\s+'), 1) <= 4) then
      for r in select e.pedido_id, lower(translate(split_part(e.nombre, ' ', 1), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) n
                 from agente.entregas_pendientes_todas(p_prueba) e
                where e.pedido_id = any(coalesce(v_ctx, v_ult, v_pend)) loop
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
    if m is not null and not (m[1]::bigint = any(v_todos)) then
      return coalesce((select '#E' || p.id || ' esta ' || p.estado || '; no esta pendiente de entrega.'
                         from agente.pedidos p where p.id = m[1]::bigint
                          and (p.contacto_id like 'prueba\_%') = p_prueba), '#E' || m[1] || ' no existe.');
    end if;
    if m is not null then return null; end if;  -- un #E pendiente sin si/no claro: lo resuelve el interprete
    -- "¿Hablas de": solo con UN candidato (lo citado o lo ultimo preguntado) y maximo 3 preguntas por #E.
    v_cand := coalesce(v_ctx, v_ult);
    if cardinality(v_cand) = 1
       and (v_reply or (v_reciente and array_length(regexp_split_to_array(trim(t), '\s+'), 1) <= 4) or t ~ '^\s*entregad') then
      select e.renglon, e.preguntas into v_primero, v_n from agente.entregas_pendientes_todas(p_prueba) e
       where e.pedido_id = v_cand[1];
      v_n := coalesce(v_n, 0) + (select count(*) from agente.pedido_eventos e
                                  where e.pedido_id = v_cand[1] and e.nota = 'pregunta_hablas')::int;
      if v_primero is null or v_n >= 3 then return null; end if;
      insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
      select p.id, p.estado, p.estado, 'cerebro', 'pregunta_hablas' from agente.pedidos p where p.id = v_cand[1];
      return '¿Hablas de ' || split_part(v_primero, ',', 1) || '? Contesta si o no.';
    end if;
    return null;
  end if;

  -- 1.16.0 A: entregado / cancelado solo por agente.cerrar_pedido (cierra tambien las preguntas ligadas).
  for r in select p.id, p.estado from agente.pedidos p where p.id = any(v_si) and p.estado in ('pedido','pagado') loop
    v_res := agente.cerrar_pedido(r.id, 'entregado', 'humano', 'entrega:si');
    if (v_res->>'ok')::boolean and not coalesce((v_res->>'ya')::boolean, false) then
      v_out := v_out || E'\n✅ #E' || r.id || ' entregado. No te lo vuelvo a preguntar.';
    end if;
  end loop;
  for r in select p.id, p.estado from agente.pedidos p where p.id = any(v_can) and p.estado in ('pedido','pagado') loop
    v_res := agente.cerrar_pedido(r.id, 'cancelado', 'humano', 'entrega:cancelado');
    if (v_res->>'ok')::boolean and not coalesce((v_res->>'ya')::boolean, false) then
      v_out := v_out || E'\n🚫 #E' || r.id || ' cancelado. Sale del seguimiento.';
    elsif v_res->>'error' = 'en_erp' then
      v_out := v_out || E'\n⚠️ #E' || r.id || ' ya esta en el ERP: no lo cancele aqui; si la venta no fue, anulala en el ERP.';
    end if;
  end loop;
  for r in select p.id, p.estado, (select count(*) from agente.pedido_eventos e where e.pedido_id = p.id and e.nota = 'pregunta_entrega') n
             from agente.pedidos p where p.id = any(v_no) loop
    insert into agente.pedido_eventos (pedido_id, de, a, por, nota) values (r.id, r.estado, r.estado, 'humano', 'entrega:no');
    v_out := v_out || E'\n⏳ #E' || r.id || ' sigue abierto. ' ||
             case when r.n < 2 then 'Te lo pregunto una vez mas mañana a las 21:30.' else 'Ya no te lo pregunto; sale en el resumen del domingo.' end;
  end loop;
  return nullif(ltrim(v_out, E'\n'), '');
end $function$;

create unique index if not exists ux_decisiones_copy_nuevo on agente.decisiones ((detalle->>'pedido'), (detalle->>'base')) where tipo = 'copy_envio' and detalle->>'via' = 'copy_nuevo';

commit;
