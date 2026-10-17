-- ============================================================================
-- Cazador de datos · Fase 0 · WP-6 — EL ROL TRABAJADOR DEL BOT
-- ============================================================================
-- Escrita 2026-10-17 por el ejecutor B del Socio.
--
-- ADITIVA PURA: una columna nueva, nullable, con CHECK. No cambia ninguna fila
-- existente (todas quedan en NULL = el comportamiento de hoy).
--
-- ─── POR QUE UNA COLUMNA Y NO UN ROL EN `entidades` ─────────────────────────
-- "La captura es un puesto, no una persona" (bot/LEEME.md; AG-02 prohibe rol
-- nuevo en el ERP). El empleado apunta a la Matriz como Kevin, y lo que lo
-- distingue es lo que el BOT le deja hacer: capturar todo (siempre a
-- aprobacion de Norman o Kevin) y no ver ninguna cifra agregada. Eso lo decide
-- `lib/bot-permisos.ts` leyendo esta columna en `resolverIdentidad`.
--
-- ─── COMO SE DA DE ALTA UN TRABAJADOR ───────────────────────────────────────
--   update public.bot_identidades set rol_bot = 'TRABAJADOR'
--    where etiqueta = '<etiqueta>';
-- (una fila, a mano, como toda alta del bot; lo hace Norman o se le pide.)
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   ALTER TABLE public.bot_identidades DROP COLUMN rol_bot;
-- ============================================================================

ALTER TABLE public.bot_identidades
  ADD COLUMN IF NOT EXISTS rol_bot text
  CHECK (rol_bot IS NULL OR rol_bot = 'TRABAJADOR');

COMMENT ON COLUMN public.bot_identidades.rol_bot IS
  'Cazador F0 (WP-6): NULL = el rol de su entidad (hoy). TRABAJADOR = captura todo a aprobacion (ESPERA_APROBACION hasta VA de Norman o Kevin), ve solo lo suyo, nunca cifras agregadas.';
