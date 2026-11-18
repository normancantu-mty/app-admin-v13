-- ============================================================================
-- ROLLBACK de 20261118192907_v2_correccion_lotes.sql
-- Escrito el 2026-11-18 por el agente (Cuartel). Correr en UNA transaccion.
--
-- OJO: borrar `lote_alias` PIERDE los nombres anteriores: el bot dejara de
-- encontrar un lote por un nombre viejo. Si ya hubo renombres, primero
-- respalda: SELECT l.codigo_lote, a.* FROM lote_alias a JOIN lotes l ON l.id = a.id_lote;
-- La columna auditoria_logs.motivo se borra con lo que tenga (respaldar igual:
-- SELECT id, motivo FROM auditoria_logs WHERE motivo IS NOT NULL;).
-- El codigo TypeScript de la rama correcciones-lotes llama a resolver_lote y lee
-- lote_alias: revertir tambien ese deploy (o el bot fallara al buscar lotes).
-- ============================================================================
BEGIN;

DROP FUNCTION IF EXISTS public.ajustar_lote(uuid, jsonb, jsonb, text);
DROP FUNCTION IF EXISTS public.resolver_lote(text);

-- Sin este trigger, un alta con codigo vacio vuelve a fallar por NOT NULL / la
-- validacion de la capa de arriba (revertir tambien el codigo de la rama).
DROP TRIGGER IF EXISTS trg_lote_codigo_vacio ON public.lotes;
DROP FUNCTION IF EXISTS public.tg_lote_codigo_vacio();
DROP FUNCTION IF EXISTS public.siguiente_codigo_lote();

DROP TRIGGER IF EXISTS trg_bitacora_lotes ON public.lotes;
DROP TRIGGER IF EXISTS trg_lote_alias ON public.lotes;
DROP TRIGGER IF EXISTS trg_lote_nombre_libre ON public.lotes;
DROP FUNCTION IF EXISTS public.tg_lote_alias();
DROP FUNCTION IF EXISTS public.tg_lote_nombre_libre();

-- tg_bitacora: la definicion anterior (verificada en prod el 2026-11-18).
CREATE OR REPLACE FUNCTION public.tg_bitacora()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_antes jsonb;
BEGIN
  IF TG_TABLE_NAME = 'auditoria_logs' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_antes := to_jsonb(OLD);
  END IF;

  INSERT INTO public.auditoria_logs
    (tabla, id_registro, operacion, usuario, rol, datos_antes, datos_despues)
  VALUES
    (TG_TABLE_NAME, NEW.id, TG_OP, public.usuario_de_sesion(), public.mi_rol(),
     v_antes, to_jsonb(NEW));

  RETURN NULL;
END;
$function$;

ALTER TABLE public.auditoria_logs DROP COLUMN IF EXISTS motivo;

DROP TABLE IF EXISTS public.lote_alias;
DROP INDEX IF EXISTS public.lotes_codigo_lote_normalizado_key;

COMMIT;
