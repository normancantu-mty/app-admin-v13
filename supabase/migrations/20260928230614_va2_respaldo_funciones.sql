create table if not exists agente.respaldo_funciones (
  id bigserial primary key,
  tanda text not null,
  nombre text not null,
  definicion text not null,
  md5 text not null,
  guardado_en timestamptz not null default now()
);
alter table agente.respaldo_funciones enable row level security;
insert into agente.respaldo_funciones (tanda, nombre, definicion, md5)
select 'va2_2026-09-28', p.proname, pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'agente'
   and p.proname in ('aplicar_datos','marcar_comprobante','asuntos_abiertos','reporte_30min','insistir_datos',
                     'responder_entregas','preguntar_entregas','guardian_lineas','vigia_puente','seguimiento_ventas',
                     'resumen_dia','latido','detectar_humano_wa');
