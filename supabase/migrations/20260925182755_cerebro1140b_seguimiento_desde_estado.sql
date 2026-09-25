-- cerebro-1.14.0b (2026-09-25): la antiguedad de un pedido sin entrega se mide desde que ENTRO a su estado
-- (pedido_eventos), no desde actualizado_en, que el extractor mueve en cada mensaje y reiniciaba la cuenta.
-- DESHACER: redefinir agente.seguimiento_ventas con la version de 20260925182332_cerebro1140_ventas_erp.sql.
create or replace function agente.seguimiento_ventas(p_prueba boolean)
returns table (orden integer, pedido_id bigint, dias integer, linea text)
language sql stable security definer
set search_path to 'agente', 'public'
as $function$
  with p as (
    select p.*, coalesce(p.avisado_cerrado_en,
             (select min(e.creado_en) from agente.pedido_eventos e where e.pedido_id = p.id and e.a = p.estado),
             p.creado_en) as desde
      from agente.pedidos p
     where p.estado = 'pagado' or (p.estado = 'pedido' and p.avisado_cerrado_en is not null))
  select 4, p.id, (extract(epoch from now() - p.desde) / 86400)::int,
         '📦 Pedido #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || coalesce(' (' || p.ciudad || ')', '') ||
         ' ' || p.estado || ' hace ' || (extract(epoch from now() - p.desde) / 86400)::int ||
         ' d, sin entrega: "entregado #E' || p.id || '" o "cancelado #E' || p.id || '"'
    from p join agente.contactos k on k.id = p.contacto_id
   where p.desde <= now() - interval '24 hours'
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
