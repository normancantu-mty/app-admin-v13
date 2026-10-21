-- migracion_cerebro1172.sql -- cerebro 1.17.2: recompra hereda datos (B) y pregunta de entrega al terminar la ventana (C).
-- Escrito el 2026-10-17 por el ejecutor del Socio (encargo DESDE_SOCIO_prompt_ejecutor_cerebro_1.17.2_recompra_y_cierre_por_ventana_2026-10-17.md).
-- NO APLICADO. Probado en Postgres 16 local (cerebro/probar_1172_pg.test.ts) sobre la 1.17.1 (migracion_cerebro1171.sql) con la
-- agente.avisar_grupo y la agente.aplicar_datos VIVAS (md5 leido por SELECT el 2026-10-17).
--
-- Lo nuevo (no toca NINGUNA funcion existente):
-- (B) pedidos.heredado_de / heredado_campos + agente.heredar_entregado(p_pedido, p_modo): el pedido que NACE para un contacto con
--     un pedido 'entregado' en los ultimos 120 dias llena lo que no trae (NULL) de ese entregado: receptor_nombre, receptor_tel,
--     metodo_pago siempre; ciudad, zona, referencias, ubicacion_url y domicilio solo si el cliente no dio un domicilio distinto
--     (p_modo 'sin' | 'igual'; 'nuevo' = dio otro). En 'igual' el domicilio se toma del entregado (es el mismo, completo).
--     Nunca items, horario, entrega_fecha ni totales. Una sola vez por pedido (heredado_de is null).
--     agente.desheredar_domicilio(p_pedido): el pedido que heredo el domicilio y despues recibe OTRO suelta referencias,
--     ubicacion_url y zona heredadas (solo si siguen iguales a las del entregado).
-- (C) agente.ventana_preguntas (una fila por pedido = candado) + agente.ventana_avisar(): candado + cola pg_net (avisar_grupo) +
--     fila en agente.cierre_paginas (n = -pedido_id) en UNA sentencia. La fila en cierre_paginas hace que el verificador de la
--     1.17.1 (avisos_verificar) confirme/reenvie/abandone la pregunta igual que una pagina del cierre, sin tocarlo.
-- Guarda: ABORTA si aplicar_datos, avisar_grupo, cierre_pendientes o avisos_verificar no son las vivas leidas el 2026-10-17, o si
-- falta la 1.17.1 (cierre_paginas / aviso_no_sale).
-- Comprobar despues:
--   select agente.heredar_entregado(0, 'sin');          -- {"de": null}
--   select count(*) from agente.ventana_preguntas;       -- 0

begin;

do $g$
declare
  h text;
  esperado constant jsonb := jsonb_build_object(
    'aplicar_datos', '84aa1d922e7ba38851247cc99b409d22',
    'avisar_grupo', 'b3dceae20c7fb2780d4817625b499750',
    'cierre_pendientes', 'df658f9dcddd6180b35a5b03524409c0',
    'avisos_verificar', '1549dab279b192ebd3c9f396a5e271eb');
  k text;
begin
  for k in select jsonb_object_keys(esperado) loop
    select md5(replace(p.prosrc, chr(13), '')) into h from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'agente' and p.proname = k;
    if h is null then raise exception 'agente.% NO EXISTE: ALTO', k; end if;
    if h <> esperado->>k then raise exception 'agente.% viva distinta a la leida el 2026-10-17 (md5 %): ALTO', k, h; end if;
  end loop;
  if to_regclass('agente.cierre_paginas') is null or to_regprocedure('agente.aviso_no_sale(text)') is null then
    raise exception 'la 1.17.1 no esta aplicada (cierre_paginas / aviso_no_sale): ALTO';
  end if;
end $g$;

-- (B) de donde vino lo heredado (el aviso y el reporte del copy lo dicen en una linea)
alter table agente.pedidos
  add column if not exists heredado_de bigint,
  add column if not exists heredado_campos text[];

CREATE OR REPLACE FUNCTION agente.heredar_entregado(p_pedido bigint, p_modo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare
  n agente.pedidos; o agente.pedidos; c text[] := '{}'; dir boolean := p_modo in ('sin', 'igual');
begin
  select * into n from agente.pedidos where id = p_pedido for update;
  if n.id is null or n.heredado_de is not null or n.estado in ('entregado', 'cancelado') then
    return jsonb_build_object('de', null);
  end if;
  select p.* into o from agente.pedidos p
   where p.contacto_id = n.contacto_id and p.id < n.id and p.estado = 'entregado'
     and coalesce((select max(e.creado_en) from agente.pedido_eventos e where e.pedido_id = p.id and e.a = 'entregado'),
                  p.actualizado_en) >= now() - interval '120 days'
   order by p.id desc limit 1;
  if o.id is null then return jsonb_build_object('de', null); end if;
  if dir then
    if o.domicilio is not null and (n.domicilio is null or (p_modo = 'igual' and n.domicilio is distinct from o.domicilio)) then
      c := c || 'domicilio'::text;
    end if;
    if n.referencias is null and o.referencias is not null then c := c || 'referencias'::text; end if;
    if n.ubicacion_url is null and o.ubicacion_url is not null then c := c || 'ubicacion_url'::text; end if;
    if n.ciudad is null and o.ciudad is not null then c := c || 'ciudad'::text; end if;
    if n.zona is null and o.zona is not null then c := c || 'zona'::text; end if;
  end if;
  if n.receptor_nombre is null and o.receptor_nombre is not null then c := c || 'receptor_nombre'::text; end if;
  if n.receptor_tel is null and o.receptor_tel is not null then c := c || 'receptor_tel'::text; end if;
  if n.metodo_pago is null and o.metodo_pago is not null then c := c || 'metodo_pago'::text; end if;
  if cardinality(c) = 0 then return jsonb_build_object('de', o.id, 'campos', '[]'::jsonb); end if;
  update agente.pedidos set
    domicilio       = case when 'domicilio' = any(c) then o.domicilio else domicilio end,
    referencias     = case when 'referencias' = any(c) then o.referencias else referencias end,
    ubicacion_url   = case when 'ubicacion_url' = any(c) then o.ubicacion_url else ubicacion_url end,
    ciudad          = case when 'ciudad' = any(c) then o.ciudad else ciudad end,
    zona            = case when 'zona' = any(c) then o.zona else zona end,
    receptor_nombre = case when 'receptor_nombre' = any(c) then o.receptor_nombre else receptor_nombre end,
    receptor_tel    = case when 'receptor_tel' = any(c) then o.receptor_tel else receptor_tel end,
    metodo_pago     = case when 'metodo_pago' = any(c) then o.metodo_pago else metodo_pago end,
    heredado_de = o.id, heredado_campos = c, actualizado_en = now()
  where id = n.id;
  return jsonb_build_object('de', o.id, 'campos', to_jsonb(c));
end $function$;

CREATE OR REPLACE FUNCTION agente.desheredar_domicilio(p_pedido bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare n agente.pedidos; o agente.pedidos; q text[] := '{}';
begin
  select * into n from agente.pedidos where id = p_pedido for update;
  if n.id is null or n.heredado_de is null or not ('domicilio' = any(coalesce(n.heredado_campos, '{}'))) then
    return jsonb_build_object('quitados', '[]'::jsonb);
  end if;
  select * into o from agente.pedidos where id = n.heredado_de;
  if 'referencias' = any(n.heredado_campos) and n.referencias is not distinct from o.referencias then q := q || 'referencias'::text; end if;
  if 'ubicacion_url' = any(n.heredado_campos) and n.ubicacion_url is not distinct from o.ubicacion_url then q := q || 'ubicacion_url'::text; end if;
  if 'zona' = any(n.heredado_campos) and n.zona is not distinct from o.zona then q := q || 'zona'::text; end if;
  update agente.pedidos set
    referencias   = case when 'referencias' = any(q) then null else referencias end,
    ubicacion_url = case when 'ubicacion_url' = any(q) then null else ubicacion_url end,
    zona          = case when 'zona' = any(q) then null else zona end,
    heredado_campos = array(select x from unnest(n.heredado_campos) x
                             where x <> 'domicilio' and not (x = any(q))),
    actualizado_en = now()
  where id = n.id;
  return jsonb_build_object('quitados', to_jsonb(q || 'domicilio'::text));
end $function$;

-- (C) una fila por pedido preguntado al terminar su ventana: es el candado (PK) y lo que el cierre de ese dia excluye
create table if not exists agente.ventana_preguntas (
  pedido_id bigint primary key,
  fecha date not null,
  fin timestamptz,
  prueba boolean not null,
  texto text not null,
  request_id bigint,
  creado_en timestamptz not null default now()
);
alter table agente.ventana_preguntas enable row level security;

-- candado + cola + fila de entrega, atomico. {nuevo:false} = ya se pregunto (no se manda nada).
CREATE OR REPLACE FUNCTION agente.ventana_avisar(p_pedido bigint, p_fecha date, p_fin timestamptz, p_prueba boolean, p_texto text,
  p_botones jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v bigint; v_req bigint; v_bot jsonb;
begin
  insert into agente.ventana_preguntas (pedido_id, fecha, fin, prueba, texto)
  values (p_pedido, p_fecha, p_fin, p_prueba, p_texto)
  on conflict do nothing returning pedido_id into v;
  if v is null then return jsonb_build_object('nuevo', false); end if;
  -- un "botones": null de JSON NO es NULL de SQL (como cierre_enviar)
  v_bot := case when jsonb_typeof(p_botones) = 'array' then p_botones end;
  v_req := agente.avisar_grupo(p_texto, v_bot, null, 'principal');
  update agente.ventana_preguntas set request_id = v_req where pedido_id = p_pedido;
  -- la entrega la verifica avisos_verificar (1.17.1): n negativo = pregunta de ventana, nunca choca con las paginas 1..N
  insert into agente.cierre_paginas (fecha, prueba, n, texto, botones, request_id, confirmada_en)
  values (p_fecha, p_prueba, -p_pedido::int, p_texto, v_bot, v_req,
          case when v_req is null and agente.aviso_no_sale(p_texto) then now() end)
  on conflict do nothing;
  return jsonb_build_object('nuevo', true, 'request_id', v_req);
end $function$;

commit;
