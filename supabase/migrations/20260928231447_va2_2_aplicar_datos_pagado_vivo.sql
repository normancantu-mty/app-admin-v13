CREATE OR REPLACE FUNCTION agente.aplicar_datos(p_contacto text, p_mensaje bigint, p_extractor text, p_campos jsonb, p_pedido jsonb DEFAULT NULL::jsonb, p_conversacion uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  k text; v text; v_conf numeric; n_datos int := 0;
  orden constant text[] := array['contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido'];
  -- Va2 (c): 'pagado' es pedido vivo hasta entregado o cancelado (mismo criterio que uq_pedido_vivo). No entra a
  -- 'orden': el extractor no puede llevar un pedido a pagado ni sacarlo de ahi.
  vivos constant text[] := array['contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido','pagado'];
  v_ped agente.pedidos; v_nuevo_estado text; v_items jsonb; v_evento boolean := false;
begin
  v_conf := case p_extractor when 'regex' then 0.95 when 'modelo' then 0.7 else 1 end;
  for k, v in select key, value from jsonb_each_text(coalesce(p_campos, '{}'::jsonb)) loop
    continue when v is null or btrim(v) = '';
    continue when exists (select 1 from agente.dato_cliente d
                           where d.contacto_id = p_contacto and d.campo = k
                             and d.id = (select max(id) from agente.dato_cliente
                                          where contacto_id = p_contacto and campo = k)
                             and d.valor = v);
    insert into agente.dato_cliente (contacto_id, campo, valor, confianza, fuente_mensaje_id, extractor)
    values (p_contacto, k, v, v_conf, p_mensaje, p_extractor);
    n_datos := n_datos + 1;
  end loop;

  update agente.contactos c set
    telefono_e164 = coalesce(p_campos->>'telefono', c.telefono_e164),
    correo        = coalesce(p_campos->>'correo', c.correo),
    rfc           = coalesce(p_campos->>'rfc', c.rfc),
    cp            = coalesce(p_campos->>'cp', c.cp),
    ciudad        = coalesce(p_campos->>'ciudad', c.ciudad),
    estado_mx     = coalesce(p_campos->>'estado_mx', c.estado_mx),
    tipo_cliente  = coalesce(p_campos->>'tipo_cliente', c.tipo_cliente),
    genero        = coalesce(p_campos->>'genero', c.genero),
    locale        = coalesce(p_campos->>'locale', c.locale),
    origen        = coalesce(c.origen, p_campos->>'origen')
  where c.id = p_contacto;

  if p_pedido is not null and p_pedido <> '{}'::jsonb then
    select * into v_ped from agente.pedidos
     where contacto_id = p_contacto and estado = any (vivos) order by id desc limit 1;
    if v_ped.id is null then
      insert into agente.pedidos (contacto_id, conversacion_id, origen)
      values (p_contacto, p_conversacion, (select origen from agente.contactos where id = p_contacto))
      on conflict do nothing returning * into v_ped;
      if v_ped.id is null then
        select * into v_ped from agente.pedidos where contacto_id = p_contacto and estado = any (vivos) order by id desc limit 1;
      end if;
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, null, v_ped.estado, 'cerebro', p_mensaje);
    end if;

    v_items := case when jsonb_typeof(p_pedido->'items') = 'array' and jsonb_array_length(p_pedido->'items') > 0
                    then p_pedido->'items' else null end;
    v_nuevo_estado := v_ped.estado;
    if p_pedido->>'estado' = any (orden)
       and array_position(orden, p_pedido->>'estado') > array_position(orden, v_ped.estado) then
      v_nuevo_estado := p_pedido->>'estado';
      v_evento := true;
    end if;

    update agente.pedidos p set
      estado          = v_nuevo_estado,
      items           = coalesce(v_items, p.items),
      total           = coalesce((p_pedido->>'total')::numeric, p.total),
      ciudad          = coalesce(p_pedido->>'ciudad', p.ciudad),
      zona            = coalesce(p_pedido->>'zona', p.zona),
      receptor_nombre = coalesce(p_pedido->>'receptor_nombre', p.receptor_nombre),
      receptor_tel    = coalesce(p_pedido->>'receptor_tel', p.receptor_tel),
      domicilio       = coalesce(p_pedido->>'domicilio', p.domicilio),
      referencias     = coalesce(p_pedido->>'referencias', p.referencias),
      horario         = coalesce(p_pedido->>'horario', p.horario),
      metodo_pago     = coalesce(p_pedido->>'metodo_pago', p.metodo_pago),
      ocasion         = coalesce(p_pedido->>'ocasion', p.ocasion),
      objecion        = coalesce(p_pedido->>'objecion', p.objecion),
      actualizado_en  = now()
    where p.id = v_ped.id;

    if v_evento then
      insert into agente.pedido_eventos (pedido_id, de, a, por, fuente_mensaje_id)
      values (v_ped.id, v_ped.estado, v_nuevo_estado, 'cerebro', p_mensaje);
    end if;
  end if;

  return jsonb_build_object('datos', n_datos, 'pedido_id', v_ped.id, 'estado', v_nuevo_estado,
                            'de', v_ped.estado, 'cambio', v_evento);
end $function$
;
