-- Fase 0 / paso 1 — Ligar la entidad ADMIN a su usuario de auth.
--
-- `CEO Admin` (entidades) tenia auth_id = NULL aunque su usuario existe en auth.users.
-- Cualquier politica de RLS escrita contra `auth.uid() = entidades.auth_id` dejaria
-- fuera al dueno del sistema. Poblar este auth_id es prerrequisito del prompt 2 (RLS).
--
-- Afecta exactamente 1 fila. No toca ninguna cifra del ledger.

UPDATE entidades
SET auth_id = 'b913b2da-ade1-49e0-a16c-808519cbc8af'
WHERE rol = 'ADMIN' AND email = 'normancantu@gmail.com' AND auth_id IS NULL;
