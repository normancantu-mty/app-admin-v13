-- migracion_cerebro1164_conversacion.sql -- cerebro 1.16.4 (encargo DESDE_SOCIO_prompt_ejecutor_cerebro_1.16.4_conversacion).
-- Escrito el 2026-10-12 por el ejecutor del Socio. NO APLICADO. Probado en Postgres 16 local (cerebro/probar_1164_pg.test.ts).
-- Correr ANTES de desplegar el cerebro 1.16.4: las reglas vivas MANDAN sobre el NUCLEO, y la #34 ("3 a 8 pm") contradice
-- el horario nuevo. Idempotente (correrla dos veces no cambia nada).
-- (1) HORARIO: apaga la regla viva #34 y mete la del horario 3 a 9 pm (quien = 'norman').
-- (2) RETOMAR: agente.marcar_humano ya no reabre la pausa por un mensaje de Norman en FB/IG detectado tarde (ts <= cierre por
--     retoma). Guarda: si la marcar_humano viva no es la que se leyo el 2026-10-12 (md5 de prosrc af34707321bc5a5df13ace696d7cb3ce)
--     ni la de esta migracion, ABORTA todo (alguien la cambio: no se pisa a ciegas).
-- Comprobar despues:
--   select id, activa, apagada_en from agente.reglas_vivas where id = 34 or nota like 'cerebro-1.16.4 horario%';
--   select position('1.16.4' in prosrc) > 0 from pg_proc where oid = 'agente.marcar_humano(text,timestamptz,text)'::regprocedure;

begin;

do $g$
declare v text := (select prosrc from pg_proc where oid = 'agente.marcar_humano(text,timestamptz,text)'::regprocedure);
begin
  if md5(v) <> 'af34707321bc5a5df13ace696d7cb3ce' and position('1.16.4 RETOMAR' in v) = 0 then
    raise exception 'marcar_humano viva distinta a la leida el 2026-10-12 (md5 %): ALTO, no se pisa', md5(v);
  end if;
end $g$;

update agente.reglas_vivas
   set activa = false, apagada_en = now(),
       nota = coalesce(nota || ' | ', '') || '2026-10-12 cerebro-1.16.4: la reemplaza la regla del horario 3 a 9 pm (Norman, chat)'
 where id = 34 and activa;

-- si el DESHACER ya corrio, la regla nueva existe apagada: se vuelve a prender (no se duplica)
update agente.reglas_vivas set activa = true, apagada_en = null
 where nota like 'cerebro-1.16.4 horario%' and not activa;

insert into agente.reglas_vivas (texto, activa, prioridad, quien, nota)
select 'HORARIO DE ENTREGA LOCAL (reemplaza la regla del "3 a 8 pm"): el cliente elige su horario dentro de 3 pm a 9 pm. La frase sale del HECHO DEL SISTEMA (HORARIO DE ENTREGA LOCAL), calculado con la hora real, y usas sus palabras. Si pregunta por el horario o no da hora: "en el horario que prefieras, entre 3 y 9 pm" (si ya pasaron las 3, desde la hora real; nunca "hoy despues de las 3pm" a las 4). Si da una hora o un plazo, se toma SU hora con una ventana de al menos hora y media ("en 1 hora" a las 3:12: "entre 4 y 5:30 pm"; "antes de las 6" a las 4:20: "entre 4:30 y 6 pm"). Si ya no cabe hora y media antes de las 9 pm, igual va hoy hasta las 9 pm (a las 8 pm: "entre 8:30 y 9 pm"); despues de las 8:30 pm: "mañana, en el horario que prefieras, entre 3 y 9 pm". SI LO QUIERE YA ("ahora", "ahorita", "lo antes posible"): una disculpa, "nuestros repartidores ahora se encuentran ocupados", y la ventana del sistema. Siempre "am"/"pm", nunca "15:00".',
       true, 6, 'norman', 'cerebro-1.16.4 horario 3 a 9 pm. Norman en el chat 2026-10-12 ("todo me parece muy bien"; corte 8:30 pm del Socio). Reemplaza la #34. Deshacer: sql/migracion_cerebro1164_conversacion_DESHACER.sql'
 where not exists (select 1 from agente.reglas_vivas where nota like 'cerebro-1.16.4 horario%');

create or replace function agente.marcar_humano(p_contacto text, p_ts timestamp with time zone, p_canal text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'agente', 'public'
as $function$
declare
  pq record; v_id bigint; v_nombre text; v_pref text; v_donde text; v_origen text; v_extra text;
begin
  v_pref := case when p_contacto like 'prueba\_%' then '[PRUEBA] ' else '' end;
  select split_part(coalesce(k.nombre, k.id), ' ', 1) into v_nombre from agente.contactos k where k.id = p_contacto;
  v_nombre := coalesce(v_nombre, p_contacto);
  v_origen := case p_canal when 'whatsapp' then 'norman_wa' when 'facebook' then 'norman_fb'
                           when 'instagram' then 'norman_ig' else 'norman_' || p_canal end;
  v_donde := case p_canal when 'whatsapp' then 'WhatsApp' when 'facebook' then 'Messenger'
                          when 'instagram' then 'Instagram' else p_canal end;
  v_extra := case when p_canal = 'whatsapp' then '' else ' en ' || v_donde end;
  select * into pq from agente.preguntas_abiertas
   where contacto_id = p_contacto and estado = 'abierta' and pausa order by id desc limit 1;
  if pq.id is null then
    -- 1.16.4 RETOMAR NO SE VUELVE A PREGUNTAR (Greice, #P52/#P53): un mensaje de Norman por Messenger/Instagram que se
    -- detecta TARDE (su ts es anterior o igual al cierre por retoma de la ultima pausa) no reabre la pausa ni le pregunta
    -- otra vez. Uno POSTERIOR al retoma si la reabre (Norman: eso esta bien). WhatsApp no cambia (se detecta al momento).
    if p_canal in ('facebook', 'instagram') and p_ts <= (select max(r.cerrada_en) from agente.preguntas_abiertas r
         where r.contacto_id = p_contacto and r.pausa and r.estado = 'cerrada'
           and r.cerrada_por in ('norman_retoma', 'lucia', 'norman')) then
      return 0;
    end if;
    insert into agente.preguntas_abiertas (contacto_id, conversacion_id, canal, tipo, pregunta, pausa, estado, tomada_por,
                                           origen, ultimo_humano_en, avisado_en, recordado_hasta)
    values (p_contacto,
            (select c.id from agente.conversaciones c where c.contacto_id = p_contacto order by c.ultima_en desc limit 1),
            p_canal, 'duda', 'Norman le contesto por ' || v_donde, true, 'abierta', 'norman',
            v_origen, p_ts, now(), p_ts)
    returning id into v_id;
    perform agente.avisar_grupo(v_pref || '✋ Vi que le contestaste a ' || v_nombre || v_extra || '. Me callo con ' ||
      v_nombre || '. ¿La retomo? Contesta: retoma · la sigo yo (#P' || v_id || ')', null, null, 'principal');
    return 1;
  end if;
  update agente.preguntas_abiertas
     set ultimo_humano_en = greatest(coalesce(ultimo_humano_en, p_ts), p_ts),
         recordado_hasta = greatest(coalesce(recordado_hasta, p_ts), p_ts),
         tomada_por = 'norman', origen = coalesce(origen, v_origen),
         avisado_en = case when pq.tomada_por = 'norman' then coalesce(avisado_en, now()) else now() end
   where id = pq.id;
  -- pausa escalada (LucIA esperaba a Norman) y Norman contesto por fuera: se avisa una vez. Si ya era suya, callado.
  if coalesce(pq.tomada_por, '') <> 'norman' then
    perform agente.avisar_grupo(v_pref || '✋ Vi que le contestaste a ' || v_nombre || v_extra ||
      '. Me callo. ¿La retomo? Contesta: retoma · la sigo yo (#P' || pq.id || ')', null, null, 'principal');
    return 1;
  end if;
  return 0;
end $function$;

commit;
