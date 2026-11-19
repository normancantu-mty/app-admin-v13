-- ============================================================================
-- ROLLBACK de la migracion eliminar_lote (2026-11-19).
-- Escrito el 2026-11-19 por el agente (Cuartel). Correr en UNA transaccion.
--
-- OJO: si ya se elimino algun lote, auditoria_logs tiene filas operacion='DELETE'
-- con la foto completa del lote; el CHECK de dos valores no se puede volver a
-- poner con ellas adentro. Respaldar primero:
--   SELECT * FROM public.auditoria_logs WHERE operacion = 'DELETE';
-- y decidir (este rollback NO las borra: falla si existen).
-- Revertir tambien el deploy web del boton «Eliminar» de /correcciones.
-- ============================================================================
BEGIN;

DROP FUNCTION IF EXISTS public.eliminar_lote(uuid, text, text);

ALTER TABLE public.auditoria_logs DROP CONSTRAINT auditoria_logs_operacion_check;
ALTER TABLE public.auditoria_logs ADD CONSTRAINT auditoria_logs_operacion_check
  CHECK (operacion = ANY (ARRAY['INSERT'::text, 'UPDATE'::text]));

COMMIT;
