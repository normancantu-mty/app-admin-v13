CREATE OR REPLACE FUNCTION agente.seguimiento_ventas(p_prueba boolean)
 RETURNS TABLE(orden integer, pedido_id bigint, dias integer, linea text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
  with hoy as (select (now() at time zone 'America/Mexico_City')::date d),
  p as (
    select p.*, coalesce(p.avisado_cerrado_en,
             (select min(e.creado_en) from agente.pedido_eventos e where e.pedido_id = p.id and e.a = p.estado),
             p.creado_en) as desde, ep.preguntas, ep.ultima, ep.dijo_no
      from agente.pedidos p join agente.entregas_pendientes(p_prueba) ep on ep.pedido_id = p.id)
  select 4, p.id, (extract(epoch from now() - p.desde) / 86400)::int,
         '📦 Pedido #E' || p.id || ' de ' || coalesce(k.nombre, p.contacto_id) || coalesce(' (' || p.ciudad || ')', '') ||
         ' ' || p.estado || ' hace ' || (extract(epoch from now() - p.desde) / 86400)::int ||
         ' d, sin entrega (te lo pregunte ' || to_char(p.ultima at time zone 'America/Mexico_City', 'DD-MM') ||
         '): "#E' || p.id || ' si" o "cancelado #E' || p.id || '"'
    from p join agente.contactos k on k.id = p.contacto_id, hoy
   where p.preguntas >= 1 and extract(hour from now() at time zone 'America/Mexico_City') >= 21
     and ((p.preguntas = 1 and not p.dijo_no and (p.ultima at time zone 'America/Mexico_City')::date = hoy.d - 1)
          or extract(dow from hoy.d) = 0);
$function$
;
