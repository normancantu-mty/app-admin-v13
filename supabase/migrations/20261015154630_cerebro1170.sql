-- migracion_cerebro1170.sql -- cerebro 1.17.0 (encargo DESDE_SOCIO_prompt_ejecutor_cerebro_1.17.0_decisiones_norman_2026-10-15.md).
-- Escrito el 2026-10-15 por el ejecutor del Socio. NO APLICADO. Probado en Postgres 16 local (cerebro/probar_1170_pg.test.ts).
-- Va ANTES del cerebro 1.17.0 (lo aplica desplegar_cerebro_v1170_2026-10-15.sh). Sin el cerebro 1.17.0 las tablas quedan inertes.
-- (1) agente.turnos_modelo: la cola de turnos que el modelo no contesto (reintento cada 5 min, UNA disculpa a los 10 min).
--     Indice unico parcial: un solo turno vivo por contacto (el segundo mensaje se FUSIONA, no duplica).
-- (3) agente.cierre_nocturno: candado diario del cierre (PK fecha+prueba: dos disparos el mismo dia = un solo envio).
--     agente.cierre_pendientes(p_prueba, p_hoy): TODOS los pedidos por cerrar (sin ventana), entrega hoy o antes o sin fecha,
--     menos los marcados "sigue pendiente" hoy. cerebro_config.cierre_nocturno (default true) = el interruptor: encendido, la
--     pregunta suelta "📦 ¿Se entregaron?" (preguntar_entregas, cron 21:30) deja de salir para los reales; apagado, vuelve.
-- (4) agente.erp_alertas: el vigia del ERP avisa UNA vez por pedido.
-- Ronda 2 (post-auditoria): "sigue pendiente" se guarda en agente.decisiones (tipo cierre_sigue), no en pedido_eventos; y
--     resumen_dia ya no cuenta como "pedido cerrado" un evento con de = a (pregunta_entrega pedido->pedido lo inflaba).
-- (5b) agente.resumen_dia: "dudas escaladas" ya no cuenta las preguntas de comprobante (📷 #C...). El monto ya usaba
--     coalesce(c.monto, c.monto_leido, ...) desde la 1.16.6: no se toca.
-- Guarda: si preguntar_entregas o resumen_dia NO EXISTEN o no son las leidas el 2026-10-15 (md5 de prosrc), ABORTA todo.
-- Comprobar despues:
--   select count(*) from agente.cierre_pendientes(false);
--   select agente.preguntar_entregas(false, false);   -- null (el cierre nocturno la sustituye)

begin;

do $g$
declare
  vp text := (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'agente' and p.proname = 'preguntar_entregas'
                 and pg_get_function_identity_arguments(p.oid) = 'p_prueba boolean, p_enviar boolean');
  vr text := (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'agente' and p.proname = 'resumen_dia'
                 and pg_get_function_identity_arguments(p.oid) = 'p_forzar boolean');
begin
  -- 1.17.0: md5(NULL) ya no pasa (observacion del auditor de la 1.16.9): una funcion que no existe ABORTA.
  if vp is null then raise exception 'agente.preguntar_entregas(boolean, boolean) NO EXISTE: ALTO'; end if;
  if vr is null then raise exception 'agente.resumen_dia(boolean) NO EXISTE: ALTO'; end if;
  if vp <> '498561f9b7b5d1a908c2c69d0f13613d' then
    raise exception 'preguntar_entregas viva distinta a la leida el 2026-10-15 (md5 %): ALTO', vp;
  end if;
  if vr <> '29f8e41b9434afc5d2b056daca494f82' then
    raise exception 'resumen_dia viva distinta a la leida el 2026-10-15 (md5 %): ALTO', vr;
  end if;
  if to_regclass('agente.pedidos') is null or to_regclass('agente.cerebro_config') is null
     or to_regclass('agente.pedido_eventos') is null or to_regclass('agente.ventas_erp') is null
     or to_regclass('agente.decisiones') is null then
    raise exception 'faltan tablas base (pedidos / cerebro_config / pedido_eventos / ventas_erp / decisiones): ALTO';
  end if;
end $g$;

-- (1) cola de turnos sin modelo
create table if not exists agente.turnos_modelo (
  id bigserial primary key,
  contacto_id text not null,
  entrada jsonb not null,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'reintentando', 'respondido', 'cubierto', 'pausado', 'vencido')),
  desde timestamptz not null default now(),
  ultimo_en timestamptz not null default now(),
  intentos int not null default 0,
  intentado_en timestamptz,
  disculpa_en timestamptz,
  fusionados int not null default 0,
  error text,
  cerrado_en timestamptz
);
create unique index if not exists ux_turnos_modelo_vivo on agente.turnos_modelo (contacto_id)
  where estado in ('pendiente', 'reintentando');
alter table agente.turnos_modelo enable row level security;

-- (3) candado diario del cierre + interruptor
create table if not exists agente.cierre_nocturno (
  fecha date not null,
  prueba boolean not null default false,
  creado_en timestamptz not null default now(),
  mensajes int,
  pedidos bigint[],
  primary key (fecha, prueba)
);
alter table agente.cierre_nocturno enable row level security;
alter table agente.cerebro_config add column if not exists cierre_nocturno boolean not null default true;

-- (4) un aviso por pedido entregado sin venta en el ERP
create table if not exists agente.erp_alertas (
  pedido_id bigint primary key,
  motivo text,
  creado_en timestamptz not null default now()
);
alter table agente.erp_alertas enable row level security;

CREATE OR REPLACE FUNCTION agente.cierre_pendientes(p_prueba boolean,
  p_hoy date DEFAULT ((now() AT TIME ZONE 'America/Mexico_City'))::date)
 RETURNS TABLE(pedido_id bigint, estado text, renglon text, entrega_fecha date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
  -- 1.17.0 (3): el universo de entregas_pendientes_todas (pagado, o pedido ya avisado como cerrado; no envio_decision 'no'),
  -- SIN ventana de dias, con la entrega hoy o antes (o sin fecha), menos lo que Norman marco "sigue pendiente" HOY.
  select p.id, p.estado,
         '#E' || p.id || ' ' ||
           coalesce(nullif(regexp_replace(split_part(coalesce(k.nombre, ''), ' ', 1), '[[:punct:][:space:]]', '', 'g'), ''),
                    nullif(split_part(coalesce(p.receptor_nombre, ''), ' ', 1), ''), 'sin nombre') ||
           coalesce(', ' || nullif(agente.nombre_items(p.items), ''), '') ||
           coalesce(', $' || to_char(coalesce(p.total_cobrado, p.total), 'FM999,999'), '') ||
           case when p.estado = 'pagado' then ' · pagado' else ' · sin pago' end ||
           coalesce(' · entrega ' || to_char(p.entrega_fecha, 'DD-MM'), ' · sin fecha'),
         p.entrega_fecha
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where (p.estado = 'pagado' or (p.estado = 'pedido' and p.avisado_cerrado_en is not null))
     and coalesce(p.envio_decision, 'va') <> 'no'
     and (p.contacto_id like 'prueba\_%') = p_prueba
     and (p.entrega_fecha is null or p.entrega_fecha <= p_hoy)
     -- ronda 2: "sigue pendiente" vive en agente.decisiones (tipo cierre_sigue), no en pedido_eventos
     and not exists (select 1 from agente.decisiones x where x.tipo = 'cierre_sigue' and x.detalle->>'pedido' = p.id::text
                      and x.creado_en >= (p_hoy::timestamp at time zone 'America/Mexico_City'))
   order by p.entrega_fecha nulls first, p.id;
$function$;

CREATE OR REPLACE FUNCTION agente.preguntar_entregas(p_prueba boolean DEFAULT false, p_enviar boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
        v_ids bigint[]; v_txt text; v_a text; v_b text; v_bot jsonb;
begin
  -- 1.17.0 (3): con el cierre nocturno encendido (cerebro_config.cierre_nocturno), la pregunta suelta no sale para los reales.
  if not p_prueba and coalesce((select c.cierre_nocturno from agente.cerebro_config c where c.id = 1), false) then
    return null;
  end if;
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

CREATE OR REPLACE FUNCTION agente.resumen_dia(p_forzar boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v_desde timestamptz; v_n jsonb; v_lineas text[]; v_texto text; v_cfg agente.cerebro_config; v_c jsonb;
begin
  select * into v_cfg from agente.cerebro_config where id = 1;
  if not p_forzar and not coalesce(v_cfg.reporte_on, true) then return 'apagado'; end if;
  v_desde := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
  select jsonb_build_object(
    'clientes', (select count(distinct contacto_id) from agente.mensajes where creado_en >= v_desde and direccion='entrante' and contacto_id not like 'prueba\_%'),
    'entrantes', (select count(*) from agente.mensajes where creado_en >= v_desde and direccion='entrante' and contacto_id not like 'prueba\_%'),
    'callados', (select count(*) from agente.mensajes where creado_en >= v_desde and direccion='entrante' and origen like '%callado%' and contacto_id not like 'prueba\_%'),
    'salientes', (select count(*) from agente.mensajes where creado_en >= v_desde and direccion='saliente' and origen not like 'puente%' and contacto_id not like 'prueba\_%'),
    'escalados', (select count(*) from agente.preguntas_abiertas where creado_en >= v_desde and contacto_id not like 'prueba\_%' and coalesce(pregunta, '') not like '📷 #C%'), -- cerebro 1.17.0: las #C (¿es comprobante?) no son dudas escaladas
    'pagos', (select count(*) from agente.comprobantes c where c.recibido_en >= v_desde and c.clase='comprobante' and coalesce(c.resultado, 'pagado') = 'pagado' and c.contacto_id not like 'prueba\_%'), -- cerebro 1.16.6
    'pagos_monto', (select coalesce(sum(coalesce(c.monto, c.monto_leido, p.total_cobrado, p.total)),0) from agente.comprobantes c left join agente.pedidos p on p.id = c.pedido_id where c.recibido_en >= v_desde and c.clase='comprobante' and coalesce(c.resultado, 'pagado') = 'pagado' and c.contacto_id not like 'prueba\_%'), -- cerebro 1.16.6
    'cerrados', (select count(*) from agente.pedido_eventos e join agente.pedidos p on p.id=e.pedido_id where e.creado_en >= v_desde and e.a='pedido' and e.de is distinct from e.a and p.contacto_id not like 'prueba\_%') -- 1.17.0 ronda 2: pedido->pedido (pregunta_entrega, etc.) no es un cierre
  ) into v_n;
  v_c := agente.contador_monto();
  select array_agg(a.linea order by a.orden, a.clave) into v_lineas
    from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a;
  v_texto := 'Resumen del dia, LucIA' || E'\n' ||
    '🟢 ' || (v_n->>'clientes') || ' clientes, ' || (v_n->>'entrantes') || ' mensajes recibidos, ' ||
    (v_n->>'salientes') || ' respuestas, ' || (v_n->>'callados') || ' sin contestar a proposito' || E'\n' ||
    '🟢 ' || (v_n->>'escalados') || ' dudas escaladas, ' || (v_n->>'cerrados') || ' pedidos cerrados' || E'\n' ||
    '💰 Hoy: ' || (v_n->>'pagos') || ' pago(s) por transferencia, $' || (v_n->>'pagos_monto') ||
    '. Contador: $' || (v_c->>'total') || ' desde el ' ||
    to_char((v_c->>'desde')::timestamptz at time zone 'America/Mexico_City', 'DD-MM HH24:MI') ||
    case when (v_c->>'sin_monto')::int > 0 then ' (' || (v_c->>'sin_monto') || ' sin monto legible)' else '' end ||
    case when v_lineas is null then E'\n✅ Nada abierto que necesite de ti.'
         else E'\nAbierto al cierre:\n' || array_to_string(v_lineas, E'\n') end ||
    coalesce(E'\n' || agente.linea_sin_costo_envio(false), '');  -- 1.15.17: ventas en el ERP sin costo de envio
  perform agente.avisar_grupo(v_texto, null, null, 'principal');
  insert into agente.reporte_items (clave)
    select a.clave from agente.asuntos_abiertos(coalesce(v_cfg.sin_respuesta_min, 10)) a on conflict do nothing;
  return v_texto;
end $function$;

commit;
