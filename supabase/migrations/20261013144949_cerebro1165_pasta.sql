-- migracion_cerebro1165_pasta.sql -- cerebro 1.16.5 PASTA PENDIENTE.
-- Escrito el 2026-10-13 por el ejecutor del Socio (encargo DESDE_SOCIO_prompt_ejecutor_cerebro_1.16.5_pasta_pendiente_2026-10-13.md).
-- NO APLICADA: la corre desplegar_cerebro_v1165_2026-10-13.sh, ANTES del cerebro (la 1.16.5 inserta tipo 'pasta_pendiente').
-- (1) preguntas_abiertas_tipo_check acepta 'pasta_pendiente' (el registro de conversaciones de pasta, pausa=false).
-- (2) indice unico parcial: UNA fila pasta_pendiente ABIERTA por contacto. El cerebro inserta con
--     "on conflict (contacto_id) where tipo = 'pasta_pendiente' and estado = 'abierta' do nothing returning id" y solo avisa
--     al grupo pasta si devolvio id: un aviso por cliente, sin carrera entre dos turnos simultaneos.
-- Idempotente. Leido con SELECT el 2026-10-13: el check vivo es exactamente ['duda','negocio','personalizacion'].
begin;
alter table agente.preguntas_abiertas drop constraint if exists preguntas_abiertas_tipo_check;
alter table agente.preguntas_abiertas add constraint preguntas_abiertas_tipo_check
  check (tipo = any (array['duda'::text, 'negocio'::text, 'personalizacion'::text, 'pasta_pendiente'::text]));
create unique index if not exists ux_preguntas_pasta_abierta on agente.preguntas_abiertas (contacto_id)
  where tipo = 'pasta_pendiente' and estado = 'abierta';
commit;
