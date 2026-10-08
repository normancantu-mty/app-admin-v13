-- cerebro 1.15.9 (2026-10-02): total_cobrado, alias fllo/fsnllo, rafaga_datos_ms y el aviso de entregas con lo cobrado.
alter table agente.pedidos add column if not exists total_cobrado numeric;
comment on column agente.pedidos.total_cobrado is 'cerebro 1.15.9: lo que se le cobra al cliente (cotizar: mayoreo + envio), escrito al armar el copy del cierre. null = sin calcular o TOTAL POR CONFIRMAR. Lo leen entregas_pendientes y el envio al ERP.';
insert into agente.ciudades (alias, ciudad, local, por) values
  ('fllo', 'Fresnillo', true, 'cerebro1159'),
  ('fsnllo', 'Fresnillo', true, 'cerebro1159')
on conflict (alias) do nothing;
alter table agente.cerebro_config add column if not exists rafaga_datos_ms integer default 25000;
update agente.cerebro_config set rafaga_datos_ms = 25000 where rafaga_datos_ms is null;
CREATE OR REPLACE FUNCTION agente.entregas_pendientes(p_prueba boolean)
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
