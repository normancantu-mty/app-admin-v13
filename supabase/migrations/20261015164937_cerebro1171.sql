-- migracion_cerebro1171.sql -- cerebro 1.17.1: ningun aviso de "una sola vez" se pierde (transactional outbox sobre pg_net).
-- Escrito el 2026-10-15 por el ejecutor del Socio (encargo DESDE_SOCIO_prompt_ejecutor_cerebro_1.17.1_avisos_sin_perdida_2026-10-15.md).
-- NO APLICADO. Probado en Postgres 16 local (cerebro/probar_1171_pg.test.ts) con la agente.avisar_grupo VIVA y el net.http_post
-- de pg_net 0.19.5 (definicion viva, cola en tabla: lo encolado vive o muere con la transaccion).
--
-- El hueco (1.17.0): vigiaErp reclamaba (insert erp_alertas ... on conflict do nothing) y DESPUES, en otra sentencia, avisaba.
-- Si la funcion moria entre las dos, el aviso de "una sola vez" no salia nunca. El cierre nocturno igual (candado, luego paginas).
-- Y nadie miraba la respuesta de Telegram (pg_net es asincrono): un 400/timeout = aviso perdido en silencio.
--
-- Lo nuevo:
-- (1) ATOMICO: agente.erp_alerta_avisar() y agente.cierre_enviar() reclaman, encolan en pg_net (agente.avisar_grupo) y guardan el
--     request_id en UNA sentencia (una funcion = una transaccion): o quedan reclamo + cola, o ninguno.
-- (2) ENTREGA VERIFICADA: agente.avisos_verificar() (la llama el cerebro cada 5 min, ANTES de buscar faltantes nuevos):
--       respuesta 200 con "ok":true                  -> confirmada_en = now() (y ya no se vuelve a mirar: la purga de pg_net no le pega)
--       respuesta distinta, o sin respuesta tras 10 min -> reenvia (misma funcion atomica), intentos + 1
--       al 3er envio fallido                          -> UN aviso al privado de Norman (agente.avisar) y abandonada_en; no mas reintentos
--     Cada fila en su propio subbloque (savepoint): una que truene no deshace las demas. FOR UPDATE SKIP LOCKED: dos corridas
--     simultaneas no reenvian la misma fila.
--     pg_net.ttl medido el 2026-10-15 por SELECT = '6 hours'. El verificador corre cada 5 min a toda hora: una respuesta se ve mucho
--     antes de purgarse. Si de todos modos se purgo sin verse (funcion caida > 6 h) se reenvia SIN contar intento fallido
--     (ronda 2; ultimo_error = 'purgada: ...'): at-least-once, nunca at-most-once. Lo que sigue en net.http_request_queue no es
--     fallo (ronda 2): se espera.
-- Guarda: ABORTA si avisar_grupo no es la viva (md5 b3dceae2...), si falta agente.avisar, net.http_post o net._http_response, o si la
-- 1.17.0 no esta (erp_alertas / cierre_nocturno, preguntar_entregas=519e0921..., resumen_dia=cbfada1f...).
-- No toca ninguna funcion existente (preguntar_entregas / resumen_dia / avisar_grupo / avisar quedan con su md5).
-- Comprobar despues:
--   select agente.avisos_verificar(false);   -- {"confirmadas":0,...} sobre tablas vacias

begin;

do $g$
declare
  vag text := (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'agente' and p.proname = 'avisar_grupo'
                  and pg_get_function_identity_arguments(p.oid) = 'p_texto text, p_botones jsonb, p_foto text, p_destino text');
  vp text := (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'agente' and p.proname = 'preguntar_entregas'
                 and pg_get_function_identity_arguments(p.oid) = 'p_prueba boolean, p_enviar boolean');
  vr text := (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'agente' and p.proname = 'resumen_dia'
                 and pg_get_function_identity_arguments(p.oid) = 'p_forzar boolean');
begin
  if vag is null then raise exception 'agente.avisar_grupo(text, jsonb, text, text) NO EXISTE: ALTO'; end if;
  if vag <> 'b3dceae20c7fb2780d4817625b499750' then
    raise exception 'avisar_grupo viva distinta a la leida el 2026-10-15 (md5 %): ALTO', vag;
  end if;
  if to_regprocedure('agente.avisar(text,jsonb,text)') is null then raise exception 'agente.avisar NO EXISTE: ALTO'; end if;
  if to_regclass('net._http_response') is null or to_regclass('net.http_request_queue') is null then
    raise exception 'pg_net sin net._http_response / net.http_request_queue: ALTO';
  end if;
  if vp is distinct from '519e0921e944e7b03dc0675b1674123e' or vr is distinct from 'cbfada1f26ec3eaadc201cb1fa05535b' then
    raise exception 'la 1.17.0 no esta aplicada (preguntar_entregas %, resumen_dia %): ALTO', vp, vr;
  end if;
  if to_regclass('agente.erp_alertas') is null or to_regclass('agente.cierre_nocturno') is null then
    raise exception 'faltan agente.erp_alertas / agente.cierre_nocturno (1.17.0): ALTO';
  end if;
end $g$;

-- (2) columnas de entrega en erp_alertas. Filas viejas (texto null) no las toca el verificador.
alter table agente.erp_alertas
  add column if not exists texto text,
  add column if not exists request_id bigint,
  add column if not exists intentos int not null default 0,
  add column if not exists enviado_en timestamptz,
  add column if not exists confirmada_en timestamptz,
  add column if not exists abandonada_en timestamptz,
  add column if not exists ultimo_error text;

-- las paginas del cierre nocturno, una fila por mensaje (mismas columnas de entrega)
create table if not exists agente.cierre_paginas (
  fecha date not null,
  prueba boolean not null,
  n int not null,
  texto text not null,
  botones jsonb,
  request_id bigint,
  intentos int not null default 1,
  enviado_en timestamptz not null default now(),
  confirmada_en timestamptz,
  abandonada_en timestamptz,
  ultimo_error text,
  primary key (fecha, prueba, n)
);
alter table agente.cierre_paginas enable row level security;

-- el mismo criterio que avisar_grupo para "esto no sale a un grupo real" (la funcion devuelve null sin encolar nada)
CREATE OR REPLACE FUNCTION agente.aviso_no_sale(p_texto text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select coalesce(p_texto ~* '^\s*\[prueba\]' or p_texto ~* '\mid prueba_', false)
$function$;

-- estado de un envio por pg_net: ok | espera (aun en net.http_request_queue, o < 10 min) | purgada (sin respuesta y mas viejo que
-- pg_net.ttl: no se sabe; no cuenta como fallo) | sin_respuesta | fallo:<detalle>
CREATE OR REPLACE FUNCTION agente.entrega_telegram(p_req bigint, p_enviado timestamptz, p_espera interval DEFAULT '10 minutes')
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'agente', 'net', 'public'
AS $function$
declare r record;
begin
  if p_req is null then
    return case when p_enviado > now() - p_espera then 'espera' else 'fallo:sin request_id' end;
  end if;
  select status_code, timed_out, error_msg, content into r from net._http_response where id = p_req;
  if not found then
    -- ronda 2: sigue en la cola de pg_net (el worker aun no lo manda) -> no es fallo: se espera, sin reenvio ni intento
    if exists (select 1 from net.http_request_queue q where q.id = p_req) then return 'espera'; end if;
    if p_enviado > now() - p_espera then return 'espera'; end if;
    -- ronda 2: mas viejo que el ttl de pg_net -> la respuesta pudo existir y purgarse sin verse: no es fallo de Telegram
    if p_enviado < now() - coalesce(nullif(current_setting('pg_net.ttl', true), '')::interval, interval '6 hours') then
      return 'purgada';
    end if;
    return 'sin_respuesta';
  end if;
  if r.status_code = 200 and coalesce(r.content, '') ~ '"ok"\s*:\s*true' then return 'ok'; end if;
  return 'fallo:' || coalesce(r.status_code::text, case when r.timed_out then 'timeout' else '?' end) || ' ' ||
         left(coalesce(r.error_msg, r.content, ''), 150);
end $function$;

-- (1) vigia ERP: reclamo + cola + request_id, atomico. {nuevo:false} = otro ya lo reclamo (no se manda nada).
CREATE OR REPLACE FUNCTION agente.erp_alerta_avisar(p_pedido bigint, p_motivo text, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v bigint; v_req bigint;
begin
  insert into agente.erp_alertas (pedido_id, motivo, texto, intentos, enviado_en)
  values (p_pedido, p_motivo, p_texto, 1, now())
  on conflict do nothing returning pedido_id into v;
  if v is null then return jsonb_build_object('nuevo', false); end if;
  v_req := agente.avisar_grupo(p_texto, null, null, 'principal');
  update agente.erp_alertas
     set request_id = v_req,
         confirmada_en = case when v_req is null and agente.aviso_no_sale(p_texto) then now() end
   where pedido_id = p_pedido;
  return jsonb_build_object('nuevo', true, 'request_id', v_req);
end $function$;

-- (1) cierre nocturno: candado del dia + TODAS las paginas encoladas + request_ids, atomico. {ya:true} = ya salio hoy.
-- p_paginas = [{"texto": "...", "botones": [[...]] | null}, ...]
CREATE OR REPLACE FUNCTION agente.cierre_enviar(p_fecha date, p_prueba boolean, p_paginas jsonb, p_pedidos bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v date; pg record; v_req bigint; v_bot jsonb; v_reqs bigint[] := '{}'; v_n int := 0;
begin
  if jsonb_typeof(p_paginas) is distinct from 'array' or jsonb_array_length(p_paginas) = 0 then
    raise exception 'cierre_enviar: sin paginas';
  end if;
  insert into agente.cierre_nocturno (fecha, prueba) values (p_fecha, p_prueba)
  on conflict do nothing returning fecha into v;
  if v is null then return jsonb_build_object('ya', true); end if;
  for pg in select e.value as p, e.ordinality::int as n from jsonb_array_elements(p_paginas) with ordinality e loop
    -- un "botones": null de JSON NO es NULL de SQL: avisar_grupo mandaria inline_keyboard:null (Telegram 400)
    v_bot := case when jsonb_typeof(pg.p->'botones') = 'array' then pg.p->'botones' end;
    v_req := agente.avisar_grupo(pg.p->>'texto', v_bot, null, 'principal');
    insert into agente.cierre_paginas (fecha, prueba, n, texto, botones, request_id, confirmada_en)
    values (p_fecha, p_prueba, pg.n, pg.p->>'texto', v_bot, v_req,
            case when v_req is null and agente.aviso_no_sale(pg.p->>'texto') then now() end);
    v_reqs := v_reqs || v_req;
    v_n := v_n + 1;
  end loop;
  update agente.cierre_nocturno set mensajes = v_n, pedidos = p_pedidos where fecha = p_fecha and prueba = p_prueba;
  return jsonb_build_object('ok', true, 'mensajes', v_n, 'request_ids', to_jsonb(v_reqs));
end $function$;

-- (2) el verificador. p_reenviar = false: solo confirma (de noche no se reenvia al grupo; se confirma igual, antes de la purga).
CREATE OR REPLACE FUNCTION agente.avisos_verificar(p_reenviar boolean DEFAULT true, p_espera interval DEFAULT '10 minutes',
  p_max_intentos int DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare k record; r record; st text; v_req bigint;
        n_ok int := 0; n_re int := 0; n_ab int := 0; n_es int := 0; n_err int := 0; n_pu int := 0;
begin
  -- ---- avisos del ERP ----
  for k in select pedido_id from agente.erp_alertas
            where confirmada_en is null and abandonada_en is null and texto is not null order by pedido_id loop
    begin
      select * into r from agente.erp_alertas
       where pedido_id = k.pedido_id and confirmada_en is null and abandonada_en is null
       for update skip locked;
      if not found then continue; end if;
      st := agente.entrega_telegram(r.request_id, r.enviado_en, p_espera);
      if st = 'ok' then
        update agente.erp_alertas set confirmada_en = now() where pedido_id = r.pedido_id; n_ok := n_ok + 1;
      elsif st = 'espera' then
        n_es := n_es + 1;
      elsif st = 'purgada' then
        -- ronda 2: purga del ttl sin verse (la funcion estuvo caida): se reenvia SIN contar intento fallido
        if p_reenviar then
          v_req := agente.avisar_grupo(r.texto, null, null, 'principal');
          update agente.erp_alertas set request_id = v_req, enviado_en = now(), ultimo_error = 'purgada: reenvio sin contar intento'
           where pedido_id = r.pedido_id;
          n_re := n_re + 1; n_pu := n_pu + 1;
        end if;
      elsif r.intentos >= p_max_intentos then
        perform agente.avisar('⚠️ Un aviso al grupo NO llego tras ' || r.intentos || ' intentos (' || st || '). Ya no se reintenta.' ||
                              E'\n\n' || r.texto, null, null);
        update agente.erp_alertas set abandonada_en = now(), ultimo_error = left(st, 300) where pedido_id = r.pedido_id;
        n_ab := n_ab + 1;
      elsif p_reenviar then
        v_req := agente.avisar_grupo(r.texto, null, null, 'principal');
        update agente.erp_alertas set request_id = v_req, intentos = intentos + 1, enviado_en = now(), ultimo_error = left(st, 300)
         where pedido_id = r.pedido_id;
        n_re := n_re + 1;
      end if;
    exception when others then
      n_err := n_err + 1;
      raise warning 'avisos_verificar erp %: %', k.pedido_id, sqlerrm;
    end;
  end loop;
  -- ---- paginas del cierre nocturno ----
  for k in select fecha, prueba, n from agente.cierre_paginas
            where confirmada_en is null and abandonada_en is null order by fecha, prueba, n loop
    begin
      select * into r from agente.cierre_paginas
       where fecha = k.fecha and prueba = k.prueba and n = k.n and confirmada_en is null and abandonada_en is null
       for update skip locked;
      if not found then continue; end if;
      st := agente.entrega_telegram(r.request_id, r.enviado_en, p_espera);
      if st = 'ok' then
        update agente.cierre_paginas set confirmada_en = now() where fecha = r.fecha and prueba = r.prueba and n = r.n;
        n_ok := n_ok + 1;
      elsif st = 'espera' then
        n_es := n_es + 1;
      elsif st = 'purgada' then
        if p_reenviar then
          v_req := agente.avisar_grupo(r.texto, r.botones, null, 'principal');
          update agente.cierre_paginas set request_id = v_req, enviado_en = now(), ultimo_error = 'purgada: reenvio sin contar intento'
           where fecha = r.fecha and prueba = r.prueba and n = r.n;
          n_re := n_re + 1; n_pu := n_pu + 1;
        end if;
      elsif r.intentos >= p_max_intentos then
        perform agente.avisar('⚠️ El cierre nocturno (pagina ' || r.n || ') NO llego al grupo tras ' || r.intentos || ' intentos (' || st ||
                              '). Ya no se reintenta.' || E'\n\n' || r.texto, null, null);
        update agente.cierre_paginas set abandonada_en = now(), ultimo_error = left(st, 300)
         where fecha = r.fecha and prueba = r.prueba and n = r.n;
        n_ab := n_ab + 1;
      elsif p_reenviar then
        v_req := agente.avisar_grupo(r.texto, r.botones, null, 'principal');
        update agente.cierre_paginas set request_id = v_req, intentos = intentos + 1, enviado_en = now(), ultimo_error = left(st, 300)
         where fecha = r.fecha and prueba = r.prueba and n = r.n;
        n_re := n_re + 1;
      end if;
    exception when others then
      n_err := n_err + 1;
      raise warning 'avisos_verificar cierre % %: %', k.fecha, k.n, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('confirmadas', n_ok, 'reenviadas', n_re, 'abandonadas', n_ab, 'en_espera', n_es, 'errores', n_err, 'purgadas', n_pu);
end $function$;

commit;
