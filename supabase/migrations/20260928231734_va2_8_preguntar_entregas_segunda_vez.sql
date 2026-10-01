CREATE OR REPLACE FUNCTION agente.preguntar_entregas(p_prueba boolean DEFAULT false, p_enviar boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'public'
AS $function$
declare v_hoy timestamptz := date_trunc('day', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
        v_ids bigint[]; v_txt text; v_a text; v_b text;
begin
  select array_agg(e.pedido_id order by e.pedido_id),
         string_agg(e.renglon, ' · ' order by e.pedido_id)
    into v_ids, v_txt
    from agente.entregas_pendientes(p_prueba) e
   -- Va2 (l): sin respuesta tambien se vuelve a preguntar al dia siguiente. Maximo 2 preguntas; nunca una 3a.
   where e.preguntas = 0 or (e.preguntas = 1 and e.ultima < v_hoy);
  if v_ids is null then return null; end if;
  v_a := '#E' || v_ids[1];
  v_b := '#E' || v_ids[array_length(v_ids, 1)];
  v_txt := case when p_prueba then '[PRUEBA] ' else '' end || '📦 ¿Se entregaron? ' || v_txt || E'\nContesta: todos · ' ||
           v_a || ' si' || case when v_b <> v_a then ' · ' || v_b || ' no · cancelado ' || v_b
                                else ' · ' || v_a || ' no · cancelado ' || v_a end;
  insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
  select p.id, p.estado, p.estado, 'cerebro', 'pregunta_entrega' from agente.pedidos p where p.id = any(v_ids);
  if p_enviar then perform agente.avisar_grupo(v_txt, null, null, 'principal'); end if;
  return v_txt;
end $function$
;
