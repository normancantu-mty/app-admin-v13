-- ============================================================================
-- REGALOS: A QUIEN SE LE DIO. Escrito el 2026-11-25 por el ejecutor de regalos v2
-- del Socio. SIN APLICAR. Norman: «dentro de cada una de las metricas de los
-- distribuidores y locales debe venir uno que se llame Regalos».
--   * `regalos.id_entidad_destino`: el distribuidor o local que lo recibio. Nullable:
--     los regalos de antes, y los de un evento o un cliente, no llevan destino.
--   * NO mueve inventario del que recibe, ni su consignacion, ni su deuda: es un dato
--     del encabezado. Las piezas siguen saliendo de la matriz.
--   * Compatible en los dos sentidos: el codigo de antes no manda la llave (queda
--     NULL) ni lee la columna; el codigo nuevo, sin esta migracion, guarda igual y avisa.
--   * Politicas de `regalos` SIN cambios: solo la matriz lee (ADMIN, SOCIO,
--     EMPLEADO_ADMIN). Un local no ve los suyos ni los de otro.
-- Reversa: sql/9_destino_REVERSA.sql de la propuesta (se detiene si ya hay destinos).
-- ============================================================================

ALTER TABLE public.regalos
  ADD COLUMN IF NOT EXISTS id_entidad_destino uuid REFERENCES public.entidades(id);

CREATE INDEX IF NOT EXISTS regalos_id_entidad_destino_idx
  ON public.regalos (id_entidad_destino) WHERE id_entidad_destino IS NOT NULL;

COMMENT ON COLUMN public.regalos.id_entidad_destino IS
  'A que distribuidor o local se le dio (NULL = a ninguno). No mueve su inventario ni su deuda. Migracion 20261125120000.';

-- La misma funcion de 20261120120000, mas el destino.
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

  INSERT INTO public.regalos (fecha, quien_regalo, motivo, id_entidad_origen, usuario_creador, id_entidad_destino)
  VALUES (
    COALESCE(NULLIF(p_regalo ->> 'fecha', '')::date, (now() AT TIME ZONE 'America/Mexico_City')::date),
    btrim(COALESCE(p_regalo ->> 'quien_regalo', '')),
    btrim(COALESCE(p_regalo ->> 'motivo', '')),
    v_entidad,
    NULLIF(btrim(COALESCE(p_regalo ->> 'usuario_creador', '')), ''),
    NULLIF(btrim(COALESCE(p_regalo ->> 'id_entidad_destino', '')), '')::uuid
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

-- La misma vista, con la columna AL FINAL (CREATE OR REPLACE VIEW no deja otra cosa).
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
         l.piezas,
         r.id_entidad_destino
    FROM public.regalos r
    JOIN lineas l ON l.id_regalo = r.id
    JOIN public.catalogo_productos p ON p.id = l.id_producto;

GRANT SELECT ON public.v_regalo_lineas TO authenticated, service_role;
