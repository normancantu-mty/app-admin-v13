-- ============================================================================
-- v2: correccion de la CABECERA de un lote desde /panel/correcciones (ADMIN),
-- con ALIAS: el nombre anterior de un lote sigue encontrando el lote.
-- Escrito el 2026-11-18 por el agente (Cuartel), rama correcciones-lotes.
-- ============================================================================
-- POR QUE. La nomenclatura de los lotes va a cambiar (Cris, 2026-11-18). Hoy un
-- renombre en `lotes.codigo_lote` rompe al bot: los recordatorios ya enviados
-- ("ltdes:" + codigo), la sesion de etapas y lo que la gente dicta por Telegram
-- traen el nombre VIEJO, y el bot busca por nombre (`.ilike('codigo_lote', ...)`).
-- Regla de Cris: al renombrar, el nombre anterior queda como ALIAS y el bot
-- encuentra el lote por su nombre actual o por cualquiera anterior.
--
-- EL DISENO.
--   * `lote_alias`: un nombre anterior por fila. La escribe SOLO un trigger
--     SECURITY DEFINER (ningun cliente tiene INSERT/UPDATE/DELETE), asi que
--     CUALQUIER ruta de renombre deja su alias: esta pantalla, la edicion
--     existente (/panel/@modal/m/lote/[id]/editar, ADMIN y EMPLEADO_ADMIN) y la
--     app movil. Lectura: los mismos roles que leen `lotes`.
--   * Un nombre (sin distinguir mayusculas ni espacios de los extremos) es de UN
--     solo lote, sea su nombre actual o un alias:
--       - indice unico upper(btrim(codigo_lote)) en `lotes` (antes el unique era
--         sensible a mayusculas: 'l-1' y 'L-1' podian coexistir; verificado en
--         prod el 2026-11-18 que no hay choques);
--       - indice unico upper(btrim(alias)) en `lote_alias`;
--       - el cruce entre las dos tablas lo cierra `tg_lote_nombre_libre`
--         (BEFORE INSERT/UPDATE OF codigo_lote): rechaza tomar el alias de OTRO
--         lote; si el alias es del MISMO lote (volver al nombre anterior) lo borra.
--         Un advisory lock serializa los renombres para que dos sesiones no
--         tomen el mismo nombre a la vez.
--   * `tg_lote_alias` (AFTER UPDATE OF codigo_lote): si el nombre cambio de
--     verdad (no solo mayusculas/espacios) guarda el anterior, con autor
--     (`usuario_de_sesion()`, el email del JWT o 'sistema') y el motivo si la
--     correccion lo trae.
--   * `resolver_lote(nombre)`: el lote por nombre actual o alias. La usa el bot.
--   * `ajustar_lote(...)`: la escritura de la pantalla. SECURITY INVOKER (RLS y
--     triggers de quien llama), revalida ADMIN, bloquea la fila, compara lo que
--     el usuario VIO contra lo actual (CAMBIO_CONCURRENTE) y aplica.
--   * BITACORA: `tg_bitacora` se engancha a `lotes` (AFTER INSERT OR UPDATE,
--     igual que en los ledgers; es compatible: `lotes.id` es uuid y la funcion
--     solo usa NEW.id / to_jsonb). Antes ningun cambio de lote dejaba rastro.
--   * EL MOTIVO: columna nueva `auditoria_logs.motivo`. `tg_bitacora` la llena
--     con `current_setting('app.motivo_correccion', true)`, que `ajustar_lote`
--     fija SOLO para su transaccion (set_config local). Es lo mas simple que
--     conserva el motivo junto al antes/despues, sin tocar `notas` y sin una
--     tabla mas. Fuera de una correccion el ajuste vale NULL y la bitacora
--     queda igual que siempre. El alias tambien guarda el motivo.
--
-- NOMENCLATURA NUEVA (Cris, 2026-11-18): los lotes se llaman con numeros
-- consecutivos simples ("136", "137", ...), capturados a mano. El sistema solo
-- RECOMIENDA el siguiente:
--   * `siguiente_codigo_lote()`: FUENTE UNICA de la recomendacion = 1 + el
--     mayor nombre que sea SOLO digitos ('^\d+$', comparado como numero) entre
--     los nombres actuales Y los alias (un numero ya usado y renombrado no se
--     reusa). Si no hay ninguno numerico devuelve '1' (fallback documentado: hoy
--     los 5 lotes son L-...; Cris probablemente los renombre a numeros y desde
--     ahi sigue). Espejo TypeScript para el bot: `siguienteCodigoNumerico` en
--     lib/lote-alias.ts; espejo Python: formato_codigo '{n}' en lote.yaml.
--   * `tg_lote_codigo_vacio` (BEFORE INSERT): si `codigo_lote` llega NULL,
--     vacio o solo espacios, pone `siguiente_codigo_lote()`. Cubre la web, el
--     bot, la app movil y el bot Python sin redeploy. El NOT NULL no estorba:
--     Postgres revisa NOT NULL DESPUES de los triggers BEFORE ROW. Corre antes
--     que `trg_lote_nombre_libre` (orden alfabetico: 'codigo' < 'nombre') y
--     toma el mismo advisory lock, asi dos altas simultaneas con vacio no
--     calculan el mismo numero. Si aun asi chocan (alguien dicto a mano el
--     mismo numero), el indice unico normalizado lo rechaza (23505) y la capa
--     de arriba pide reintentar.
--
-- LO QUE NO HACE: no edita etapas (`lote_etapas`); no reescribe textos
-- historicos que nombran el lote (p. ej. notas 'ENVASADO lote X' del
-- inventario_ledger): son registro de lo que paso con el nombre de entonces.
--
-- ROLLBACK: supabase/ROLLBACK_correccion_lotes_2026-11-18.sql
-- ============================================================================


-- ─── 1. UN NOMBRE = UN LOTE (sin distinguir mayusculas) ─────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS lotes_codigo_lote_normalizado_key
  ON public.lotes (upper(btrim(codigo_lote)));


-- ─── 2. LOS NOMBRES ANTERIORES ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lote_alias (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_lote   uuid NOT NULL REFERENCES public.lotes(id) ON DELETE CASCADE,
  alias     text NOT NULL CHECK (btrim(alias) <> ''),
  creado_en timestamptz NOT NULL DEFAULT now(),
  autor     text,
  motivo    text
);

CREATE UNIQUE INDEX IF NOT EXISTS lote_alias_normalizado_key
  ON public.lote_alias (upper(btrim(alias)));
CREATE INDEX IF NOT EXISTS lote_alias_id_lote_idx ON public.lote_alias (id_lote);

ALTER TABLE public.lote_alias ENABLE ROW LEVEL SECURITY;

-- Lee quien lee `lotes` (lotes_sel_admin_socio + lotes_sel_empleado).
DROP POLICY IF EXISTS lote_alias_sel ON public.lote_alias;
CREATE POLICY lote_alias_sel ON public.lote_alias
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO', 'EMPLEADO_ADMIN']));

-- Nadie escribe directo: solo los triggers (SECURITY DEFINER).
REVOKE ALL ON public.lote_alias FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.lote_alias TO authenticated, service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gia_lectura') THEN
    GRANT SELECT ON public.lote_alias TO gia_lectura;  -- como en `lotes`
  END IF;
END
$$;


-- ─── 3. EL NOMBRE NUEVO ESTA LIBRE (cruce lotes <-> lote_alias) ─────────────

CREATE OR REPLACE FUNCTION public.tg_lote_nombre_libre() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_norm  text := upper(btrim(NEW.codigo_lote));
  v_dueno uuid;
  v_otro  text;
BEGIN
  IF TG_OP = 'UPDATE' AND upper(btrim(OLD.codigo_lote)) = v_norm THEN
    RETURN NEW;  -- mismo nombre (a lo sumo mayusculas/espacios): nada que revisar
  END IF;

  -- Serializa los cambios de nombre: dos sesiones no toman el mismo a la vez.
  PERFORM pg_advisory_xact_lock(hashtext('lotes:nombres'));

  SELECT a.id_lote, l.codigo_lote INTO v_dueno, v_otro
    FROM public.lote_alias a
    JOIN public.lotes l ON l.id = a.id_lote
   WHERE upper(btrim(a.alias)) = v_norm;

  IF v_dueno IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND v_dueno = NEW.id THEN
      -- Vuelve a un nombre anterior suyo: deja de ser alias (es el actual).
      DELETE FROM public.lote_alias WHERE id_lote = NEW.id AND upper(btrim(alias)) = v_norm;
    ELSE
      RAISE EXCEPTION 'NOMBRE_OCUPADO: % es un nombre anterior del lote %. Usa otro codigo.',
        btrim(NEW.codigo_lote), v_otro
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.tg_lote_nombre_libre() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_lote_nombre_libre ON public.lotes;
CREATE TRIGGER trg_lote_nombre_libre
  BEFORE INSERT OR UPDATE OF codigo_lote ON public.lotes
  FOR EACH ROW EXECUTE FUNCTION public.tg_lote_nombre_libre();


-- ─── 4. EL NOMBRE ANTERIOR QUEDA COMO ALIAS ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_lote_alias() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF upper(btrim(OLD.codigo_lote)) IS DISTINCT FROM upper(btrim(NEW.codigo_lote)) THEN
    INSERT INTO public.lote_alias (id_lote, alias, autor, motivo)
    VALUES (NEW.id, btrim(OLD.codigo_lote), public.usuario_de_sesion(),
            NULLIF(current_setting('app.motivo_correccion', true), ''));
  END IF;
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION public.tg_lote_alias() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_lote_alias ON public.lotes;
CREATE TRIGGER trg_lote_alias
  AFTER UPDATE OF codigo_lote ON public.lotes
  FOR EACH ROW EXECUTE FUNCTION public.tg_lote_alias();


-- ─── 5. BITACORA DE LOTES, CON MOTIVO ───────────────────────────────────────

ALTER TABLE public.auditoria_logs ADD COLUMN IF NOT EXISTS motivo text;

-- Copia de la definicion vigente (verificada en prod el 2026-11-18) con UN
-- cambio: llena `motivo` desde el ajuste local de la transaccion.
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
    (tabla, id_registro, operacion, usuario, rol, datos_antes, datos_despues, motivo)
  VALUES
    (TG_TABLE_NAME, NEW.id, TG_OP, public.usuario_de_sesion(), public.mi_rol(),
     v_antes, to_jsonb(NEW), NULLIF(current_setting('app.motivo_correccion', true), ''));

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bitacora_lotes ON public.lotes;
CREATE TRIGGER trg_bitacora_lotes
  AFTER INSERT OR UPDATE ON public.lotes
  FOR EACH ROW EXECUTE FUNCTION public.tg_bitacora();


-- ─── 6. LECTURA: EL LOTE POR NOMBRE ACTUAL O ANTERIOR ───────────────────────

CREATE OR REPLACE FUNCTION public.resolver_lote(p_nombre text)
RETURNS SETOF public.lotes
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT l.*
    FROM public.lotes l
   WHERE upper(btrim(l.codigo_lote)) = upper(btrim(p_nombre))
      OR EXISTS (SELECT 1 FROM public.lote_alias a
                  WHERE a.id_lote = l.id
                    AND upper(btrim(a.alias)) = upper(btrim(p_nombre)));
$$;
REVOKE ALL ON FUNCTION public.resolver_lote(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolver_lote(text) TO authenticated, service_role;


-- ─── 6b. NOMENCLATURA: EL SIGUIENTE NUMERO, Y VACIO = RECOMENDADO ──────────

CREATE OR REPLACE FUNCTION public.siguiente_codigo_lote()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
  SELECT (COALESCE(max(n), 0) + 1)::text
    FROM (
      SELECT btrim(codigo_lote)::numeric AS n FROM public.lotes
       WHERE btrim(codigo_lote) ~ '^\d+$'
      UNION ALL
      SELECT btrim(alias)::numeric FROM public.lote_alias
       WHERE btrim(alias) ~ '^\d+$'
    ) t;
$$;
REVOKE ALL ON FUNCTION public.siguiente_codigo_lote() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.siguiente_codigo_lote() TO authenticated, service_role;

-- SECURITY DEFINER: ve TODOS los lotes y alias aunque quien inserta no los lea.
CREATE OR REPLACE FUNCTION public.tg_lote_codigo_vacio() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.codigo_lote IS NULL OR btrim(NEW.codigo_lote) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('lotes:nombres'));
    NEW.codigo_lote := public.siguiente_codigo_lote();
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION public.tg_lote_codigo_vacio() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_lote_codigo_vacio ON public.lotes;
CREATE TRIGGER trg_lote_codigo_vacio
  BEFORE INSERT ON public.lotes
  FOR EACH ROW EXECUTE FUNCTION public.tg_lote_codigo_vacio();


-- ─── 7. ESCRITURA: LA CORRECCION DEL ADMIN ──────────────────────────────────
-- p_visto y p_nuevo traen las 7 llaves de la cabecera (codigo_lote,
-- fecha_inicio, fecha_fin_fermentacion, horas_fermentacion, brix_chile,
-- brix_final, notas). Se leen con jsonb_populate_record: quedan con el TIPO de
-- la columna (fecha, numeric), asi '12.5' y 12.50 son lo mismo.

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
REVOKE ALL ON FUNCTION public.ajustar_lote(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajustar_lote(uuid, jsonb, jsonb, text) TO authenticated;
