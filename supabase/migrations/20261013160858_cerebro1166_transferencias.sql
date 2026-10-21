-- migracion_cerebro1166_transferencias.sql -- cerebro 1.16.6 (encargo DESDE_SOCIO_prompt_ejecutor_cerebro_1.16.6_transferencias_pasta_extractor).
-- Escrito el 2026-10-13 por el ejecutor del Socio. NO APLICADO. Probado en Postgres 16 local (cerebro/probar_1166_pg.test.ts).
-- Correr ANTES de desplegar el cerebro 1.16.6 (el codigo escribe las columnas nuevas). Idempotente.
-- (1) agente.comprobantes: origen ('imagen' | 'grupo'), monto_origen ('norman' | 'vision' | 'pedido'), fecha_origen
--     ('norman' | 'vision' | 'mensaje'). Nulas: las filas viejas no se reescriben. Solo se rellena ORIGEN (sin imagen y sin
--     url = 'grupo'; con imagen = 'imagen'); monto y fecha_pago NO se tocan (los corrigio el Socio el 2026-10-13).
-- (2) agente.pedidos.es_pasta (boolean, default false): un pedido de pasta no se cotiza, no hace copy ni entra al ERP.
-- (3) agente.contador_monto(): suma coalesce(monto, monto_leido, total_cobrado del pedido, total del pedido) de los pagos NO
--     rechazados (resultado 'pagado' o sin marcar). Con los datos del 2026-10-13 da lo mismo que la vieja: n 4, $3,865
--     (medido con SELECT en produccion y en PG local: probar_1166_pg).
-- Guarda: si la contador_monto viva no es la leida el 2026-10-13 (md5 de prosrc 26407c892775771047fecd97a541f006) ni la de
-- esta migracion, ABORTA todo.
-- Comprobar despues:
--   select agente.contador_monto();   -- n 4, total 3865 mientras no entre otro pago
--   select id, origen, monto, monto_origen, fecha_pago, fecha_origen from agente.comprobantes order by id;

begin;

do $g$
declare v text := (select prosrc from pg_proc where oid = 'agente.contador_monto()'::regprocedure);
begin
  if md5(v) <> '26407c892775771047fecd97a541f006' and position('1.16.6' in v) = 0 then
    raise exception 'contador_monto viva distinta a la leida el 2026-10-13 (md5 %): ALTO, no se pisa', md5(v);
  end if;
end $g$;

alter table agente.comprobantes add column if not exists origen text;
alter table agente.comprobantes add column if not exists monto_origen text;
alter table agente.comprobantes add column if not exists fecha_origen text;
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'comprobantes_origen_check1166') then
    alter table agente.comprobantes add constraint comprobantes_origen_check1166 check (origen is null or origen in ('imagen', 'grupo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comprobantes_monto_origen_check1166') then
    alter table agente.comprobantes add constraint comprobantes_monto_origen_check1166
      check (monto_origen is null or monto_origen in ('norman', 'vision', 'pedido'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'comprobantes_fecha_origen_check1166') then
    alter table agente.comprobantes add constraint comprobantes_fecha_origen_check1166
      check (fecha_origen is null or fecha_origen in ('norman', 'vision', 'mensaje'));
  end if;
end $c$;

update agente.comprobantes
   set origen = case when storage_path is null and url_original is null then 'grupo' else 'imagen' end
 where origen is null;

alter table agente.pedidos add column if not exists es_pasta boolean not null default false;

create or replace function agente.contador_monto()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'agente', 'public'
as $function$
  -- cerebro 1.16.6: monto de pago -> monto leido -> lo cobrado del pedido; sin los rechazados (resultado 'no').
  with r as (select max(reiniciado_en) as desde from agente.contador_transferencias)
  select jsonb_build_object(
    'desde', r.desde,
    'total', coalesce(sum(coalesce(c.monto, c.monto_leido, p.total_cobrado, p.total)), 0),
    'n', count(c.id),
    'sin_monto', count(c.id) filter (where coalesce(c.monto, c.monto_leido, p.total_cobrado, p.total) is null))
  from r left join agente.comprobantes c
    on c.recibido_en >= r.desde and c.clase = 'comprobante' and coalesce(c.resultado, 'pagado') = 'pagado'
   and c.contacto_id not like 'prueba\_%'
  left join agente.pedidos p on p.id = c.pedido_id
  group by r.desde
$function$;

-- (4) agente.resumen_dia(boolean): el 'Hoy: N pagos' suma coalesce(monto, monto_leido, cobrado del pedido) y cuenta/suma solo pagos no rechazados (auditoria B1:
--     contaba la transferencia del grupo y no la sumaba). Se reemplazan SOLO las 2 lineas, sobre la definicion viva.
do $rd$
declare
  v_src text := (select prosrc from pg_proc where oid = 'agente.resumen_dia(boolean)'::regprocedure);
  v_def text := pg_get_functiondef('agente.resumen_dia(boolean)'::regprocedure);
  o1 text := $o1$    'pagos', (select count(*) from agente.comprobantes where recibido_en >= v_desde and clase='comprobante' and contacto_id not like 'prueba\_%'),$o1$;
  n1 text := $n1$    'pagos', (select count(*) from agente.comprobantes c where c.recibido_en >= v_desde and c.clase='comprobante' and coalesce(c.resultado, 'pagado') = 'pagado' and c.contacto_id not like 'prueba\_%'), -- cerebro 1.16.6$n1$;
  o2 text := $o2$    'pagos_monto', (select coalesce(sum(monto_leido),0) from agente.comprobantes where recibido_en >= v_desde and clase='comprobante' and contacto_id not like 'prueba\_%'),$o2$;
  n2 text := $n2$    'pagos_monto', (select coalesce(sum(coalesce(c.monto, c.monto_leido, p.total_cobrado, p.total)),0) from agente.comprobantes c left join agente.pedidos p on p.id = c.pedido_id where c.recibido_en >= v_desde and c.clase='comprobante' and coalesce(c.resultado, 'pagado') = 'pagado' and c.contacto_id not like 'prueba\_%'), -- cerebro 1.16.6$n2$;
begin
  if position('cerebro 1.16.6' in v_src) > 0 then return; end if; -- ya migrada
  if md5(v_src) <> 'cc4976a713a9948293f6df787fbe90c7' then
    raise exception 'resumen_dia viva distinta a la leida el 2026-10-13 (md5 %): ALTO, no se pisa', md5(v_src);
  end if;
  if position(o1 in v_def) = 0 or position(o2 in v_def) = 0 then
    raise exception 'resumen_dia: no encuentro las lineas a reemplazar: ALTO';
  end if;
  execute replace(replace(v_def, o1, n1), o2, n2);
end $rd$;

commit;
