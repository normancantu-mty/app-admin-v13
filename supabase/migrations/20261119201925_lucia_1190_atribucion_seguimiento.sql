alter table agente.contactos add column if not exists atrib_ref text;
alter table agente.contactos add column if not exists atrib_ad_id text;
alter table agente.contactos add column if not exists atrib_ctwa_clid text;
alter table agente.contactos add column if not exists atrib_fuente text;
alter table agente.contactos add column if not exists atrib_en timestamptz;
create table if not exists agente.campanias (
  id                    bigint generated always as identity primary key,
  nombre                text not null,
  medio                 text not null check (medio in ('pagado', 'organico', 'offline', 'referido')),
  plataforma            text,
  canal_destino         text not null check (canal_destino in ('whatsapp', 'facebook', 'instagram', 'multi')),
  meta_campaign_id      text,
  meta_adset_id         text,
  meta_source_ids       text[] not null default '{}',
  codigo_ref            text check (codigo_ref ~ '^AC-[A-Z0-9]{1,12}%?$'),
  inicio                date not null,
  fin                   date,
  presupuesto           numeric(12,2),
  gasto_real            numeric(12,2),
  gasto_fuente          text,
  gasto_verificado_en   date,
  atribuir_por_ventana  boolean not null default false,
  ventana_dias          int not null default 7,
  fuente                text,
  notas                 text,
  creado_en             timestamptz not null default now(),
  actualizado_en        timestamptz not null default now()
);
create unique index if not exists ux_campanias_codigo_ref on agente.campanias (codigo_ref) where codigo_ref is not null;
create index if not exists ix_campanias_source_ids on agente.campanias using gin (meta_source_ids);
create index if not exists ix_campanias_fechas on agente.campanias (inicio, fin);
create or replace view agente.v_wa_referral with (security_invoker = true) as
select e.id as escucha_id,
       e.recibido_en,
       to_timestamp((m->>'timestamp')::bigint) as ts_meta,
       right(regexp_replace(m->>'from', '\D', '', 'g'), 10) as tel10,
       m->>'id' as wamid,
       t.contacto_id,
       m->'referral'->>'source_type' as source_type,
       m->'referral'->>'source_id'   as source_id,
       m->'referral'->>'ctwa_clid'   as ctwa_clid,
       m->'referral'->>'headline'    as headline,
       m->'referral'->>'source_url'  as source_url,
       m->'referral'->>'media_type'  as media_type
from agente.whatsapp_escucha e
cross join lateral jsonb_array_elements(case when jsonb_typeof(e.payload->'entry') = 'array' then e.payload->'entry' else '[]'::jsonb end) en
cross join lateral jsonb_array_elements(case when jsonb_typeof(en->'changes') = 'array' then en->'changes' else '[]'::jsonb end) ch
cross join lateral jsonb_array_elements(case when jsonb_typeof(ch->'value'->'messages') = 'array' then ch->'value'->'messages' else '[]'::jsonb end) m
left join agente.wa_telefonos t on t.tel10 = right(regexp_replace(m->>'from', '\D', '', 'g'), 10)
where m ? 'referral';
create or replace view agente.v_wa_referral_primer_toque with (security_invoker = true) as
select distinct on (contacto_id) *
from agente.v_wa_referral
where contacto_id is not null
order by contacto_id, ts_meta;
create or replace view agente.v_codigo_ref_conversacion with (security_invoker = true) as
select distinct on (conversacion_id) conversacion_id, codigo
from (
  select pm.conversacion_id, upper(substring(pm.texto from '\[(AC-[A-Za-z0-9]{1,12})\]')) as codigo
  from (select distinct on (conversacion_id) conversacion_id, texto
        from agente.mensajes where direccion = 'entrante'
        order by conversacion_id, creado_en) pm
  where substring(pm.texto from '\[(AC-[A-Za-z0-9]{1,12})\]') is not null
  union
  select m.conversacion_id, upper(d.valor)
  from agente.dato_cliente d
  join agente.mensajes m on m.id = d.fuente_mensaje_id
  where d.campo = 'anuncio' and d.extractor in ('url', 'regex', 'manychat') and m.conversacion_id is not null
    and d.valor ~* '^AC-[A-Z0-9]{1,12}$'
) u
order by conversacion_id, codigo;
create or replace view agente.v_atribucion_conversacion with (security_invoker = true) as
select cv.id as conversacion_id,
       cv.contacto_id,
       cv.canal,
       cv.abierta_en,
       cv.ultima_en,
       cv.estado,
       (coalesce(cv.contacto_id, '') like 'prueba%') as es_prueba,
       coalesce(c1.id, c2.id, c3.id) as campania_id,
       case when c1.id is not null then 1
            when c2.id is not null then 2
            when c3.id is not null then 3
            when r.source_id is not null then 9
            else 0 end as nivel,
       case when c1.id is not null then 'referral_meta'
            when c2.id is not null then 'codigo_ref'
            when c3.id is not null then 'ventana_temporal'
            when r.source_id is not null then 'referral_sin_campania'
            else 'sin_atribucion' end as regla,
       r.source_type,
       r.source_id,
       r.ctwa_clid,
       r.ts_meta as ts_referral,
       cr.codigo,
       k.atrib_ref,
       k.atrib_ad_id,
       k.atrib_fuente
from agente.conversaciones cv
left join agente.contactos k on k.id = cv.contacto_id
left join agente.v_wa_referral_primer_toque r
       on r.contacto_id = cv.contacto_id
      and r.ts_meta <= cv.ultima_en + interval '10 min'
      and r.ts_meta >= cv.abierta_en - interval '90 days'
left join agente.v_codigo_ref_conversacion cr on cr.conversacion_id = cv.id
left join lateral (
  select c.id from agente.campanias c
  where (r.source_id is not null and r.source_id = any(c.meta_source_ids))
     or (k.atrib_ad_id is not null and k.atrib_ad_id = any(c.meta_source_ids)
         and k.atrib_en between cv.abierta_en - interval '90 days' and cv.ultima_en + interval '10 min')
  order by c.inicio desc limit 1) c1 on true
left join lateral (
  select c.id from agente.campanias c
  cross join lateral (select coalesce(cr.codigo, case when k.atrib_en between cv.abierta_en - interval '90 days'
                                                       and cv.ultima_en + interval '10 min' then upper(k.atrib_ref) end) as cod) x
  where x.cod is not null
    and (x.cod = c.codigo_ref
         or (c.codigo_ref like '%\%' escape '\' and x.cod like c.codigo_ref)
         or x.cod = any(c.meta_source_ids))
  order by c.inicio desc limit 1) c2 on true
left join lateral (
  select c.id from agente.campanias c
  where c.atribuir_por_ventana
    and c.canal_destino in (cv.canal, 'multi')
    and (cv.abierta_en at time zone 'America/Mexico_City')::date between c.inicio and coalesce(c.fin, current_date) + c.ventana_dias
    and (k.primer_visto at time zone 'America/Mexico_City')::date between c.inicio and coalesce(c.fin, current_date) + c.ventana_dias
  order by c.inicio desc limit 1) c3 on true;
create or replace view agente.v_atribucion_pedido with (security_invoker = true) as
select p.id as pedido_id,
       p.contacto_id,
       coalesce(p.conversacion_id, u.id, f.id) as conversacion_id,
       p.estado,
       p.creado_en,
       coalesce(p.total_cobrado, p.total) as venta,
       a.campania_id,
       coalesce(a.nivel, 0) as nivel,
       coalesce(a.regla, 'sin_atribucion') as regla,
       (coalesce(p.contacto_id, '') like 'prueba%' or coalesce(p.origen, '') like 'prueba%') as es_prueba
from agente.pedidos p
left join lateral (
  select cv.id from agente.conversaciones cv
  where p.conversacion_id is null and cv.contacto_id = p.contacto_id and cv.abierta_en <= p.creado_en
  order by cv.abierta_en desc limit 1) u on true
left join lateral (
  select cv.id from agente.conversaciones cv
  where p.conversacion_id is null and u.id is null and cv.contacto_id = p.contacto_id
  order by cv.abierta_en asc limit 1) f on true
left join agente.v_atribucion_conversacion a on a.conversacion_id = coalesce(p.conversacion_id, u.id, f.id);
create or replace view agente.v_metricas_campania with (security_invoker = true) as
with grupos as (
  select 'c:' || c.id as clave, c.nombre as campania, c.id as campania_id, null::int as nivel, c.gasto_real
  from agente.campanias c
  union all select 'referral_sin_campania', 'referral sin campania registrada', null, 9, null
  union all select 'sin_atribucion', 'sin atribucion', null, 0, null
),
conv as (
  select case when campania_id is not null then 'c:' || campania_id
              when nivel = 9 then 'referral_sin_campania'
              else 'sin_atribucion' end as clave,
         conversacion_id, contacto_id
  from agente.v_atribucion_conversacion where not es_prueba
),
ped as (
  select case when campania_id is not null then 'c:' || campania_id
              when nivel = 9 then 'referral_sin_campania'
              else 'sin_atribucion' end as clave,
         pedido_id, estado, venta
  from agente.v_atribucion_pedido where not es_prueba
),
agg_conv as (select clave, count(*) as conversaciones, count(distinct contacto_id) as contactos from conv group by clave),
agg_msg  as (select conv.clave, count(*) as mensajes_entrantes
             from conv join agente.mensajes m on m.conversacion_id = conv.conversacion_id and m.direccion = 'entrante'
             group by conv.clave),
agg_ped  as (select clave, count(*) as pedidos,
                    count(*) filter (where estado = 'entregado') as pedidos_entregados,
                    coalesce(sum(venta) filter (where estado = 'entregado'), 0) as venta_entregada
             from ped group by clave),
agg_erp  as (select ped.clave, coalesce(sum(v.total), 0) as venta_erp_registrada
             from ped join agente.ventas_erp v on v.pedido_id = ped.pedido_id and v.estado = 'registrada'
             group by ped.clave)
select g.clave, g.campania, g.campania_id,
       coalesce(agg_msg.mensajes_entrantes, 0)   as mensajes_entrantes,
       coalesce(agg_conv.conversaciones, 0)      as conversaciones,
       coalesce(agg_conv.contactos, 0)           as contactos,
       coalesce(agg_ped.pedidos, 0)              as pedidos,
       coalesce(agg_ped.pedidos_entregados, 0)   as pedidos_entregados,
       coalesce(agg_ped.venta_entregada, 0)      as venta_entregada,
       coalesce(agg_erp.venta_erp_registrada, 0) as venta_erp_registrada,
       g.gasto_real,
       g.gasto_real / nullif(agg_msg.mensajes_entrantes, 0)  as costo_por_mensaje,
       g.gasto_real / nullif(agg_conv.conversaciones, 0)     as costo_por_conversacion,
       g.gasto_real / nullif(agg_ped.pedidos_entregados, 0)  as costo_por_venta,
       agg_ped.venta_entregada / nullif(g.gasto_real, 0)     as roas
from grupos g
left join agg_conv on agg_conv.clave = g.clave
left join agg_msg  on agg_msg.clave  = g.clave
left join agg_ped  on agg_ped.clave  = g.clave
left join agg_erp  on agg_erp.clave  = g.clave;
create or replace view agente.v_reporte_semanal_atribucion with (security_invoker = true) as
with conv as (
  select date_trunc('week', a.abierta_en at time zone 'America/Mexico_City')::date as semana,
         case when a.campania_id is not null then 'c:' || a.campania_id when a.nivel = 9 then 'referral_sin_campania' else 'sin_atribucion' end as clave,
         coalesce(c.nombre, case when a.nivel = 9 then 'referral sin campania registrada' else 'sin atribucion' end) as campania,
         count(*) as conversaciones, count(distinct a.contacto_id) as contactos
  from agente.v_atribucion_conversacion a
  left join agente.campanias c on c.id = a.campania_id
  where not a.es_prueba
  group by 1, 2, 3
),
ped as (
  select date_trunc('week', a.creado_en at time zone 'America/Mexico_City')::date as semana,
         case when a.campania_id is not null then 'c:' || a.campania_id when a.nivel = 9 then 'referral_sin_campania' else 'sin_atribucion' end as clave,
         coalesce(c.nombre, case when a.nivel = 9 then 'referral sin campania registrada' else 'sin atribucion' end) as campania,
         count(*) as pedidos,
         count(*) filter (where a.estado = 'entregado') as entregados,
         coalesce(sum(a.venta) filter (where a.estado = 'entregado'), 0) as venta
  from agente.v_atribucion_pedido a
  left join agente.campanias c on c.id = a.campania_id
  where not a.es_prueba
  group by 1, 2, 3
)
select coalesce(conv.semana, ped.semana)     as semana,
       coalesce(conv.clave, ped.clave)       as clave,
       coalesce(conv.campania, ped.campania) as campania,
       coalesce(conv.conversaciones, 0)      as conversaciones,
       coalesce(conv.contactos, 0)           as contactos,
       coalesce(ped.pedidos, 0)              as pedidos,
       coalesce(ped.entregados, 0)           as entregados,
       coalesce(ped.venta, 0)                as venta
from conv
full outer join ped on ped.semana = conv.semana and ped.clave = conv.clave;
grant select on agente.v_wa_referral, agente.v_wa_referral_primer_toque, agente.v_codigo_ref_conversacion,
                agente.v_atribucion_conversacion, agente.v_atribucion_pedido, agente.v_metricas_campania,
                agente.v_reporte_semanal_atribucion to service_role;
grant select, insert, update on agente.campanias to service_role;
create or replace function agente.seguimiento_frio()
 returns integer
 language plpgsql
 security definer
 set search_path to 'agente', 'net', 'vault', 'public'
as $function$
declare v_clave text;
begin
  if not pg_try_advisory_xact_lock(115118) then return 0; end if;
  select decrypted_secret into v_clave from vault.decrypted_secrets where name = 'vigia_clave';
  if v_clave is null then return 0; end if;
  perform net.http_post(
    url := 'https://gnnqxtsdrbvmlkhfemjw.supabase.co/functions/v1/manychat-cerebro?accion=seguimiento',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-guardian-clave', v_clave),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
  return 1;
end $function$;
revoke all on function agente.seguimiento_frio() from public, anon, authenticated;
