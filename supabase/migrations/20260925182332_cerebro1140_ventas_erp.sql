-- cerebro-1.14.0 (2026-09-25): ventas del agente al ERP, costo de envio (local y guia), ciudad y seguimiento.
-- Plan: Socio/_checkpoints/PLAN_ventas_agente_al_erp_2026-09-25.md (seccion 7 manda).
-- DESHACER: drop view agente.v_ventas_por_ciudad; drop function agente.normalizar_ciudad(text);
--   drop table agente.ventas_erp; drop table agente.ciudades; y redefinir guardian_lineas / asuntos_abiertos
--   con la version de 20260925144815_cerebro1134b_guardian_lineas_ambiguo.sql.

-- 1. Ciudades: la regla local/nacional vive aqui y no en un regex del cerebro.
create table if not exists agente.ciudades (
  alias text primary key,
  ciudad text not null,
  local boolean not null default false,
  creada_en timestamptz not null default now(),
  por text
);
alter table agente.ciudades enable row level security;
revoke all on agente.ciudades from anon, authenticated;

insert into agente.ciudades (alias, ciudad, local, por) values
  ('fresnillo', 'Fresnillo', true, 'semilla'),
  ('fres', 'Fresnillo', true, 'semilla'),
  ('fresnillo zac', 'Fresnillo', true, 'semilla'),
  ('fresnillo zacatecas', 'Fresnillo', true, 'semilla'),
  ('zacatecas', 'Zacatecas', true, 'semilla'),
  ('zac', 'Zacatecas', true, 'semilla'),
  ('zacatecas zac', 'Zacatecas', true, 'semilla'),
  ('zacatecas zacatecas', 'Zacatecas', true, 'semilla'),
  ('guadalupe', 'Guadalupe', true, 'semilla'),
  ('gpe', 'Guadalupe', true, 'semilla'),
  ('guadalupe zac', 'Guadalupe', true, 'semilla'),
  ('guadalupe zacatecas', 'Guadalupe', true, 'semilla'),
  ('gpe zac', 'Guadalupe', true, 'semilla'),
  ('guadalupe nl', 'Guadalupe NL', false, 'semilla'),
  ('guadalupe nuevo leon', 'Guadalupe NL', false, 'semilla'),
  ('monterrey', 'Monterrey', false, 'semilla'),
  ('mty', 'Monterrey', false, 'semilla'),
  ('monterrey nl', 'Monterrey', false, 'semilla'),
  ('monterrey nuevo leon', 'Monterrey', false, 'semilla'),
  ('cdmx', 'Ciudad de Mexico', false, 'semilla'),
  ('ciudad de mexico', 'Ciudad de Mexico', false, 'semilla'),
  ('df', 'Ciudad de Mexico', false, 'semilla'),
  ('guadalajara', 'Guadalajara', false, 'semilla'),
  ('gdl', 'Guadalajara', false, 'semilla')
on conflict (alias) do nothing;

-- 2. normalizar_ciudad: texto libre del extractor -> ciudad canonica + local.
--    Exacto por alias; si no, el alias mas largo que sea prefijo de palabra completa
--    ("monterrey nuevo leon mexico" -> monterrey). Desconocida: capitalizada, local=false, conocida=false.
create or replace function agente.normalizar_ciudad(p_texto text)
returns table (ciudad text, local boolean, conocida boolean)
language plpgsql stable
set search_path to 'agente', 'public'
as $function$
declare v_llave text; v_c record;
begin
  v_llave := btrim(regexp_replace(regexp_replace(
    translate(lower(coalesce(p_texto, '')), 'áéíóúüñ', 'aeiouun'),
    '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'));
  if v_llave = '' then
    return query select null::text, null::boolean, false;
    return;
  end if;
  select c.ciudad, c.local into v_c from agente.ciudades c
   where v_llave = c.alias or v_llave like c.alias || ' %'
   order by (v_llave = c.alias) desc, length(c.alias) desc limit 1;
  if found then
    return query select v_c.ciudad, v_c.local, true;
  else
    return query select initcap(btrim(regexp_replace(p_texto, '\s+', ' ', 'g'))), false, false;
  end if;
end $function$;

-- 3. ventas_erp: una fila por pedido que se paso (o se intento pasar) al ERP. La PK es la idempotencia.
create table if not exists agente.ventas_erp (
  pedido_id bigint primary key references agente.pedidos(id),
  estado text not null default 'registrando'
    check (estado in ('registrando', 'registrada', 'error', 'cancelada')),
  id_ticket uuid,
  error text,
  ciudad text,
  zona text check (zona in ('local', 'nacional')),
  metodo_pago text,
  total numeric,
  envio_cobrado numeric,
  envio_costo numeric check (envio_costo is null or envio_costo >= 0),
  id_gasto_envio uuid,
  creado_en timestamptz not null default now(),
  registrada_en timestamptz,
  costo_en timestamptz,
  actualizado_en timestamptz not null default now()
);
alter table agente.ventas_erp enable row level security;
revoke all on agente.ventas_erp from anon, authenticated;

-- 4. Ventas por ciudad: solo tickets ACTIVOS del ERP (una venta anulada alla no cuenta aqui).
create or replace view agente.v_ventas_por_ciudad as
select coalesce(v.ciudad, '(sin ciudad)') as ciudad,
       to_char(t.fecha_transaccion at time zone 'America/Mexico_City', 'YYYY-MM') as mes,
       count(*) as ventas,
       sum(t.total_cobrado_real) as vendido,
       sum(coalesce(v.envio_cobrado, 0)) as envio_cobrado,
       sum(coalesce(v.envio_costo, 0)) as envio_costo,
       sum(coalesce(v.envio_cobrado, 0) - coalesce(v.envio_costo, 0)) as neto_envio,
       count(*) filter (where v.envio_costo is null) as sin_costo
  from agente.ventas_erp v
  join public.transacciones_tickets t on t.id = v.id_ticket and t.status = 'ACTIVO'
 where v.estado = 'registrada'
 group by 1, 2;
revoke all on agente.v_ventas_por_ciudad from anon, authenticated;

-- 5. Seguimiento que no se apaga (Norman: "no se deja de preguntar hasta que quede"). Clave NULL = sin dedup:
--    sale cada noche con los dias de antiguedad hasta que se resuelve.
create or replace function agente.seguimiento_ventas(p_prueba boolean)
returns table (orden integer, pedido_id bigint, dias integer, linea text)
language sql stable security definer
set search_path to 'agente', 'public'
as $function$
  select 4, p.id,
         (extract(epoch from now() - coalesce(p.avisado_cerrado_en, p.actualizado_en, p.creado_en)) / 86400)::int,
         '📦 Pedido #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || coalesce(' (' || p.ciudad || ')', '') ||
         ' ' || p.estado || ' hace ' ||
         (extract(epoch from now() - coalesce(p.avisado_cerrado_en, p.actualizado_en, p.creado_en)) / 86400)::int ||
         ' d, sin entrega: "entregado #E' || p.id || '" o "cancelado #E' || p.id || '"'
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where (p.estado = 'pagado' or (p.estado = 'pedido' and p.avisado_cerrado_en is not null))
     and coalesce(p.avisado_cerrado_en, p.actualizado_en, p.creado_en) <= now() - interval '24 hours'
     and coalesce(p.envio_decision, 'va') <> 'no'
     and (p.contacto_id like 'prueba\_%') = p_prueba
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
$function$;
revoke all on function agente.seguimiento_ventas(boolean) from public, anon, authenticated;

-- 6. guardian_lineas: la linea 4 (pedido sin entrega, con tope de 14 dias) se sustituye por seguimiento_ventas,
--    que no tiene tope. Lo demas, identico a cerebro1134b.
create or replace function agente.guardian_lineas(p_modo text default 'real'::text, p_tono boolean default null::boolean)
 returns table(seccion text, orden integer, clave text, linea text, cuenta boolean)
 language plpgsql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
declare
  v_prueba boolean := (p_modo = 'prueba');
  v_min int;
  v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
  v_tono boolean := coalesce(p_tono, extract(dow from now() at time zone 'America/Mexico_City') = 0);
  v_puente timestamptz; v_ult timestamptz; v_n int; v_p95 numeric; v_err int; v_tarde int; v_alarm int;
  v_vig record; v_t record;
begin
  select coalesce(sin_respuesta_min, 10) into v_min from agente.cerebro_config where id = 1;
  v_min := coalesce(v_min, 10);

  return query
  select 'atender', 1, null::text,
         '⏸️ #P' || q.id || ' ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') lleva ' ||
         (extract(epoch from now() - q.creado_en) / 3600)::int || ' h en pausa' ||
         case when q.tomada_por = 'norman' then ' (la tomaste tu)' else '' end ||
         ': "' || left(regexp_replace(q.pregunta, '\s+', ' ', 'g'), 100) || '"', true
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.creado_en <= now() - interval '2 hours'
     and (q.contacto_id like 'prueba\_%') = v_prueba
   order by q.id;

  return query
  select 'atender', 2, null::text,
         '💰 Comprobante #C' || c.id || ' de ' || coalesce(k.nombre, c.contacto_id) ||
         coalesce(' por ' || '$' || c.monto_leido::text, '') || ' sin marcar desde hace ' ||
         (extract(epoch from now() - c.recibido_en) / 3600)::int || ' h' ||
         coalesce(' (pedido #E' || c.pedido_id || ')', ''), true
    from agente.comprobantes c join agente.contactos k on k.id = c.contacto_id
   where c.resultado is null and coalesce(c.clase, '') <> 'otra_imagen'
     and c.recibido_en <= now() - interval '24 hours' and c.recibido_en > now() - interval '14 days'
     and (c.contacto_id like 'prueba\_%') = v_prueba
   order by c.id;

  return query
  select 'atender', 3, null::text,
         '🚚 Envio nacional #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || ' (' || coalesce(p.ciudad,'?') ||
         ') sin decidir desde hace ' || (extract(epoch from now() - p.avisado_cerrado_en) / 3600)::int ||
         ' h (contesta "va" o "no va" al aviso)', true
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where p.zona = 'nacional' and p.envio_decision is null and p.avisado_cerrado_en is not null
     and p.avisado_cerrado_en <= now() - interval '4 hours' and p.estado not in ('cancelado','entregado')
     and (p.contacto_id like 'prueba\_%') = v_prueba
   order by p.id;

  return query
  select 'atender', s.orden, null::text, s.linea, true
    from agente.seguimiento_ventas(v_prueba) s
   order by s.orden, s.pedido_id;

  return query
  with ult as (
    select distinct on (m.contacto_id) m.contacto_id, m.id, m.direccion, m.origen, m.texto, m.creado_en
      from agente.mensajes m
     where m.creado_en > now() - interval '24 hours' and coalesce(m.origen,'') not like 'puente%'
     order by m.contacto_id, m.creado_en desc, m.id desc)
  select 'atender', 5, null::text,
         '🔴 ' || coalesce(k.nombre, u.contacto_id) || ' (' || coalesce(k.canal,'?') || ') escribio hace ' ||
         case when now() - u.creado_en < interval '2 hours' then (extract(epoch from now() - u.creado_en) / 60)::int || ' min'
              else (extract(epoch from now() - u.creado_en) / 3600)::int || ' h' end ||
         ' y no recibio respuesta: "' || left(regexp_replace(u.texto, '\s+', ' ', 'g'), 90) || '"', true
    from ult u join agente.contactos k on k.id = u.contacto_id
   where u.direccion = 'entrante'
     and coalesce(u.origen,'') not like '%callado%' and coalesce(u.origen,'') not like '%pausa%'
     and coalesce(u.origen,'') not like '%rafaga%'
     and u.creado_en < now() - make_interval(mins => v_min)
     and (u.contacto_id like 'prueba\_%') = v_prueba;

  if not v_prueba then
    return query
    select 'atender', 6, null::text,
           '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
           (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h y en la bandeja nadie le contesto: "' ||
           left(coalesce(v.texto,''), 90) || '"', true
      from agente.vigia_alertas v
     where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
     order by v.id;
  end if;

  return query
  select 'reglas', 1, 'guardian:vieja:' || r.id || ':' || to_char(now() at time zone 'America/Mexico_City', 'IYYY-IW'),
         '📌 Regla #' || r.id || ' lleva ' || (extract(epoch from now() - r.creada_en) / 86400)::int ||
         ' dias viva: "' || left(r.texto, 140) || '". ¿La subo al NUCLEO?', true
    from agente.reglas_vivas r
   where r.activa and r.creada_en <= now() - interval '7 days' and (r.quien like 'prueba%') = v_prueba
   order by r.id;

  return query
  select 'reglas', 2, null::text,
         '⏳ Regla #' || r.id || ' sigue pendiente desde hace ' || (extract(epoch from now() - r.creada_en) / 3600)::int ||
         ' h: "' || left(r.texto, 140) || '". Contesta "si" a su aviso para ponerla o "quita la regla ' || r.id || '"', true
    from agente.reglas_vivas r
   where not r.activa and r.apagada_en is null and r.nota = 'pendiente' and (r.quien like 'prueba%') = v_prueba
   order by r.id;

  if v_prueba then return; end if;

  select en into v_puente from agente.salud s where s.clave = 'puente';
  if v_puente is null then
    return query select 'salud', 1, null::text, '⚪ Puente del grupo: sin medir (todavia no manda latido)', false;
  elsif v_puente < now() - interval '20 minutes' then
    return query select 'salud', 1, null::text,
      '🔴 Puente del grupo sin latido desde hace ' ||
      case when now() - v_puente < interval '2 hours' then (extract(epoch from now() - v_puente) / 60)::int || ' min'
           else (extract(epoch from now() - v_puente) / 3600)::int || ' h' end ||
      ': lo que escribes en el grupo no le llega al cerebro', true;
  end if;

  select max(creado_en) into v_ult from agente.mensajes where direccion = 'entrante' and contacto_id not like 'prueba\_%';
  if v_ult is null or v_ult < now() - interval '24 hours' then
    return query select 'salud', 2, null::text,
      '🔴 Ningun cliente le ha escrito al cerebro en ' ||
      coalesce((extract(epoch from now() - v_ult) / 3600)::int::text, '??') || ' h (ultimo: ' ||
      coalesce(to_char(v_ult at time zone 'America/Mexico_City', 'DD-MM HH24:MI'), 'nunca') ||
      '). ¿ManyChat sigue mandando los mensajes?', true;
  end if;

  select count(*) filter (where origen like 'reglas%'), count(*) filter (where origen like '%tarde_fallo%')
    into v_err, v_tarde
    from agente.mensajes where direccion = 'saliente' and creado_en >= v_hoy and contacto_id not like 'prueba\_%';
  select count(*) into v_alarm from agente.latido where corrida_en >= v_hoy and estado = 'alarma';
  if v_err + v_tarde + v_alarm > 0 then
    return query select 'salud', 3, null::text,
      '🟠 Errores hoy: ' || v_err || ' respuestas de la red de seguridad (Anthropic fallo), ' || v_tarde ||
      ' envios que no salieron, ' || v_alarm || ' alarmas del latido', true;
  end if;

  select count(*), percentile_cont(0.95) within group (order by ms) into v_n, v_p95
    from agente.mensajes where direccion = 'saliente' and origen like 'modelo%' and ms is not null
     and creado_en >= v_hoy and contacto_id not like 'prueba\_%';
  if v_n > 0 and v_p95 > 7000 then
    return query select 'salud', 4, null::text,
      '🟠 Latencia p95 hoy: ' || round(v_p95 / 1000.0, 1) || ' s en ' || v_n || ' respuestas (ManyChat corta a los 10 s)', true;
  end if;

  select * into v_vig from agente.vigia_corridas order by id desc limit 1;
  if v_vig is null then
    return query select 'salud', 5, null::text, '⚪ Vigia de la bandeja: sin medir (no ha corrido nunca)', false;
  else
    if v_vig.corrida_en < now() - interval '1 hour' then
      return query select 'salud', 5, null::text,
        '🔴 El vigia de la bandeja no corre desde hace ' || (extract(epoch from now() - v_vig.corrida_en) / 3600)::int || ' h', true;
    end if;
    if v_vig.errores ? 'meta' then
      return query select 'salud', 6, null::text,
        '⚪ Messenger/Instagram sin contestar: sin medir (no hay fb_page_token en el vault; el vigia solo ve WhatsApp Cloud API)', false;
    elsif v_vig.errores ? 'instagram' then
      return query select 'salud', 6, null::text, '⚪ Instagram sin contestar: sin medir (Graph dio error o timeout)', false;
    end if;
  end if;

  if v_tono then
    select count(*) n,
           round(100.0 * count(*) filter (where left(ltrim(texto), 1) = '¡') / nullif(count(*), 0)) abre,
           round(100.0 * count(*) filter (where rtrim(texto) ~ '\?[^[:alnum:]]{0,4}$') / nullif(count(*), 0)) preg,
           percentile_cont(0.5) within group (order by char_length(texto)) med,
           round(100.0 * count(*) filter (where texto ~ '[\U0001F300-\U0001FAFF☀-➿⭐❤]') / nullif(count(*), 0)) emo
      into v_t
      from agente.mensajes
     where direccion = 'saliente' and origen like 'modelo%' and creado_en > now() - interval '7 days'
       and contacto_id not like 'prueba\_%' and coalesce(texto, '') <> '';
    if coalesce(v_t.n, 0) = 0 then
      return query select 'tono', 1, null::text, '⚪ Tono de la semana: sin medir (0 respuestas reales en 7 dias)', true;
    else
      return query select 'tono', 1, null::text,
        '🗣️ Tono, ' || v_t.n || ' respuestas de la semana: ' || v_t.abre || '% abre con ¡ (antes 57%), ' ||
        v_t.preg || '% termina en pregunta (antes 46%), mediana ' || v_t.med::int || ' car (antes 145), ' ||
        v_t.emo || '% con emoji (antes 100%)', true;
    end if;
  end if;
end $function$;

-- 7. asuntos_abiertos (reporte de 30 min): a los 3 dias, lo de seguimiento_ventas sale ADEMAS en el reporte de
--    las 09:00 MX, una vez por dia (la clave lleva la fecha; reporte_items la deduplica dentro del dia).
create or replace function agente.asuntos_abiertos(p_sin_resp_min integer)
 returns table(clave text, orden integer, linea text)
 language sql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
  with ult as (
    select distinct on (m.contacto_id) m.contacto_id, m.id, m.direccion, m.origen, m.texto, m.creado_en
      from agente.mensajes m
     where m.creado_en > now() - interval '24 hours'
       and coalesce(m.origen,'') not like 'puente%'
     order by m.contacto_id, m.creado_en desc, m.id desc)
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
         '⁉️ ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') sigue en pausa' ||
         case when q.tomada_por = 'norman' then ', la tomaste tu' else ' esperando que me digas si la retomo yo o tu' end ||
         case when q.entrantes_en_pausa > 0 then ', y ya escribio ' || q.entrantes_en_pausa || ' mensaje(s) mas' else '' end ||
         ': "' || left(q.pregunta, 90) || '"'
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.entrantes_en_pausa > 0
     and q.creado_en > now() - interval '2 hours'
  union all
  select 'pausa2h:' || q.id, 0,
         '🔴 ' || coalesce(k.nombre, q.contacto_id) || ' (' || coalesce(q.canal,'?') || ') lleva ' ||
         (extract(epoch from now() - q.creado_en) / 3600)::int || ' h en pausa' ||
         case when q.tomada_por = 'norman' then ' (la tomaste tu)' else '' end ||
         ': "' || left(q.pregunta, 90) || '"'
    from agente.preguntas_abiertas q join agente.contactos k on k.id = q.contacto_id
   where q.estado = 'abierta' and q.pausa and q.creado_en <= now() - interval '2 hours'
  union all
  select 'envio:' || p.id, 2,
         '⁉️ Envio nacional #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || ' (' || coalesce(p.ciudad,'?') ||
         ') espera que me digas si va, desde hace ' || (extract(epoch from now() - p.avisado_cerrado_en) / 3600)::int || ' h'
    from agente.pedidos p join agente.contactos k on k.id = p.contacto_id
   where p.estado = 'pedido' and p.envio_decision is null and p.avisado_cerrado_en is not null
     and p.avisado_cerrado_en <= now() - interval '1 hour' and p.zona = 'nacional'
  union all
  select 'vigia:' || v.id, 1,
         '👀 ' || coalesce(v.quien, '?') || ' (' || v.canal || ') escribio hace ' ||
         case when now() - v.ultimo_ts < interval '2 hours'
              then (extract(epoch from now() - v.ultimo_ts) / 60)::int || ' min'
              else (extract(epoch from now() - v.ultimo_ts) / 3600)::int || ' h' end ||
         ' y en la bandeja nadie le contesto (lo vio el vigia, fuera del cerebro): "' || left(coalesce(v.texto,''), 90) || '"'
    from agente.vigia_alertas v
   where v.canal <> 'sistema' and v.ultimo_ts > now() - interval '24 hours'
  union all
  select 'vigia:' || v.id, 3, '⚠️ El token de la pagina de Facebook caduco: el vigia no ve Messenger ni Instagram.'
    from agente.vigia_alertas v
   where v.canal = 'sistema' and v.hilo = 'token_meta' and v.ultimo_ts > now() - interval '24 hours'
  union all
  select 'venta3d:' || s.orden || ':' || s.pedido_id || ':' || to_char(now() at time zone 'America/Mexico_City', 'YYYY-MM-DD'),
         4, s.linea
    from agente.seguimiento_ventas(false) s
   where s.dias >= 3 and extract(hour from now() at time zone 'America/Mexico_City') = 9;
$function$;
