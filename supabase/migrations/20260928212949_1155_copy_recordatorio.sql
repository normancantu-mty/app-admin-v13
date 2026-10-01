alter table agente.pedidos add column if not exists copy_enviado_en timestamptz;
alter table agente.pedidos add column if not exists copy_confirmado_en timestamptz;
alter table agente.pedidos add column if not exists copy_recordado_en timestamptz;
alter table agente.cerebro_config add column if not exists recordar_copy_min integer not null default 20;

CREATE OR REPLACE FUNCTION agente.abrir_turno(p_id text, p_canal text, p_nombre text, p_horas integer, p_n integer, p_max_reglas integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  v_nuevo boolean; v_forzar boolean := false; v_conv uuid; v_ultima timestamptz;
  v_reusada boolean := false; v_hist jsonb; v_reglas jsonb; v_cli jsonb;
  v_pausa jsonb; v_cfg jsonb; v_comp jsonb;
begin
  insert into agente.contactos as c (id, canal, nombre, ultimo_visto)
  values (p_id, p_canal, nullif(p_nombre, ''), now())
  on conflict (id) do update
     set ultimo_visto = now(), canal = excluded.canal,
         nombre = coalesce(excluded.nombre, c.nombre)
  returning (xmax = 0) into v_nuevo;

  update agente.contactos set datos = datos - 'forzar_bienvenida'
   where id = p_id and datos ? 'forzar_bienvenida'
  returning true into v_forzar;

  select id, ultima_en into v_conv, v_ultima from agente.conversaciones
   where contacto_id = p_id and estado = 'abierta' order by ultima_en desc limit 1;
  if v_conv is not null and v_ultima > now() - make_interval(hours => p_horas) then
    update agente.conversaciones set ultima_en = now() where id = v_conv;
    v_reusada := true;
  else
    if v_conv is not null then
      update agente.conversaciones set estado = 'cerrada' where id = v_conv;
    end if;
    v_conv := null;
    insert into agente.conversaciones (contacto_id, canal) values (p_id, p_canal)
    on conflict (contacto_id) where estado = 'abierta' do nothing
    returning id into v_conv;
    if v_conv is null then
      select id into v_conv from agente.conversaciones
       where contacto_id = p_id and estado = 'abierta' limit 1;
      v_reusada := true;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('direccion', t.direccion, 'texto', t.texto,
           'en', t.creado_en, 'conv', t.conversacion_id) order by t.creado_en, t.id), '[]'::jsonb)
    into v_hist
    from (select m.direccion, m.texto, m.creado_en, m.id, m.conversacion_id
            from agente.mensajes m
           where m.contacto_id = p_id and m.texto <> ''
             and coalesce(m.origen, '') not like 'puente%'
             and coalesce(m.origen, '') not like '%tarde_fallo%'
             and coalesce(m.origen, '') not like '%callado%'
           order by m.creado_en desc, m.id desc limit p_n) t;

  select coalesce(jsonb_agg(r.texto order by r.prioridad, r.id), '[]'::jsonb) into v_reglas
    from (select texto, prioridad, id from agente.reglas_vivas
           where activa and (quien not like 'prueba%' or p_id like 'prueba\_%')
           order by prioridad, id limit p_max_reglas) r;

  select jsonb_strip_nulls(jsonb_build_object(
           'telefono', c.telefono_e164, 'correo', c.correo, 'ciudad', c.ciudad, 'cp', c.cp,
           'tipo_cliente', c.tipo_cliente, 'origen', c.origen, 'n_pedidos', nullif(c.n_pedidos, 0),
           'ultimo_pedido', c.ultimo_pedido, 'primer_visto', c.primer_visto,
           'pedido_vivo', (select jsonb_strip_nulls(jsonb_build_object('id', p.id, 'estado', p.estado,
                             'items', p.items, 'total', p.total, 'ciudad', p.ciudad, 'domicilio', p.domicilio,
                             'receptor', p.receptor_nombre, 'horario', p.horario, 'metodo_pago', p.metodo_pago))
                             from agente.pedidos p where p.contacto_id = c.id
                              and p.estado in ('contacto','pregunto_precio','dio_talla','cotizado','pidio_entrega','pedido')
                             order by p.id desc limit 1)))
    into v_cli from agente.contactos c where c.id = p_id;

  select jsonb_build_object('id', q.id, 'desde', q.creado_en, 'pregunta', left(q.pregunta, 200))
    into v_pausa from agente.preguntas_abiertas q
   where q.contacto_id = p_id and q.estado = 'abierta' and q.pausa
   order by q.id desc limit 1;

  select to_jsonb(k) - 'id' - 'actualizado_en' into v_cfg from agente.cerebro_config k where k.id = 1;

  select jsonb_build_object('id', x.id, 'clase', x.clase, 'recibido_en', x.recibido_en)
    into v_comp from agente.comprobantes x
   where x.contacto_id = p_id and not x.avisado and x.resultado is null
     and x.recibido_en > now() - interval '2 hours'
   order by x.id desc limit 1;

  return jsonb_build_object('conversacion_id', v_conv, 'reusada', v_reusada, 'nuevo', v_nuevo,
    'forzar', coalesce(v_forzar, false), 'historial', v_hist, 'reglas', v_reglas, 'cliente', v_cli,
    'pausa', v_pausa, 'config', v_cfg, 'comprobante_pendiente', v_comp);
end $function$;
