-- FASE 9 — BLOQUE C (D94, D95, D98): LOS GRUPOS DE TELEGRAM.
--
-- Todo aditivo. Nada reescribe filas:
--
-- 1. D94 — `bot_borradores.chat_id`: la identidad pasa a ser la PERSONA
--    (`telegram_id` = el usuario que habla, `effective_user.id`) y el chat donde
--    hablo viaja aparte. En privado chat_id == telegram_id, como hasta hoy; en un
--    grupo son distintos. Nullable: las 171 filas viejas se quedan como estan
--    (en ellas el chat ERA la persona).
--
-- 2. D95/D98 — `bot_identidades.requiere_aprobacion`: Kevin propone todo lo que
--    propone Norman, pero su VA no escribe: espera el Aprobar de Norman. Es una
--    marca en la IDENTIDAD, no un rol nuevo en `entidades` (Kevin apunta a la
--    Matriz, `20260912163850:48-50`). Default false: la fila de Norman no cambia.
--
-- 3. D98 — `ESPERA_APROBACION` en el check de `bot_borradores.estado`: el
--    borrador de Kevin con su VA dado, esperando a Norman. Se agrega al check;
--    las filas existentes siguen cumpliendolo (el check solo se amplia).

alter table public.bot_borradores
  add column if not exists chat_id bigint;

comment on column public.bot_borradores.chat_id is
  'Chat de Telegram donde se propuso (FASE 9, D94). En privado = telegram_id; en un grupo, el grupo. NULL en filas anteriores a la Fase 9.';

alter table public.bot_identidades
  add column if not exists requiere_aprobacion boolean not null default false;

comment on column public.bot_identidades.requiere_aprobacion is
  'FASE 9 (D98): su VA no escribe; el borrador pasa a ESPERA_APROBACION y lo escribe el Aprobar de un ADMIN sin esta marca.';

alter table public.bot_borradores
  drop constraint if exists bot_borradores_estado_check;

alter table public.bot_borradores
  add constraint bot_borradores_estado_check
  check (estado = any (array['PENDIENTE'::text, 'CONFIRMADO'::text, 'CANCELADO'::text, 'ESPERA_APROBACION'::text]));
