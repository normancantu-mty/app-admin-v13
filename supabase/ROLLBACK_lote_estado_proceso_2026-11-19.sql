-- ============================================================================
-- ROLLBACK de 20261119215907_lote_estado_proceso.sql
-- Escrito el 2026-11-19 por el agente (Cuartel). Correr en UNA transaccion.
--
-- OJO: borrar la columna PIERDE los estados capturados a mano. Respaldo antes:
--   SELECT id, codigo_lote, estado_proceso FROM public.lotes;
-- La app movil y el bot leen/escriben lotes.estado_proceso: revertir tambien
-- su codigo (o fallaran al pedir la columna). El codigo web del commit de la
-- tarea 1 (selector de estado) tambien la pide: revertir ese deploy.
-- ============================================================================
BEGIN;

DROP TRIGGER IF EXISTS trg_lote_estado_por_insumos ON public.lote_entradas;
DROP FUNCTION IF EXISTS public.tg_lote_estado_por_insumos();
DROP FUNCTION IF EXISTS public.lote_tiene_tres_insumos(uuid);

-- ajustar_lote: la definicion anterior (copiada de 20261118192907_v2_correccion_lotes.sql).
CREATE OR REPLACE FUNCTION public.ajustar_lote(
  p_id     uuid,
  p_visto  jsonb,
  p_nuevo  jsonb,
  p_motivo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_llaves constant text[] := ARRAY['codigo_lote', 'fecha_inicio', 'fecha_fin_fermentacion',
                                    'horas_fermentacion', 'brix_chile', 'brix_final', 'notas'];
  v_motivo text := btrim(COALESCE(p_motivo, ''));
  v_act    public.lotes;
  v_vis    public.lotes;
  v_nue    public.lotes;
  v_antes  jsonb;
  v_desp   jsonb;
  v_dif    text[];
  k        text;
BEGIN
  IF public.mi_rol() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'Solo un ADMIN corrige lotes' USING ERRCODE = '42501';
  END IF;
  IF length(v_motivo) < 5 THEN
    RAISE EXCEPTION 'El motivo es obligatorio (minimo 5 caracteres)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_visto IS NULL OR p_nuevo IS NULL
     OR jsonb_typeof(p_visto) <> 'object' OR jsonb_typeof(p_nuevo) <> 'object'
     OR NOT (p_visto ?& c_llaves) OR NOT (p_nuevo ?& c_llaves) THEN
    RAISE EXCEPTION 'Faltan datos: lo visto y lo nuevo traen las 7 llaves de la cabecera' USING ERRCODE = 'check_violation';
  END IF;

  v_vis := jsonb_populate_record(NULL::public.lotes, p_visto);
  v_nue := jsonb_populate_record(NULL::public.lotes, p_nuevo);
  v_nue.codigo_lote := btrim(COALESCE(v_nue.codigo_lote, ''));
  v_nue.notas := NULLIF(btrim(COALESCE(v_nue.notas, '')), '');
  v_vis.notas := NULLIF(btrim(COALESCE(v_vis.notas, '')), '');
  IF v_nue.codigo_lote = '' OR length(v_nue.codigo_lote) > 40 THEN
    RAISE EXCEPTION 'El codigo del lote va de 1 a 40 caracteres' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_act FROM public.lotes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El lote % no existe (o no lo puedes ver)', p_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  v_act.notas := NULLIF(btrim(COALESCE(v_act.notas, '')), '');

  v_antes := jsonb_build_object(
    'codigo_lote', v_act.codigo_lote, 'fecha_inicio', v_act.fecha_inicio,
    'fecha_fin_fermentacion', v_act.fecha_fin_fermentacion, 'horas_fermentacion', v_act.horas_fermentacion,
    'brix_chile', v_act.brix_chile, 'brix_final', v_act.brix_final, 'notas', v_act.notas);

  -- Lo que el usuario vio tiene que ser lo que hay.
  IF v_vis.codigo_lote IS DISTINCT FROM v_act.codigo_lote
     OR v_vis.fecha_inicio IS DISTINCT FROM v_act.fecha_inicio
     OR v_vis.fecha_fin_fermentacion IS DISTINCT FROM v_act.fecha_fin_fermentacion
     OR v_vis.horas_fermentacion IS DISTINCT FROM v_act.horas_fermentacion
     OR v_vis.brix_chile IS DISTINCT FROM v_act.brix_chile
     OR v_vis.brix_final IS DISTINCT FROM v_act.brix_final
     OR v_vis.notas IS DISTINCT FROM v_act.notas THEN
    RAISE EXCEPTION 'CAMBIO_CONCURRENTE: el lote % cambio mientras lo revisabas. Recarga y vuelve a confirmar.',
      v_act.codigo_lote
      USING ERRCODE = '40001';
  END IF;

  v_desp := jsonb_build_object(
    'codigo_lote', v_nue.codigo_lote, 'fecha_inicio', v_nue.fecha_inicio,
    'fecha_fin_fermentacion', v_nue.fecha_fin_fermentacion, 'horas_fermentacion', v_nue.horas_fermentacion,
    'brix_chile', v_nue.brix_chile, 'brix_final', v_nue.brix_final, 'notas', v_nue.notas);

  FOREACH k IN ARRAY c_llaves LOOP
    IF (v_antes -> k) IS DISTINCT FROM (v_desp -> k) THEN
      v_dif := array_append(v_dif, k);
    END IF;
  END LOOP;
  IF v_dif IS NULL THEN
    RAISE EXCEPTION 'SIN_CAMBIO: el lote % ya tiene esos datos', v_act.codigo_lote USING ERRCODE = 'check_violation';
  END IF;

  -- Otro lote ya se llama asi (el alias de otro lo rechaza tg_lote_nombre_libre).
  IF EXISTS (SELECT 1 FROM public.lotes
              WHERE id <> p_id AND upper(btrim(codigo_lote)) = upper(v_nue.codigo_lote)) THEN
    RAISE EXCEPTION 'NOMBRE_OCUPADO: ya existe otro lote %. Usa otro codigo.', v_nue.codigo_lote
      USING ERRCODE = '23505';
  END IF;

  -- El motivo viaja a la bitacora y al alias SOLO en esta transaccion.
  PERFORM set_config('app.motivo_correccion', v_motivo, true);

  UPDATE public.lotes
     SET codigo_lote            = v_nue.codigo_lote,
         fecha_inicio           = v_nue.fecha_inicio,
         fecha_fin_fermentacion = v_nue.fecha_fin_fermentacion,
         horas_fermentacion     = v_nue.horas_fermentacion,
         brix_chile             = v_nue.brix_chile,
         brix_final             = v_nue.brix_final,
         notas                  = v_nue.notas
   WHERE id = p_id;

  PERFORM set_config('app.motivo_correccion', '', true);

  RETURN jsonb_build_object(
    'id', p_id,
    'antes', v_antes,
    'despues', v_desp,
    'cambios', to_jsonb(v_dif),
    'alias', COALESCE((SELECT jsonb_agg(a.alias ORDER BY a.creado_en)
                         FROM public.lote_alias a WHERE a.id_lote = p_id), '[]'::jsonb));
END
$$;

ALTER TABLE public.lotes DROP COLUMN IF EXISTS estado_proceso;

COMMIT;
