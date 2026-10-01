CREATE OR REPLACE FUNCTION agente.marcar_comprobante(p_id bigint, p_resultado text, p_por text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v_c agente.comprobantes; v_ped agente.pedidos; v_de text; v_ya boolean; v_movio boolean := false;
begin
  if p_resultado not in ('pagado','no') then return 'resultado invalido'; end if;
  select * into v_c from agente.comprobantes where id = p_id for update;
  if v_c.id is null then return 'no existe el comprobante ' || p_id; end if;
  if v_c.resultado is not null then
    return 'ya estaba marcado: ' || v_c.resultado || ' (' || coalesce(v_c.validado_por, '?') || ')';
  end if;
  update agente.comprobantes set resultado = p_resultado, validado_por = p_por, validado_en = now()
   where id = p_id;
  if p_resultado = 'no' then return 'comprobante ' || p_id || ' marcado: NO pagado'; end if;

  select * into v_ped from agente.pedidos where id = v_c.pedido_id;
  if v_ped.id is null then
    -- Va2 (c): 'pagado' cuenta como vivo; un segundo comprobante va al MISMO pedido, no abre otro.
    select * into v_ped from agente.pedidos where contacto_id = v_c.contacto_id
       and estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido','pagado')
     order by id desc limit 1;
  end if;
  if v_ped.id is null then
    insert into agente.pedidos (contacto_id, estado) values (v_c.contacto_id, 'pedido') returning * into v_ped;
  end if;
  v_de := v_ped.estado;
  -- la venta ya se conto si otro comprobante pagado apunta a este pedido
  v_ya := exists (select 1 from agente.comprobantes x where x.pedido_id = v_ped.id and x.resultado = 'pagado' and x.id <> p_id);
  if v_de not in ('pagado', 'entregado') then
    begin
      update agente.pedidos set estado = 'pagado', actualizado_en = now() where id = v_ped.id;
      v_movio := true;
    exception when unique_violation then
      v_movio := false;  -- otro pedido vivo del contacto: el estado no se toca, el pago queda como evento
    end;
  end if;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
  values (v_ped.id, v_de, case when v_movio then 'pagado' else v_de end, 'humano',
          'comprobante ' || p_id || ' via ' || p_por || case when v_ya then ' (otro pago del mismo pedido)' else '' end);
  update agente.comprobantes set pedido_id = v_ped.id where id = p_id;
  if not v_ya then
    update agente.contactos set n_pedidos = n_pedidos + 1,
           primer_pedido = coalesce(primer_pedido, now()), ultimo_pedido = now(),
           monto_total = monto_total + coalesce(v_ped.total, 0)
     where id = v_c.contacto_id;
  end if;
  if v_ya then
    return 'pedido ' || v_ped.id || ' ya estaba PAGADO; comprobante ' || p_id || ' ligado a el (no cuenta otra venta)';
  elsif not v_movio then
    return 'pedido ' || v_ped.id || ' sigue ' || v_de || '; comprobante ' || p_id || ' ligado a el';
  end if;
  return 'pedido ' || v_ped.id || ' marcado PAGADO (antes: ' || v_de || ')';
end $function$
;
