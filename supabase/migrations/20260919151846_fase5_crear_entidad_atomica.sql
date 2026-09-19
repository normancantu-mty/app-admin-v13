-- ===========================================================================
--  AG-06 Fase 5 · el ALTA de una entidad, en UNA transaccion
-- ===========================================================================
--  Escrito el 2026-09-19. Tercera pieza de la misma familia que
--  `registrar_venta_atomica` (ERP-11) y `anular_ticket_atomica`.
--
-- ---------------------------------------------------------------------------
--  1. EL DEFECTO
-- ---------------------------------------------------------------------------
--  `registrarEntidadAction` (`app/actions/distribuidores.ts`) hace TRES
--  escrituras sin transaccion: el usuario de Auth (solo si es DST), la fila de
--  `entidades`, y la fila de `cuentas_financieras`.
--
--  Lo que tiene hoy para las dos ultimas es una compensacion a mano: si la
--  cuenta falla, **BORRA la entidad**. Eso funciona cuando el DELETE funciona;
--  la leccion de ERP-66 es que un DELETE denegado por RLS no da error, devuelve
--  cero filas. Y si el proceso muere entre las dos, no corre ninguna
--  compensacion y queda **una entidad sin ninguna cuenta**:
--
--      · no puede recibir ningun movimiento — `finanzas_ledger` se asienta
--        contra `cuentas_financieras`, no contra `entidades`;
--      · aparece en el desplegable de compradores, asi que se puede escoger;
--      · y `leerCuentaDelDeudor` la rechaza con "no tiene ninguna cuenta dada
--        de alta", que es un mensaje correcto sobre un estado que nunca
--        debio existir.
--
--  Con esta funcion las dos filas de base entran juntas o no entra ninguna, y
--  la compensacion por DELETE desaparece en vez de arreglarse.
--
-- ---------------------------------------------------------------------------
--  2. LO QUE ESTA FUNCION **NO** HACE: el usuario de Auth
-- ---------------------------------------------------------------------------
--  `auth.admin.createUser()` es una llamada HTTP al servidor de Auth de
--  Supabase, y **eso no cabe dentro de una transaccion de Postgres**. Sigue
--  pasando fuera, ANTES, y sigue borrandose en el `catch` si esta funcion
--  lanza. Es el mismo orden de hoy y es el correcto: un usuario de Auth
--  huerfano se borra; una entidad sin cuenta, no.
--
-- ---------------------------------------------------------------------------
--  3. LAS MISMAS DOS DECISIONES DE ERP-11
-- ---------------------------------------------------------------------------
--  (a) **`SECURITY INVOKER`, nunca `DEFINER`.** El dueno seria `postgres`, con
--      `rolbypassrls = true`. Con `DEFINER`, esta funcion dejaria a CUALQUIERA
--      con sesion crear entidades con cualquier rol y cualquier comision,
--      saltandose la politica `entidades_ins_admin`. Con `INVOKER` sigue
--      mandando el RLS de quien llama.
--
--      ⚠ Y por eso el bot, que entra con `service_role` y por lo tanto SE SALTA
--      ese RLS, tiene que comprobar el rol ADMIN en TypeScript
--      (`lib/entidad-servidor.ts`). La funcion no lo hace, y no debe hacerlo:
--      un permiso escrito en dos idiomas es un permiso que algun dia discrepa.
--
--  (b) **Ni una regla de negocio aqui.** La normalizacion de la comision, el
--      rol permitido, la zona valida y la busqueda de duplicados por nombre se
--      quedan en TypeScript. Esta funcion escribe lo que le dan.
--
-- ---------------------------------------------------------------------------
--  4. EL CONTRATO
-- ---------------------------------------------------------------------------
--  · `p_entidad` — objeto. UNA fila de `entidades`. Las columnas se listan una
--                  por una a proposito (misma razon que ERP-11): con
--                  `jsonb_populate_record` cada columna ausente entraria como
--                  NULL, ATROPELLANDO los DEFAULT de la tabla — y aqui eso
--                  significaria `comision_base` NULL en vez de 0.00, o
--                  `aplica_redondeo_costo` NULL en vez de true.
--  · `p_cuenta`  — objeto. La cuenta que nace con la entidad. `id_entidad` lo
--                  FUERZA la funcion: lo que venga en el JSON se ignora, para
--                  que nadie pueda colgarle una cuenta a una entidad ajena.
--                  **Es exactamente una**, y el TypeScript solo manda
--                  `Efectivo (<nombre>)` con `tipo_fiscalidad = 'LIBRE'`. Una
--                  cuenta fiscal creada desde aqui entraria despues al veto de
--                  `cuentaUsableporElBot` y a la deteccion de "fresnillo" de la
--                  maquina de impuestos: no se crean por chat.
--
-- ---------------------------------------------------------------------------
--  5. COMO SE VUELVE ATRAS
-- ---------------------------------------------------------------------------
--    DROP FUNCTION public.crear_entidad_atomica(jsonb, jsonb);
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.crear_entidad_atomica(
  p_entidad jsonb,
  p_cuenta  jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER              -- ver punto 3(a). NO cambiar a DEFINER.
SET search_path = public
AS $$
DECLARE
  v_entidad_id uuid;
  v_escritas   integer;
BEGIN
  IF jsonb_typeof(p_entidad) <> 'object' OR jsonb_typeof(p_cuenta) <> 'object' THEN
    RAISE EXCEPTION 'alta de entidad: p_entidad y p_cuenta tienen que ser objetos'
      USING ERRCODE = '22023';
  END IF;

  -- ── 1. La entidad ─────────────────────────────────────────────────────────
  INSERT INTO public.entidades (
    nombre, rol, zona, email, auth_id, telefono, ubicacion_maps,
    es_distribuidor, id_nodo_padre, id_padre,
    comision_base, comision_base_local, comision_hijo_local, comision_logistica,
    aplica_redondeo_costo
  )
  SELECT
    p_entidad ->> 'nombre',
    p_entidad ->> 'rol',
    p_entidad ->> 'zona',
    p_entidad ->> 'email',
    (p_entidad ->> 'auth_id')::uuid,
    p_entidad ->> 'telefono',
    p_entidad ->> 'ubicacion_maps',
    COALESCE((p_entidad ->> 'es_distribuidor')::boolean, false),
    (p_entidad ->> 'id_nodo_padre')::uuid,
    (p_entidad ->> 'id_padre')::uuid,
    COALESCE((p_entidad ->> 'comision_base')::numeric, 0.00),
    COALESCE((p_entidad ->> 'comision_base_local')::numeric, 0.00),
    COALESCE((p_entidad ->> 'comision_hijo_local')::numeric, 0.00),
    COALESCE((p_entidad ->> 'comision_logistica')::numeric, 0.00),
    COALESCE((p_entidad ->> 'aplica_redondeo_costo')::boolean, true)
  RETURNING id INTO v_entidad_id;

  IF v_entidad_id IS NULL THEN
    RAISE EXCEPTION 'alta de entidad: el INSERT no devolvio id' USING ERRCODE = '25000';
  END IF;

  -- ── 2. Su cuenta ──────────────────────────────────────────────────────────
  INSERT INTO public.cuentas_financieras (id_entidad, nombre, tipo_fiscalidad)
  VALUES (
    v_entidad_id,                 -- FORZADO. Ver el contrato, punto 4.
    p_cuenta ->> 'nombre',
    COALESCE(p_cuenta ->> 'tipo_fiscalidad', 'LIBRE')
  );

  -- El silencio de ERP-66: un INSERT denegado por RLS lanza 42501 y deshace
  -- todo, pero cero filas sin error seria una entidad sin cuenta otra vez, que
  -- es justo el estado que esta funcion existe para hacer imposible.
  GET DIAGNOSTICS v_escritas = ROW_COUNT;
  IF v_escritas <> 1 THEN
    RAISE EXCEPTION 'alta de entidad: la cuenta escribio % filas (esperaba 1)', v_escritas
      USING ERRCODE = '25000';
  END IF;

  RETURN v_entidad_id;
END;
$$;

COMMENT ON FUNCTION public.crear_entidad_atomica(jsonb, jsonb) IS
  'Fase 5 del bot. La entidad y su cuenta de efectivo dentro de UNA '
  'transaccion: o entran las dos o no entra ninguna. Sustituye la compensacion '
  'por DELETE de registrarEntidadAction, que dejaba una entidad sin ninguna '
  'cuenta si el proceso moria en medio. El usuario de Auth NO entra aqui: es '
  'una llamada HTTP y no cabe en una transaccion de Postgres. SECURITY INVOKER '
  'a proposito: el dueno tiene BYPASSRLS y con DEFINER esto se saltaria la '
  'politica entidades_ins_admin.';

-- ERP-57, igual que sus dos hermanas.
REVOKE EXECUTE ON FUNCTION public.crear_entidad_atomica(jsonb, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.crear_entidad_atomica(jsonb, jsonb)
  TO authenticated, service_role;
