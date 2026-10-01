CREATE OR REPLACE FUNCTION agente.insistir_datos(p_enviar boolean DEFAULT true)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agente', 'net', 'vault', 'public'
AS $function$
declare v_clave text; v_min int; v_fbig boolean; r record; n int := 0;
begin
  if not pg_try_advisory_xact_lock(115110) then return 0; end if;
  select coalesce(insistir_min, 7), coalesce(insistir_fbig, false) into v_min, v_fbig
    from agente.cerebro_config order by id limit 1;
  select decrypted_secret into v_clave from vault.decrypted_secrets where name = 'vigia_clave';
  if v_clave is null and p_enviar then return 0; end if;
  for r in
    select p.id, p.contacto_id, p.estado
      from agente.pedidos p
      join agente.contactos k on k.id = p.contacto_id
      cross join lateral (select m.direccion, coalesce(m.origen, '') origen, m.creado_en
                            from agente.mensajes m
                           where m.contacto_id = p.contacto_id and coalesce(m.origen, '') not like '%callado%'
                           order by m.id desc limit 1) u
     where p.estado in ('cotizado', 'pidio_entrega')
       and (k.canal = 'whatsapp' or coalesce(v_fbig, false))
       and u.direccion = 'entrante' and u.origen like 'cliente%:espera%'
       and u.creado_en < now() - make_interval(mins => v_min)
       and u.creado_en > now() - interval '3 hours'
       and not exists (select 1 from agente.preguntas_abiertas q
                        where q.contacto_id = p.contacto_id and q.estado = 'abierta' and q.pausa)
       -- Va2 (j): pg_net manda despues del commit, asi que el evento no sabe si salio. Un reintento como maximo:
       -- solo si el intento anterior tiene mas de 5 min y no dejo NINGUN saliente fijo:insistir (ni el de fallo).
       and (select count(*) from agente.pedido_eventos ev where ev.pedido_id = p.id and ev.nota = 'insistir') < 2
       and not exists (select 1 from agente.pedido_eventos ev where ev.pedido_id = p.id and ev.nota = 'insistir'
                          and (ev.creado_en > now() - interval '5 minutes'
                               or exists (select 1 from agente.mensajes m2 where m2.contacto_id = p.contacto_id
                                           and coalesce(m2.origen, '') like 'fijo:insistir%' and m2.creado_en >= ev.creado_en)))
  loop
    n := n + 1;
    if not p_enviar then continue; end if;
    insert into agente.pedido_eventos (pedido_id, de, a, por, nota)
    values (r.id, r.estado, r.estado, 'cerebro', 'insistir');
    perform net.http_post(
      url := 'https://gnnqxtsdrbvmlkhfemjw.supabase.co/functions/v1/manychat-cerebro?accion=insistir',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-guardian-clave', v_clave),
      body := jsonb_build_object('contacto_id', r.contacto_id),
      timeout_milliseconds := 30000);
  end loop;
  return n;
end $function$
;
