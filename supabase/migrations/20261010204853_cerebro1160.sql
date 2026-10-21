-- migracion_cerebro1160.sql -- cerebro 1.16.0 "asuntos con estado". Escrito el 2026-10-10 por el ejecutor del Socio.
-- NO APLICADO. Se aplica ANTES de desplegar la v66 del cerebro y telegram-entrada 1.16.0 (las dos lo usan). La v65 viva
-- sigue funcionando sobre esta base (no lee nada que cambie de forma incompatible).
--   A  agente.cerrar_pedido(id, estado, por, motivo): la UNICA via a entregado/cancelado; cierra las preguntas ligadas.
--      responder_entregas la usa; caducar_pausas y asuntos_abiertos callan las pausas de un asunto terminado
--      (agente.pedido_terminado: el pedido LIGADO a la pregunta). preguntar_entregas, entregas_pendientes, insistir_datos ya filtraban pedido/pagado.
--   B  preguntar_entregas manda un boton callback por pedido (ent:<id>); avisar_grupo quita los botones callback si cae
--      al privado de Norman.
--   C  agente.deshacer_cancelacion(id, por): el boton "No, sigue vivo" (solo deshace lo que cancelo LucIA).
--   D  aplicar_datos ya no escribe total (lo escribe recotizar/cotizar en el cerebro).
--   E  agente.pedidos.entrega_fecha date; aplicar_datos la escribe (AAAA-MM-DD validada).
--   H  agente.envio_candado + agente.reclamar_envio(): candado de doble respuesta por contacto, por lote (sin ventana);
--      al turno que se le niega el cerebro lo re-corre una vez (nunca se descarta en silencio).
--   +  marcar_comprobante: un pago sobre un pedido cancelado/desaparecio/no_prospecto lo revive a pagado y avisa a Norman.
--   E  + nota_repartidor y total_acordado (aplicar_datos los escribe).
--   I  avisar_grupo no manda nada marcado [PRUEBA] / "id prueba_" (deja la fila aviso_grupo con no_enviado); regla #36 off.
--   J  #227 -> cancelado; #222 total_cobrado 593 -> 662.
-- Guarda: si una funcion viva no es la que se volco el 2026-10-10 (md5), la migracion entera se cae y no cambia nada.
-- Mapeo de estados: no se renombra nada. entregado y cancelado ya existian en el CHECK; desaparecio y no_prospecto
-- (viejos) cuentan como terminales para cerrar_pedido (ya=true) y no se tocan.
-- Deshacer: sql/migracion_cerebro1160_DESHACER.sql

do $do$
declare r record; v text;
begin
  for r in select * from (values
    ('agente.responder_entregas(text,text,boolean)', '891b2359feeec9b0f35da962994d5b28', '0cd530d745980f2b548c4d94b0e7e9a0'),
    ('agente.preguntar_entregas(boolean,boolean)', '01022123d290ba6b7fc296405a08163f', '6d6be252d14dde305ed978508d97b7e4'),
    ('agente.caducar_pausas(boolean)', '5e6f96c4968423eecf2bcb436794e648', 'ed0052973d41c1f4c2319bf56ad588f2'),
    ('agente.asuntos_abiertos(integer)', '04a3d8abc9124bccc22e5010540a71aa', '28ef95c0fe28e853ca5506355ac74743'),
    ('agente.aplicar_datos(text,bigint,text,jsonb,jsonb,uuid)', '74b4969fbe160cbadcff7d8fd7b09a24', '967fa791cfea1352b01e198eb0412fb5'),
    ('agente.avisar_grupo(text,jsonb,text,text)', '108aac86f65600243c521f642bc6a409', '7c652a42c4de426ef849142cc46a3a3d'),
    ('agente.marcar_comprobante(bigint,text,text)', 'e883ac21a08407a639153f5107543529', '642c958ebdc40def5c9dd7dc128a176b')
  ) t(f, h1, h2) loop
    v := md5(pg_get_functiondef(r.f::regprocedure));
    if v <> r.h1 and v <> r.h2 then raise exception 'la funcion viva % no es la volcada el 2026-10-10 (md5 %)', r.f, v; end if;
  end loop;
end $do$;

-- E (ronda 2): la nota para el repartidor y el total que el cliente acepto (lo compara el copy contra cotizar) -----------
alter table agente.pedidos add column if not exists nota_repartidor text;
alter table agente.pedidos add column if not exists total_acordado numeric;
comment on column agente.pedidos.nota_repartidor is '1.16.0 E: nota util para el repartidor que dijo el cliente. La escribe aplicar_datos; el copy la lleva.';
comment on column agente.pedidos.total_acordado is '1.16.0 E: el ultimo total que LucIA dio y el cliente acepto. Solo se COMPARA con cotizar (si difiere, el copy lo marca); nunca se cobra de aqui.';
-- A (ronda 2): cada pregunta abierta queda ligada al pedido vivo de su cliente al nacer; cerrar_pedido cierra SOLO las ligadas --
alter table agente.preguntas_abiertas add column if not exists pedido_id bigint references agente.pedidos(id);
comment on column agente.preguntas_abiertas.pedido_id is '1.16.0 A: el pedido vivo del cliente cuando nacio la pregunta (trigger). null = no ligada: cerrar_pedido no la toca.';
create or replace function agente.ligar_pregunta_pedido()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
begin
  if new.pedido_id is null then
    select p.id into new.pedido_id from agente.pedidos p
     where p.contacto_id = new.contacto_id and p.estado not in ('entregado', 'cancelado', 'desaparecio', 'no_prospecto')
     order by p.id desc limit 1;
  end if;
  return new;
end $function$;
drop trigger if exists ligar_pedido on agente.preguntas_abiertas;
create trigger ligar_pedido before insert on agente.preguntas_abiertas
  for each row execute function agente.ligar_pregunta_pedido();

-- A: la columna de la fecha de entrega (E) -----------------------------------------------------------------------------
alter table agente.pedidos add column if not exists entrega_fecha date;
comment on column agente.pedidos.entrega_fecha is '1.16.0 E: dia de entrega acordado (hora MX). Lo escribe aplicar_datos desde el turno; el copy lo lee.';

-- A: cerrar_pedido, la UNICA via a un estado terminal -------------------------------------------------------------------
create or replace function agente.cerrar_pedido(p_id bigint, p_estado text, p_por text, p_motivo text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
-- 1.16.0 A. Terminales: entregado (= pagado, decision de Norman) y cancelado. Idempotente: si el pedido ya es terminal
-- (incluye los viejos desaparecio / no_prospecto) no toca nada y contesta ya=true. p_por: 'lucia' (detector de cancelacion),
-- 'humano' (Norman), 'cerebro', 'sistema'. pedido_eventos.por solo admite cerebro|humano|sistema: lucia se guarda como
-- por='cerebro' con nota 'lucia: <motivo>' (asi deshacer_cancelacion sabe que la cancelacion fue de LucIA).
declare v_p agente.pedidos; v_por text; v_nota text; v_erp text; v_preg bigint[];
begin
  if p_estado not in ('entregado', 'cancelado') then
    return jsonb_build_object('ok', false, 'error', 'estado_no_terminal');
  end if;
  select * into v_p from agente.pedidos where id = p_id for update;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'no_existe'); end if;
  if v_p.estado in ('entregado', 'cancelado', 'desaparecio', 'no_prospecto') then
    return jsonb_build_object('ok', true, 'ya', true, 'estado', v_p.estado, 'pedido', p_id);
  end if;
  select estado into v_erp from agente.ventas_erp where pedido_id = p_id;
  if p_estado = 'cancelado' and v_erp in ('registrada', 'registrando') then
    return jsonb_build_object('ok', false, 'error', 'en_erp', 'erp', v_erp);
  end if;
  v_por := case when p_por = 'lucia' then 'cerebro' when p_por in ('cerebro', 'humano', 'sistema') then p_por else 'humano' end;
  v_nota := left(case when p_por = 'lucia' then 'lucia: ' || coalesce(p_motivo, '') else coalesce(p_motivo, p_por) end, 500);
  update agente.pedidos set estado = p_estado, actualizado_en = now() where id = p_id;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota) values (p_id, v_p.estado, p_estado, v_por, v_nota);
  if p_estado = 'cancelado' and v_erp is not null then
    update agente.ventas_erp set estado = 'cancelada', actualizado_en = now() where pedido_id = p_id;
  end if;
  -- las preguntas LIGADAS a este pedido (pedido_id) se cierran con el; las no ligadas quedan abiertas; una que Norman tomo
  -- no la cierra LucIA.
  with c as (update agente.preguntas_abiertas q set estado = 'cerrada', cerrada_en = now(), cerrada_por = 'pedido_' || p_estado
              where q.pedido_id = p_id and q.estado = 'abierta'
                and not (p_por = 'lucia' and coalesce(q.tomada_por, '') = 'norman')
              returning q.id)
  select coalesce(array_agg(id order by id), '{}'::bigint[]) into v_preg from c;
  insert into agente.decisiones (tipo, detalle)
  values ('cerrar_pedido', jsonb_build_object('pedido', p_id, 'de', v_p.estado, 'estado', p_estado, 'por', p_por,
          'motivo', left(coalesce(p_motivo, ''), 300), 'preguntas', to_jsonb(v_preg), 'erp_antes', v_erp));
  return jsonb_build_object('ok', true, 'ya', false, 'estado', p_estado, 'de', v_p.estado, 'pedido', p_id, 'preguntas', to_jsonb(v_preg));
end $function$;

-- C: el boton de deshacer de una cancelacion detectada por LucIA ---------------------------------------------------------
create or replace function agente.deshacer_cancelacion(p_id bigint, p_por text default 'humano')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
-- 1.16.0 C. Solo deshace lo que cancelo LucIA (ultimo evento a='cancelado' con nota 'lucia:%'). Regresa el estado de antes,
-- la venta_erp y las preguntas que cerrar_pedido cerro. Idempotente: un pedido que ya no esta cancelado contesta ya=true.
declare v_p agente.pedidos; v_ev agente.pedido_eventos; v_dec jsonb;
begin
  select * into v_p from agente.pedidos where id = p_id for update;
  if v_p.id is null then return jsonb_build_object('ok', false, 'error', 'no_existe'); end if;
  if v_p.estado <> 'cancelado' then
    return jsonb_build_object('ok', false, 'ya', true, 'error', 'no_cancelado', 'estado', v_p.estado);
  end if;
  select * into v_ev from agente.pedido_eventos where pedido_id = p_id and a = 'cancelado' order by id desc limit 1;
  if v_ev.id is null or coalesce(v_ev.nota, '') not like 'lucia:%' or v_ev.de is null then
    return jsonb_build_object('ok', false, 'error', 'no_lo_cancelo_lucia');
  end if;
  begin
    update agente.pedidos set estado = v_ev.de, actualizado_en = now() where id = p_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'otro_vivo');
  end;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
  values (p_id, 'cancelado', v_ev.de, case when p_por in ('cerebro', 'humano', 'sistema') then p_por else 'humano' end, 'deshacer_cancelacion');
  select d.detalle into v_dec from agente.decisiones d
   where d.tipo = 'cerrar_pedido' and d.detalle->>'pedido' = p_id::text and d.detalle->>'estado' = 'cancelado'
   order by d.id desc limit 1;
  if v_dec->>'erp_antes' is not null then
    update agente.ventas_erp set estado = v_dec->>'erp_antes', actualizado_en = now() where pedido_id = p_id and estado = 'cancelada';
  end if;
  begin
    update agente.preguntas_abiertas set estado = 'abierta', cerrada_en = null, cerrada_por = null
     where id in (select jsonb_array_elements_text(coalesce(v_dec->'preguntas', '[]'::jsonb))::bigint)
       and estado = 'cerrada' and cerrada_por = 'pedido_cancelado';
  exception when unique_violation then null;
  end;
  insert into agente.decisiones (tipo, detalle)
  values ('deshacer_cancelacion', jsonb_build_object('pedido', p_id, 'a', v_ev.de, 'por', p_por));
  return jsonb_build_object('ok', true, 'estado', v_ev.de, 'pedido', p_id);
end $function$;

-- A: ¿termino el pedido al que esta ligada la pregunta? (pausas de un pedido cerrado = silencio; las no ligadas, no) --------
create or replace function agente.pedido_terminado(p_pedido bigint)
 returns boolean
 language sql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
  select p_pedido is not null and exists (select 1 from agente.pedidos p where p.id = p_pedido and p.estado in ('entregado', 'cancelado'));
$function$;

-- H: candado de envio por contacto -----------------------------------------------------------------------------------------
create table if not exists agente.envio_candado (
  contacto_id text primary key,
  turno text not null,
  enviado_en timestamptz not null default now(),
  desde timestamptz not null,
  cubre_hasta bigint
);
alter table agente.envio_candado enable row level security;
comment on table agente.envio_candado is '1.16.0 H: el ultimo turno que le envio a cada contacto (y el entrante mas nuevo de su lote). Lo reclama agente.reclamar_envio.';

create or replace function agente.reclamar_envio(p_contacto text, p_turno text, p_desde timestamptz, p_lote bigint default null)
 returns boolean
 language sql
 security definer
 set search_path to 'agente', 'public'
as $function$
  -- 1.16.0 H (ronda 2): candado por LOTE, sin ventana de tiempo. true = este turno puede enviar: nadie le ha enviado, el
  -- ultimo envio fue de este mismo turno, o salio ANTES de que este turno leyera su lote (p_desde: ese envio ya esta en su
  -- contexto). false = otro turno le envio al cliente sin que este lo viera: el cerebro NO lo descarta, lo re-corre una vez
  -- con esa respuesta en el historial. cubre_hasta = el entrante mas nuevo del lote del que envio (auditoria). Atomico.
  with r as (
    insert into agente.envio_candado as c (contacto_id, turno, enviado_en, desde, cubre_hasta)
    values (p_contacto, p_turno, now(), p_desde, p_lote)
    on conflict (contacto_id) do update set turno = excluded.turno, enviado_en = excluded.enviado_en, desde = excluded.desde,
                                            cubre_hasta = coalesce(excluded.cubre_hasta, c.cubre_hasta)
     where c.turno = excluded.turno or c.enviado_en < excluded.desde
    returning 1)
  select exists (select 1 from r);
$function$;

revoke all on function agente.cerrar_pedido(bigint, text, text, text) from public, anon, authenticated;
revoke all on function agente.deshacer_cancelacion(bigint, text) from public, anon, authenticated;
revoke all on function agente.pedido_terminado(bigint) from public, anon, authenticated;
revoke all on function agente.ligar_pregunta_pedido() from public, anon, authenticated;
revoke all on function agente.reclamar_envio(text, text, timestamptz, bigint) from public, anon, authenticated;

-- funciones vivas modificadas (definicion completa; el DESHACER repone la volcada) -----------------------------------

CREATE OR REPLACE FUNCTION agente.responder_entregas(p_texto text, p_responde_a text, p_prueba boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  t text := translate(lower(coalesce(p_texto, '')), 'áéíóúü', 'aeiouu');
  ra text := coalesce(p_responde_a, '');
  v_reply boolean := ra ~ '¿Se entregaron\?|¿Hablas de #E';
  v_reciente boolean;
  v_pend bigint[]; v_ctx bigint[]; v_obj bigint[]; v_si bigint[] := '{}'; v_no bigint[] := '{}'; v_can bigint[] := '{}';
  m text[]; r record; v_out text := ''; v_primero text; v_res jsonb;
begin
  select array_agg(e.pedido_id order by e.pedido_id) into v_pend
    from agente.entregas_pendientes(p_prueba) e where e.preguntas >= 1;  -- Va2 (k): sin ventana de 8 dias
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
      if v_reply or t ~ '^\s*entregad'
         or (v_reciente and array_length(regexp_split_to_array(trim(t), '\s+'), 1) <= 4) then
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
      -- Va2 (k): pendiente pero aun no preguntado: no se dice "no esta pendiente"
      if exists (select 1 from agente.entregas_pendientes(p_prueba) e2 where e2.pedido_id = m[1]::bigint) then
        return null;
      end if;
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

CREATE OR REPLACE FUNCTION agente.preguntar_entregas(p_prueba boolean DEFAULT false, p_enviar boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
        v_ids bigint[]; v_txt text; v_a text; v_b text; v_bot jsonb;
begin
  select array_agg(e.pedido_id order by e.pedido_id),
         string_agg(e.renglon, ' · ' order by e.pedido_id)
    into v_ids, v_txt
    from agente.entregas_pendientes(p_prueba) e
   -- Va2 (l): sin respuesta tambien se vuelve a preguntar al dia siguiente. Maximo 2 preguntas; nunca una 3a.
   where e.preguntas = 0 or (e.preguntas = 1 and e.ultima < v_hoy);
  if v_ids is null then return null; end if;
  v_a := '#E' || v_ids[1];
  v_b := '#E' || v_ids[array_length(v_ids, 1)];
  v_txt := case when p_prueba then '[PRUEBA] ' else '' end || '📦 ¿Se entregaron? ' || v_txt || E'\nContesta: todos · ' ||
           v_a || ' si' || case when v_b <> v_a then ' · ' || v_b || ' no · cancelado ' || v_b
                                else ' · ' || v_a || ' no · cancelado ' || v_a end;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
  select p.id, p.estado, p.estado, 'cerebro', 'pregunta_entrega' from agente.pedidos p where p.id = any(v_ids);
  -- 1.16.0 B: un boton por pedido (los primeros 20); el texto libre sigue valiendo igual.
  select jsonb_agg(jsonb_build_array(jsonb_build_object('text', '✅ #E' || x || ' entregado y pagado', 'callback_data', 'ent:' || x))
                   order by x) into v_bot from unnest(v_ids[1:20]) x;
  if p_enviar then perform agente.avisar_grupo(v_txt, v_bot, null, 'principal'); end if;
  return v_txt;
end $function$;

CREATE OR REPLACE FUNCTION agente.caducar_pausas(p_seco boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  r record; v_real text := ''; v_prueba text := ''; n_c int := 0; n_r int := 0; n_t int := 0; v_avisos jsonb := '[]'::jsonb; v_txt text;
begin
  if not p_seco and not pg_try_advisory_xact_lock(115112) then return jsonb_build_object('ocupado', true); end if;
  -- 0. 1.16.0 A: una pausa (no tomada por Norman) cuyo asunto ya termino -su pedido quedo entregado/cancelado despues de
  --    abrirse- se cierra en silencio. cerrar_pedido ya las cierra; esto cubre las que quedaron de antes.
  for r in select q.id, q.contacto_id from agente.preguntas_abiertas q
            where q.estado = 'abierta' and q.pausa and coalesce(q.tomada_por, '') <> 'norman'
              and agente.pedido_terminado(q.pedido_id)
  loop
    n_t := n_t + 1;
    if not p_seco then
      update agente.preguntas_abiertas set estado = 'cerrada', cerrada_en = now(), cerrada_por = 'pedido_terminado'
       where id = r.id and estado = 'abierta';
      insert into agente.decisiones (tipo, detalle)
      values ('pausa_terminada', jsonb_build_object('pregunta', r.id, 'contacto', r.contacto_id));
    end if;
  end loop;
  -- 1. caducan
  for r in
    select q.id, q.contacto_id, left(coalesce(nullif(trim(k.nombre), ''), q.contacto_id), 30) nombre,
           agente.pedido_terminado(q.pedido_id) terminado
      from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
     where q.estado = 'abierta' and q.pausa and q.tomada_por = 'norman'
       and greatest(q.creado_en, coalesce(q.ultimo_humano_en, q.creado_en), coalesce(q.recordado_hasta, q.creado_en),
             coalesce((select max(m.creado_en) from agente.mensajes m
                        where m.contacto_id = q.contacto_id and m.origen like 'humano:%'), q.creado_en))
           < now() - interval '12 hours'
     order by q.id
  loop
    n_c := n_c + 1;
    if r.terminado then
      null;  -- 1.16.0 A: asunto terminado: caduca sin aviso
    elsif r.contacto_id like 'prueba\_%' then
      v_prueba := v_prueba || case when v_prueba = '' then '' else ', ' end || r.nombre || ' (#P' || r.id || ')';
    else
      v_real := v_real || case when v_real = '' then '' else ', ' end || r.nombre || ' (#P' || r.id || ')';
    end if;
    if not p_seco then
      update agente.preguntas_abiertas set estado = 'cerrada', cerrada_en = now(),
             cerrada_por = case when r.terminado then 'pedido_terminado' else 'caducada_12h' end
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
       and not agente.pedido_terminado(q.pedido_id)  -- 1.16.0 A
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

  return jsonb_build_object('caducadas', n_c, 'recordadas_2h', n_r, 'terminadas', n_t, 'avisos', v_avisos, 'seco', p_seco);
end $function$;

CREATE OR REPLACE FUNCTION agente.asuntos_abiertos(p_sin_resp_min integer)
 RETURNS TABLE(clave text, orden integer, linea text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
  with ult as (
    select distinct on (m.contacto_id) m.contacto_id, m.id, m.direccion, m.origen, m.texto, m.creado_en
      from agente.mensajes m
     where m.creado_en > now() - interval '24 hours'
       and coalesce(m.origen,'') not like 'puente%'
     order by m.contacto_id, m.creado_en desc, m.id desc),
  cita as (
    select q.id,
           (select string_agg('"' || left(regexp_replace(x.texto, '\s+', ' ', 'g'), 90) || '"', ' / ' order by x.id)
              from (select m.id, m.texto from agente.mensajes m
                     where m.contacto_id = q.contacto_id and m.direccion = 'entrante'
                       and coalesce(m.origen,'') like '%:pausa%' and m.creado_en >= q.creado_en
                     order by m.id desc limit 3) x) as ultimos
      from agente.preguntas_abiertas q
     where q.estado = 'abierta' and q.pausa),
  acuse as (
    select '^\s*(ok[a-z]*|okey|okay|va|vale|sale|listo|gracias|muchas gracias|mil gracias|grax|thx|👍|🙏|😊|🙌|👌|❤️)[\s.!¡]*$'::text as rx)
  select 'sinresp:' || u.id, 1,
         '🔴 ' || coalesce(k.nombre, u.contacto_id) || ' (' || coalesce(k.canal,'?') || ') escribio hace ' ||
         (extract(epoch from now() - u.creado_en) / 60)::int || ' min y nadie le contesto: "' ||
         left(regexp_replace(u.texto, '\s+', ' ', 'g'), 90) || '"'
    from ult u join agente.contactos k on k.id = u.contacto_id
   where u.direccion = 'entrante'
     and coalesce(u.origen,'') not like '%callado%' and coalesce(u.origen,'') not like '%pausa%'
     and coalesce(u.origen,'') not like '%rafaga%'
     and u.creado_en < now() - make_interval(mins => p_sin_resp_min)
     and u.contacto_id not like 'prueba\_%'
  union all
  select 'pausa:' || q.id || ':' || q.entrantes_en_pausa, 2,
         '⁉️ #P' || q.id || ' ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') ||
         ') sigue en pausa esperando que me digas si la retomo yo o tu. Lo ultimo que escribio: ' ||
         coalesce(c.ultimos, '"' || left(q.pregunta, 90) || '"')
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
    left join cita c on c.id = q.id
   where q.estado = 'abierta' and q.pausa and q.entrantes_en_pausa > 0
     and coalesce(q.tomada_por, '') <> 'norman'
     and q.creado_en > now() - interval '2 hours'
     and q.contacto_id not like 'prueba\_%'
     and not agente.pedido_terminado(q.pedido_id)
  union all
  select 'pausa2h:' || q.id, 0,
         '🔴 #P' || q.id || ' ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') lleva ' ||
         (extract(epoch from now() - q.creado_en) / 3600)::int || ' h en pausa' ||
         case when q.tomada_por = 'norman' then ' (la tomaste tu)' else '' end || '. ' ||
         case when c.ultimos is not null then 'Lo ultimo que escribio: ' || c.ultimos
              else 'Pregunto: "' || left(q.pregunta, 90) || '"' end
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
    left join cita c on c.id = q.id
   where q.estado = 'abierta' and q.pausa and q.creado_en <= now() - interval '2 hours'
     and q.contacto_id not like 'prueba\_%'
     and not agente.pedido_terminado(q.pedido_id)
  union all
  select 'envio:' || p.id, 2,
         '⁉️ Envio nacional #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || ' (' || coalesce(p.ciudad,'?') ||
         ') espera que me digas si va, desde hace ' || (extract(epoch from now() - p.avisado_cerrado_en) / 3600)::int || ' h'
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where p.estado = 'pagado' and p.envio_decision is null and p.avisado_cerrado_en is not null
     and p.avisado_cerrado_en <= now() - make_interval(mins => (select coalesce(max(c.envio_decidir_min), 60)
                                                                   from agente.cerebro_config c where c.id = 1))
     and p.zona = 'nacional' and p.contacto_id not like 'prueba\_%'
  union all
  select 'vigia:' || v.id, 1,
         '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
         case when now() - v.ultimo_ts < interval '2 hours'
              then (extract(epoch from now() - v.ultimo_ts) / 60)::int || ' min'
              else (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h' end ||
         ' y en la bandeja nadie le contesto (lo vio el vigia, fuera del cerebro): "' || left(coalesce(v.texto,''), 90) || '"'
    from agente.vigia_alertas v, acuse a
   where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
     and coalesce(v.hilo, '') not like 'prueba%'
     and lower(coalesce(v.texto,'')) !~ a.rx
     and not exists (
       select 1 from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
        where q.pausa and (q.estado = 'abierta' or q.tomada_por = 'norman' and q.creado_en > now() - interval '24 hours')
          and ((v.canal = 'whatsapp' and k.telefono_e164 is not null
                and right(regexp_replace(k.telefono_e164, '\D', '', 'g'), 10) = right(regexp_replace(v.hilo, '\D', '', 'g'), 10))
               or (k.nombre is not null and k.nombre = v.quien and k.canal = v.canal)))
  union all
  select 'vigia:' || v.id, 3, '⚠️ El token de la pagina de Facebook caduco: el vigia no ve Messenger ni Instagram.'
    from agente.vigia_alertas v
   where v.canal = 'sistema' and v.hilo = 'token_meta' and v.ultimo_ts > now() - interval '24 hours';
$function$;

CREATE OR REPLACE FUNCTION agente.aplicar_datos(p_contacto text, p_mensaje bigint, p_extractor text, p_campos jsonb, p_pedido jsonb DEFAULT NULL::jsonb, p_conversacion uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  k text; v text; v_conf numeric; n_datos int := 0;
  orden constant text[] := array['contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido'];
  -- Va2 (c): 'pagado' es pedido vivo hasta entregado o cancelado (mismo criterio que uq_pedido_vivo). No entra a
  -- 'orden': el extractor no puede llevar un pedido a pagado ni sacarlo de ahi.
  vivos constant text[] := array['contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido','pagado'];
  v_ped agente.pedidos; v_nuevo_estado text; v_items jsonb; v_evento boolean := false;
begin
  v_conf := case p_extractor when 'regex' then 0.95 when 'modelo' then 0.7 else 1 end;
  for k, v in select key, value from jsonb_each_text(coalesce(p_campos, '{}'::jsonb)) loop
    continue when v is null or btrim(v) = '';
    continue when exists (select 1 from agente.dato_cliente d
                           where d.contacto_id = p_contacto and d.campo = k
                             and d.id = (select max(id) from agente.dato_cliente
                                          where contacto_id = p_contacto and campo = k)
                             and d.valor = v);
    insert into agente.dato_cliente (contacto_id, campo, valor, confianza, fuente_mensaje_id, extractor)
    values (p_contacto, k, v, v_conf, p_mensaje, p_extractor);
    n_datos := n_datos + 1;
  end loop;

  update agente.contactos c set
    telefono_e164 = coalesce(p_campos->>'telefono', c.telefono_e164),
    correo        = coalesce(p_campos->>'correo', c.correo),
    rfc           = coalesce(p_campos->>'rfc', c.rfc),
    cp            = coalesce(p_campos->>'cp', c.cp),
    ciudad        = coalesce(p_campos->>'ciudad', c.ciudad),
    estado_mx     = coalesce(p_campos->>'estado_mx', c.estado_mx),
    tipo_cliente  = coalesce(p_campos->>'tipo_cliente', c.tipo_cliente),
    genero        = coalesce(p_campos->>'genero', c.genero),
    locale        = coalesce(p_campos->>'locale', c.locale),
    origen        = coalesce(c.origen, p_campos->>'origen')
  where c.id = p_contacto;

  if p_pedido is not null and p_pedido <> '{}'::jsonb then
    select * into v_ped from agente.pedidos
     where contacto_id = p_contacto and estado = any (vivos) order by id desc limit 1;
    if v_ped.id is null then
      insert into agente.pedidos (contacto_id, conversacion_id, origen)
      values (p_contacto, p_conversacion, (select origen from agente.contactos where id = p_contacto))
      on conflict do nothing returning * into v_ped;
      if v_ped.id is null then
        select * into v_ped from agente.pedidos where contacto_id = p_contacto and estado = any (vivos) order by id desc limit 1;
      end if;
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, null, v_ped.estado, 'cerebro', p_mensaje);
    end if;

    v_items := case when jsonb_typeof(p_pedido->'items') = 'array' and jsonb_array_length(p_pedido->'items') > 0
                    then p_pedido->'items' else null end;
    v_nuevo_estado := v_ped.estado;
    if p_pedido->>'estado' = any (orden)
       and array_position(orden, p_pedido->>'estado') > array_position(orden, v_ped.estado) then
      v_nuevo_estado := p_pedido->>'estado';
      v_evento := true;
    end if;

    update agente.pedidos p set
      estado          = v_nuevo_estado,
      items           = coalesce(v_items, p.items),
      entrega_fecha   = coalesce(case when p_pedido->>'entrega_fecha' ~ '^\d{4}-\d{2}-\d{2}$'
                                      then (p_pedido->>'entrega_fecha')::date end, p.entrega_fecha),
      nota_repartidor = coalesce(nullif(left(trim(p_pedido->>'nota_repartidor'), 300), ''), p.nota_repartidor),
      total_acordado  = coalesce(case when p_pedido->>'total_acordado' ~ '^\d{1,7}(\.\d{1,2})?$'
                                       and (p_pedido->>'total_acordado')::numeric > 0
                                      then (p_pedido->>'total_acordado')::numeric end, p.total_acordado),
      ciudad          = coalesce(p_pedido->>'ciudad', p.ciudad),
      zona            = coalesce(p_pedido->>'zona', p.zona),
      receptor_nombre = coalesce(p_pedido->>'receptor_nombre', p.receptor_nombre),
      receptor_tel    = coalesce(p_pedido->>'receptor_tel', p.receptor_tel),
      domicilio       = coalesce(p_pedido->>'domicilio', p.domicilio),
      referencias     = coalesce(p_pedido->>'referencias', p.referencias),
      horario         = coalesce(p_pedido->>'horario', p.horario),
      metodo_pago     = coalesce(p_pedido->>'metodo_pago', p.metodo_pago),
      ocasion         = coalesce(p_pedido->>'ocasion', p.ocasion),
      objecion        = coalesce(p_pedido->>'objecion', p.objecion),
      actualizado_en  = now()
    where p.id = v_ped.id;

    if v_evento then
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, v_ped.estado, v_nuevo_estado, 'cerebro', p_mensaje);
    end if;
  end if;

  return jsonb_build_object('datos', n_datos, 'pedido_id', v_ped.id, 'estado', v_nuevo_estado,
                            'de', v_ped.estado, 'cambio', v_evento);
end $function$;

CREATE OR REPLACE FUNCTION agente.avisar_grupo(p_texto text, p_botones jsonb DEFAULT NULL::jsonb, p_foto text DEFAULT NULL::text, p_destino text DEFAULT 'principal'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'net', 'vault', 'public'
AS $function$
declare v_token text; v_chat text; v_body jsonb; v_req bigint; v_metodo text; v_dest text;
begin
  v_dest := case when p_destino in ('principal','envios','pasta') then p_destino else 'principal' end;
  -- 1.16.0 I: nada marcado [PRUEBA] / "id prueba_" sale a un grupo real. Queda la fila aviso_grupo (responder_entregas la lee).
  if p_texto ~* '^\s*\[prueba\]' or p_texto ~* '\mid prueba_' then
    insert into agente.decisiones (tipo, detalle)
    values ('aviso_grupo', jsonb_build_object('request_id', null, 'metodo', 'ninguno', 'destino', v_dest, 'no_enviado', true,
                                              'texto', left(p_texto, 300)));
    return null;
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_mensajeria_token';
  select decrypted_secret into v_chat from vault.decrypted_secrets where name = 'telegram_chat_' || v_dest;
  if v_token is null or v_chat is null then
    -- 1.16.0 B: los botones callback solo los atiende el webhook del bot de mensajeria; al privado van sin ellos.
    return agente.avisar('[sin grupo ' || v_dest || '] ' || p_texto,
                         case when p_botones::text like '%callback_data%' then null else p_botones end, p_foto);
  end if;
  if p_foto is not null then
    v_metodo := 'sendPhoto';
    v_body := jsonb_build_object('chat_id', v_chat, 'photo', p_foto, 'caption', left(p_texto, 1000));
  else
    v_metodo := 'sendMessage';
    v_body := jsonb_build_object('chat_id', v_chat, 'text', left(p_texto, 4000),
                                 'disable_web_page_preview', true);
  end if;
  if p_botones is not null then
    v_body := v_body || jsonb_build_object('reply_markup', jsonb_build_object('inline_keyboard', p_botones));
  end if;
  select net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/' || v_metodo,
    headers := jsonb_build_object('Content-Type','application/json'),
    body := v_body) into v_req;
  insert into agente.decisiones (tipo, detalle)
  values ('aviso_grupo', jsonb_build_object('request_id', v_req, 'metodo', v_metodo, 'destino', v_dest,
                                            'texto', left(p_texto, 300)));
  return v_req;
end $function$;

CREATE OR REPLACE FUNCTION agente.marcar_comprobante(p_id bigint, p_resultado text, p_por text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v_c agente.comprobantes; v_ped agente.pedidos; v_de text; v_ya boolean; v_movio boolean := false;
        v_revive boolean := false; v_marca text;
begin
  if p_resultado not in ('pagado','no') then return 'resultado invalido'; end if;
  select * into v_c from agente.comprobantes where id = p_id for update;
  if v_c.id is null then return 'no existe el comprobante ' || p_id; end if;
  if v_c.resultado is not null then
    return 'ya estaba marcado: ' || v_c.resultado || ' (' || coalesce(v_c.validado_por, '?') || ')';
  end if;
  update agente.comprobantes set resultado = p_resultado, validado_por = p_por, validado_en = now()
   where id = p_id;
  if p_resultado = 'no' then return 'comprobante ' || p_id || ' marcado: NO pagado'; end if;

  select * into v_ped from agente.pedidos where id = v_c.pedido_id;
  if v_ped.id is null then
    -- Va2 (c): 'pagado' cuenta como vivo; un segundo comprobante va al MISMO pedido, no abre otro.
    select * into v_ped from agente.pedidos where contacto_id = v_c.contacto_id
       and estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido','pagado')
     order by id desc limit 1;
  end if;
  if v_ped.id is null then
    -- 1.16.0: sin pedido vivo, el pago REVIVE el ultimo pedido terminal del cliente (30 dias) en vez de abrir uno nuevo.
    select * into v_ped from agente.pedidos where contacto_id = v_c.contacto_id
       and estado in ('cancelado','desaparecio','no_prospecto') and actualizado_en > now() - interval '30 days'
     order by id desc limit 1;
  end if;
  if v_ped.id is null then
    insert into agente.pedidos (contacto_id, estado) values (v_c.contacto_id, 'pedido') returning * into v_ped;
  end if;
  v_de := v_ped.estado;
  v_revive := v_de in ('cancelado','desaparecio','no_prospecto');  -- 1.16.0: el pago revive un pedido terminal
  -- la venta ya se conto si otro comprobante pagado apunta a este pedido
  v_ya := exists (select 1 from agente.comprobantes x where x.pedido_id = v_ped.id and x.resultado = 'pagado' and x.id <> p_id);
  if v_de not in ('pagado', 'entregado') then
    begin
      update agente.pedidos set estado = 'pagado', actualizado_en = now() where id = v_ped.id;
      v_movio := true;
    exception when unique_violation then
      v_movio := false;  -- otro pedido vivo del contacto: el estado no se toca, el pago queda como evento
    end;
  end if;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
  values (v_ped.id, v_de, case when v_movio then 'pagado' else v_de end, 'humano',
          'comprobante ' || p_id || ' via ' || p_por || case when v_ya then ' (otro pago del mismo pedido)' else '' end ||
          case when v_revive and v_movio then ' (revivido: estaba ' || v_de || ')' else '' end);
  update agente.comprobantes set pedido_id = v_ped.id where id = p_id;
  if not v_ya then
    update agente.contactos set n_pedidos = n_pedidos + 1,
           primer_pedido = coalesce(primer_pedido, now()), ultimo_pedido = now(),
           monto_total = monto_total + coalesce(v_ped.total, 0)
     where id = v_c.contacto_id;
  end if;
  -- 1.16.0: el pago que revive un pedido terminal no pasa en silencio: decision + una linea a Norman.
  if v_revive then
    v_marca := case when v_c.contacto_id like 'prueba\_%' then '[PRUEBA] ' else '' end;
    insert into agente.decisiones (tipo, detalle)
    values ('revivido_por_pago', jsonb_build_object('pedido', v_ped.id, 'de', v_de, 'comprobante', p_id, 'por', p_por,
                                                    'revivido', v_movio));
    perform agente.avisar_grupo(v_marca || case when v_movio
      then E'♻️ #E' || v_ped.id || ' estaba ' || v_de || ' y entró un pago: lo reviví (ahora PAGADO, comprobante #C' || p_id || ').'
      else E'⚠️ #E' || v_ped.id || ' estaba ' || v_de || ' y entró un pago, pero el cliente tiene otro pedido vivo: no lo reviví. Revísalo (comprobante #C' || p_id || ').'
      end, null, null, 'principal');
    if v_movio then
      return 'pedido ' || v_ped.id || ' estaba ' || v_de || ' y entró un pago: lo reviví, marcado PAGADO';
    end if;
  end if;
  if v_ya then
    return 'pedido ' || v_ped.id || ' ya estaba PAGADO; comprobante ' || p_id || ' ligado a el (no cuenta otra venta)';
  elsif not v_movio then
    return 'pedido ' || v_ped.id || ' sigue ' || v_de || '; comprobante ' || p_id || ' ligado a el';
  end if;
  return 'pedido ' || v_ped.id || ' marcado PAGADO (antes: ' || v_de || ')';
end $function$;

-- I: la regla viva #36 (basura) se apaga, con nota --------------------------------------------------------------------------
update agente.reglas_vivas set activa = false, apagada_en = now(),
       nota = coalesce(nota || ' | ', '') || 'apagada 1.16.0: basura (diagnostico del Socio, 2026-10-10)'
 where id = 36 and activa;

-- A (ronda 2): las preguntas ABIERTAS de antes se ligan al pedido de su cliente que existia cuando nacieron (el ultimo creado
-- antes); si no habia, al vivo de hoy. Las cerradas no se tocan.
with l as (
  update agente.preguntas_abiertas q set pedido_id = coalesce(
      (select p.id from agente.pedidos p where p.contacto_id = q.contacto_id and p.creado_en <= q.creado_en order by p.id desc limit 1),
      (select p.id from agente.pedidos p where p.contacto_id = q.contacto_id
          and p.estado not in ('entregado', 'cancelado', 'desaparecio', 'no_prospecto') order by p.id desc limit 1))
   where q.estado = 'abierta' and q.pedido_id is null
  returning q.id, q.pedido_id)
insert into agente.decisiones (tipo, detalle)
select 'ligar_preguntas_1160', jsonb_build_object('ligadas', count(*) filter (where pedido_id is not null),
       'sin_pedido', count(*) filter (where pedido_id is null), 'ids', coalesce(jsonb_agg(jsonb_build_array(id, pedido_id)), '[]'::jsonb))
  from l;
-- J: datos (con DESHACER) ------------------------------------------------------------------------------------------------
-- #227 OMR: el cliente cancelo ("En otra ocasión sera", msg 1684); Norman lo confirmo 4 veces. Se cierra COMO LucIA (por
-- 'lucia', nota 'lucia: ...' con la cita textual) para que el boton "No, sigue vivo" (deshacer_cancelacion) funcione.
select agente.cerrar_pedido(227, 'cancelado', 'lucia',
       'cliente: «En otra ocasión sera» (msg 1684); Norman lo confirmo (migracion 1.16.0)');
-- #222 Gabriel: total_cobrado quedo en 593 (escrito una vez antes de que pidiera mas); cotizar da 662 (1x250 + 7x50, local,
-- envio gratis, sin mayoreo). Solo si sigue en 593.
with u as (update agente.pedidos set total_cobrado = 662 where id = 222 and total_cobrado = 593 returning id)
insert into agente.decisiones (tipo, detalle)
select 'recotizar', jsonb_build_object('pedido', 222, 'total', 662, 'cobrado', 662, 'antes_cobrado', 593, 'por', 'migracion 1.16.0')
  from u;
insert into agente.decisiones (tipo, detalle)
values ('migracion_1160', jsonb_build_object(
  'regla36', (select activa from agente.reglas_vivas where id = 36),
  'e227', (select estado from agente.pedidos where id = 227),
  'e222_cobrado', (select total_cobrado from agente.pedidos where id = 222)));
