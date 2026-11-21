-- ============================================================================
-- REGALOS: botellas que la empresa regala en eventos (propaganda), con quien
-- regalo, el motivo y quien capturo; cada regalo BAJA el inventario.
-- Escrito el 2026-11-20 por un ejecutor del Socio (rama feat/regalos-2026-11-20).
-- SIN APLICAR. Orden de despliegue: ESTA MIGRACION PRIMERO, el codigo despues
-- (el codigo nuevo lee `inventario_ledger.id_regalo`; sin la columna, la pagina
-- de Regalos y el bot fallan con error a la vista, no en silencio).
-- ============================================================================
-- POR QUE ASI (investigado contra produccion el 2026-11-20, solo SELECT):
--
--   * El inventario se mueve con el MISMO mecanismo que la merma: filas de
--     `inventario_ledger` con tipo `MERMA`, salida desde la entidad de la
--     matriz, cascada PAGADO -> CONSIGNADO (`lib/salida-cascada.ts`).
--     NO se crea un tipo nuevo (`REGALO`) a proposito: la lista de tipos de
--     salida esta copiada a mano en 6 objetos de la base (v_stock_por_cubeta,
--     v_insumos_en_negativo, v_lote_rendimiento, stock_de_insumos,
--     stock_ajustable, stock_en_cubeta), en ~8 lugares de TypeScript, y en la
--     migracion ERP-11b (rama fix/sobreventa-aviso, sin aplicar) que agrega 6
--     copias mas. Un tipo nuevo que falte en UNA de esas copias da stock
--     equivocado EN SILENCIO. `MERMA` ya esta en todas.
--   * Lo que distingue un regalo de una merma es la columna nueva
--     `inventario_ledger.id_regalo` (FK a `regalos`). Las pantallas de merma
--     excluyen `id_regalo IS NOT NULL`; la cartera de regalos lee SOLO esas.
--   * La cartera sale de las filas ACTIVO del ledger, no de una copia: si
--     alguien anula una fila del regalo con el "Anular" de siempre, el regalo
--     baja solo. Un dato, un lugar.
--   * La escritura es UNA RPC (`registrar_regalo`): encabezado + filas en una
--     sola transaccion. Nada de escrituras a medias.
--   * El ERP AVISA Y NUNCA BLOQUEA (regla de Norman 2026-11-11): la RPC no
--     revisa existencias. El reparto lo calcula TypeScript y, si no alcanza,
--     el faltante sale de PAGADO (queda negativo) y la pantalla lo avisa.
--
-- ROLLBACK (solo si no hay regalos capturados; si los hay, anularlos primero):
--   DROP VIEW IF EXISTS public.v_regalo_lineas;
--   DROP FUNCTION IF EXISTS public.registrar_regalo(jsonb, jsonb);
--   ALTER TABLE public.inventario_ledger DROP CONSTRAINT IF EXISTS inventario_ledger_regalo_es_merma;
--   DROP INDEX IF EXISTS public.inventario_ledger_id_regalo_idx;
--   ALTER TABLE public.inventario_ledger DROP COLUMN IF EXISTS id_regalo;
--   DROP TABLE IF EXISTS public.regalos;
-- ============================================================================

-- ─── 1. El encabezado del regalo ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.regalos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Fecha del regalo (dia de Mexico), no la de captura.
  fecha              date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Mexico_City')::date),
  -- Quien regalo: 'Norman', 'Kevin', 'Gilberto' o texto libre.
  quien_regalo       text NOT NULL CHECK (length(btrim(quien_regalo)) BETWEEN 1 AND 60),
  motivo             text NOT NULL CHECK (length(btrim(motivo)) BETWEEN 3 AND 300),
  -- De que inventario salio (hoy: la matriz).
  id_entidad_origen  uuid NOT NULL REFERENCES public.entidades(id),
  -- Quien lo capturo: lo pone `tg_forzar_autor` con el correo de la sesion
  -- (o `telegram:<etiqueta>` desde el bot, sin sesion).
  usuario_creador    text,
  creado_en          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.regalos IS
  'Regalos de producto (propaganda). Las piezas viven en inventario_ledger (tipo MERMA, id_regalo). Migracion 20261120120000.';

DROP TRIGGER IF EXISTS trg_autor_regalos ON public.regalos;
CREATE TRIGGER trg_autor_regalos
  BEFORE INSERT ON public.regalos
  FOR EACH ROW EXECUTE FUNCTION public.tg_forzar_autor();

DROP TRIGGER IF EXISTS trg_bitacora_regalos ON public.regalos;
CREATE TRIGGER trg_bitacora_regalos
  AFTER INSERT OR UPDATE ON public.regalos
  FOR EACH ROW EXECUTE FUNCTION public.tg_bitacora();

ALTER TABLE public.regalos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS regalos_sel_matriz ON public.regalos;
CREATE POLICY regalos_sel_matriz ON public.regalos
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO', 'EMPLEADO_ADMIN']));

DROP POLICY IF EXISTS regalos_ins_matriz ON public.regalos;
CREATE POLICY regalos_ins_matriz ON public.regalos
  FOR INSERT TO authenticated
  WITH CHECK (public.mi_rol() = ANY (ARRAY['ADMIN', 'EMPLEADO_ADMIN']));
-- Sin UPDATE ni DELETE: un regalo se corrige anulando sus filas del ledger.

GRANT SELECT, INSERT ON public.regalos TO authenticated;
GRANT ALL ON public.regalos TO service_role;


-- ─── 2. El vinculo en el ledger ─────────────────────────────────────────────

ALTER TABLE public.inventario_ledger
  ADD COLUMN IF NOT EXISTS id_regalo uuid REFERENCES public.regalos(id);

CREATE INDEX IF NOT EXISTS inventario_ledger_id_regalo_idx
  ON public.inventario_ledger (id_regalo) WHERE id_regalo IS NOT NULL;

-- Una fila de regalo es SIEMPRE una salida MERMA desde una entidad: asi la
-- cuentan, sin tocarlos, todos los calculos de stock que ya existen.
ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_regalo_es_merma;
ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_regalo_es_merma
  CHECK (id_regalo IS NULL OR (tipo_movimiento = 'MERMA' AND id_entidad_origen IS NOT NULL AND cantidad > 0));


-- ─── 3. La escritura: encabezado + filas en UNA transaccion ─────────────────
-- SECURITY INVOKER: corre con la sesion de quien llama (RLS, autor y bitacora
-- de siempre). Con sesion exige ADMIN o EMPLEADO_ADMIN; sin sesion
-- (service_role = el bot, que ya reviso permisos en su ruta) deja pasar.
--
-- p_regalo:     {"fecha":"2026-11-20","quien_regalo":"Kevin","motivo":"Evento X",
--                "id_entidad_origen":"<uuid>","usuario_creador":"telegram:norman"}
-- p_inventario: [{"id_producto":"<uuid>","cubeta":"PAGADO","cantidad":5,
--                 "costo_unitario_movimiento":120,"notas":"..."}]

CREATE OR REPLACE FUNCTION public.registrar_regalo(p_regalo jsonb, p_inventario jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id        uuid;
  v_entidad   uuid;
  v_fila      jsonb;
  v_cantidad  numeric;
  v_cubeta    text;
  v_tipo      text;
  v_escritas  integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL
     AND public.mi_rol() IS DISTINCT FROM 'ADMIN'
     AND public.mi_rol() IS DISTINCT FROM 'EMPLEADO_ADMIN' THEN
    RAISE EXCEPTION 'Solo la matriz registra regalos' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_regalo) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'registrar_regalo: p_regalo tiene que ser un objeto' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_inventario) IS DISTINCT FROM 'array' OR jsonb_array_length(p_inventario) = 0 THEN
    RAISE EXCEPTION 'registrar_regalo: p_inventario tiene que traer al menos una fila' USING ERRCODE = '22023';
  END IF;

  v_entidad := NULLIF(p_regalo ->> 'id_entidad_origen', '')::uuid;
  IF v_entidad IS NULL THEN
    RAISE EXCEPTION 'registrar_regalo: falta id_entidad_origen' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.regalos (fecha, quien_regalo, motivo, id_entidad_origen, usuario_creador)
  VALUES (
    COALESCE(NULLIF(p_regalo ->> 'fecha', '')::date, (now() AT TIME ZONE 'America/Mexico_City')::date),
    btrim(COALESCE(p_regalo ->> 'quien_regalo', '')),
    btrim(COALESCE(p_regalo ->> 'motivo', '')),
    v_entidad,
    NULLIF(btrim(COALESCE(p_regalo ->> 'usuario_creador', '')), '')
  )
  RETURNING id INTO v_id;

  FOR v_fila IN SELECT * FROM jsonb_array_elements(p_inventario) LOOP
    v_cantidad := (v_fila ->> 'cantidad')::numeric;
    v_cubeta := COALESCE(v_fila ->> 'cubeta', 'PAGADO');
    IF v_cantidad IS NULL OR v_cantidad <= 0 THEN
      RAISE EXCEPTION 'registrar_regalo: cantidad invalida (%)', v_fila ->> 'cantidad' USING ERRCODE = '22023';
    END IF;
    SELECT p.tipo INTO v_tipo FROM public.catalogo_productos p WHERE p.id = (v_fila ->> 'id_producto')::uuid;
    IF v_tipo IS DISTINCT FROM 'TERMINADO' THEN
      RAISE EXCEPTION 'registrar_regalo: solo se regala producto terminado' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.inventario_ledger (
      id_producto, id_entidad_origen, tipo_movimiento, cantidad, cubeta,
      costo_unitario_movimiento, notas, usuario_creador, id_regalo, status
    ) VALUES (
      (v_fila ->> 'id_producto')::uuid,
      v_entidad,
      'MERMA',
      v_cantidad,
      v_cubeta,
      COALESCE((v_fila ->> 'costo_unitario_movimiento')::numeric, 0),
      NULLIF(v_fila ->> 'notas', ''),
      NULLIF(btrim(COALESCE(p_regalo ->> 'usuario_creador', '')), ''),
      v_id,
      'ACTIVO'
    );
    v_escritas := v_escritas + 1;
  END LOOP;

  IF v_escritas <> jsonb_array_length(p_inventario) THEN
    RAISE EXCEPTION 'registrar_regalo: se pidieron % filas y se escribieron %', jsonb_array_length(p_inventario), v_escritas;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_regalo(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_regalo(jsonb, jsonb) TO authenticated, service_role;


-- ─── 4. La lectura: una fila por regalo x producto, solo lo ACTIVO ──────────
-- El costo es el COSTO COMPLETO del ERP (`v_costo_completo.costo_total`:
-- empaque + liquido + mano de obra, el mismo de los margenes), y si un producto
-- no lo tiene, el del catalogo (`catalogo_productos.costo_unitario`). En prod
-- (SELECT del 2026-11-20) el catalogo trae 120 / 0 / 0 para 750 / 250 / 50 ml y
-- el costo completo 132.21 / 41.53 / 13.44: con el catalogo las chicas y minis
-- saldrian "sin costo". Es el costo ACTUAL: si cambia, la cartera se revalua.
-- (Ojo: esta vista depende de `v_costo_completo`; un DROP de esa vista sin
-- CASCADE fallara mientras esta exista.)

CREATE OR REPLACE VIEW public.v_regalo_lineas
  WITH (security_invoker = true) AS
  WITH lineas AS (
    SELECT il.id_regalo, il.id_producto, round(sum(il.cantidad), 4) AS piezas
      FROM public.inventario_ledger il
     WHERE il.id_regalo IS NOT NULL AND il.status = 'ACTIVO'
     GROUP BY il.id_regalo, il.id_producto
  )
  SELECT r.id                    AS id_regalo,
         r.fecha,
         r.quien_regalo,
         r.motivo,
         r.usuario_creador,
         r.creado_en,
         r.id_entidad_origen,
         l.id_producto,
         p.nombre                AS producto,
         p.ml_por_unidad,
         COALESCE(NULLIF(cc.costo_total, 0), p.costo_unitario) AS costo_unitario,
         p.costo_cero_confirmado,
         l.piezas
    FROM public.regalos r
    JOIN lineas l ON l.id_regalo = r.id
    JOIN public.catalogo_productos p ON p.id = l.id_producto
    LEFT JOIN LATERAL (
      SELECT max(v.costo_total) AS costo_total
        FROM public.v_costo_completo v
       WHERE v.id_producto = l.id_producto
    ) cc ON true;

GRANT SELECT ON public.v_regalo_lineas TO authenticated, service_role;


-- ─── Como aplicarla y que comprobar (lo hace Norman o con su palabra) ───────
-- Aplicar: Supabase MCP apply_migration (name: regalos) con este archivo, o
--   psql "<DSN de produccion>" -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261120120000_regalos.sql
-- Comprobar (todo debe dar lo indicado):
--   SELECT to_regclass('public.regalos');                                  -- regalos
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name='inventario_ledger' AND column_name='id_regalo';     -- 1
--   SELECT count(*) FROM public.v_regalo_lineas;                           -- 0
--   SELECT count(*) FROM public.v_stock_por_cubeta;                        -- igual que antes
