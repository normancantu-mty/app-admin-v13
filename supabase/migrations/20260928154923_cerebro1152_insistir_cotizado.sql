-- cerebro-1.15.2 (2026-09-28) — insistir_datos tambien en estado 'cotizado'. Medido en la prueba 7c-1 de la 1.15.1: el
-- cliente dio su nombre y el pedido se quedo en cotizado (no en pidio_entrega), asi que el cron nunca lo veia y el
-- cliente se quedaba sin el recordatorio. El evento 'insistir' guarda el estado real del pedido.
-- Escrito el 2026-09-28 por el Socio (EJECUTOR, dominio Agente mensajeria y envios).
-- DESHACER: reaplicar 20260928150439_cerebro1151_insistir.sql.

create or replace function agente.insistir_datos(p_enviar boolean default true)
returns int language plpgsql security definer set search_path to 'agente', 'net', 'vault', 'public' as $f$
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
       and not exists (select 1 from agente.pedido_eventos ev where ev.pedido_id = p.id and ev.nota = 'insistir')
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
end $f$;
