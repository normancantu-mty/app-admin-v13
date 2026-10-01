create or replace function agente.cerrar_pedidos_viejos(p_aplicar boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
declare v_ids bigint[]; v_hechos bigint[];
begin
  select coalesce(array_agg(p.id order by p.id), array[]::bigint[]) into v_ids
    from agente.pedidos p
   where p.estado in ('pregunto_precio', 'cotizado')
     and p.actualizado_en < now() - interval '14 days'
     and not exists (select 1 from agente.pedido_eventos e where e.pedido_id = p.id and e.creado_en > now() - interval '14 days')
     and not exists (select 1 from agente.mensajes m where m.contacto_id = p.contacto_id and m.direccion = 'entrante'
                        and m.creado_en > now() - interval '14 days');
  if not p_aplicar or cardinality(v_ids) = 0 then
    return jsonb_build_object('aplicado', false, 'n', cardinality(v_ids), 'ids', to_jsonb(v_ids));
  end if;
  with o as (select id, estado from agente.pedidos
              where id = any(v_ids) and estado in ('pregunto_precio', 'cotizado') for update),
  u as (update agente.pedidos p set estado = 'desaparecio', actualizado_en = now()
          from o where p.id = o.id returning p.id, o.estado),
  ev as (insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
         select u.id, u.estado, 'desaparecio', 'sistema', 'viejo:14d' from u returning pedido_id)
  select coalesce(array_agg(pedido_id order by pedido_id), array[]::bigint[]) into v_hechos from ev;
  return jsonb_build_object('aplicado', true, 'n', cardinality(v_hechos), 'ids', to_jsonb(v_hechos));
end $function$;
revoke all on function agente.cerrar_pedidos_viejos(boolean) from public;
