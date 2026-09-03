-- ============================================================================
-- La bitacora de auditoria, y los triggers que imponen lo que hoy solo pide la app
-- ============================================================================
-- EL HUECO QUE CIERRA. El RLS del 2026-09-02 quedo bien para LEER. Para
-- ESCRIBIR dejo tres huecos con una sola causa: **las reglas de negocio viven
-- en la aplicacion, y un distribuidor no esta obligado a usar la aplicacion**.
-- Tiene un token valido y PostgREST es una API HTTPS publica. Con `curl` basta.
--
--   * `tickets_upd_dst` y `finanzas_upd_dst` permiten UPDATE sin restriccion de
--     columnas y sin ventana de tiempo: David podia reescribir
--     `total_cobrado_real` de sus 9 tickets o ponerlos todos en ANULADO.
--   * La ventana de 12 h (D-E25) vivia SOLO en TypeScript
--     (`lib/constants.ts`, `app/actions/audit.ts`, `lib/ticket-annul-cascade.ts`).
--   * 38 filas de `finanzas_ledger` no tienen `usuario_creador`, porque el
--     autor lo mandaba el cliente y podia venir vacio (o mentir).
--
-- **RLS autoriza, no valida.** Esta migracion pone la segunda mitad: quien
-- puede tocar QUE columna, en QUE transicion y DENTRO DE CUANTO TIEMPO. Un
-- trigger BEFORE corre pase lo que pase — por la app, por `curl` o por RPC.
--
-- NO CAMBIA NINGUNA CIFRA. No hay UPDATE ni INSERT de datos aqui: solo una
-- tabla nueva vacia, cuatro funciones y nueve triggers.
-- 84 activas / 468 / 61 / $386,201 quedan intactas.
--
-- ─── EL NUMERO 12 AHORA VIVE EN DOS SITIOS, Y NO HAY MANERA DE EVITARLO ─────
-- `lib/constants.ts` dice "este es el UNICO lugar donde vive el numero". Ya no
-- lo es: Postgres no puede leer una constante de TypeScript y TypeScript no
-- puede leer una de Postgres. La ventana esta duplicada A PROPOSITO, aqui y en
-- `VENTANA_EDICION_HORAS`. Si cambia una, hay que cambiar la otra; queda
-- anotado en los dos archivos y una prueba de `tests/arquitectura.spec.ts`
-- vigila que sigan diciendo el mismo numero.
--
-- ─── LA EXCEPCION DE `notas`, DICHA EN VOZ ALTA ─────────────────────────────
-- La regla pedida era "lo unico que se puede cambiar es `status`". Se cumple
-- tal cual en `transacciones_tickets` y en `finanzas_ledger`. En
-- `inventario_ledger` se permite ADEMAS `notas`, y no por gusto: la propia app
-- anula inventario escribiendo las dos columnas a la vez
-- (`anularMovimientoInventario` en `app/actions/audit.ts:275`, y los rollbacks
-- compensatorios de `app/actions/compras.ts:199` y
-- `app/actions/devoluciones.ts:272`, que dejan en `notas` el motivo del fallo:
-- justo el rastro que hace falta cuando un commit parcial deja filas huerfanas).
-- Sin la excepcion, un DST no podria anular su propio movimiento de inventario
-- desde la aplicacion. `notas` no mueve dinero ni existencias, y solo se puede
-- tocar EN EL MISMO UPDATE que hace ACTIVO -> ANULADO y dentro de la ventana.
--
-- ─── ESTADOS LEGACY ─────────────────────────────────────────────────────────
-- La transicion permitida a un no-ADMIN es exactamente ACTIVO -> ANULADO.
-- Los valores deprecados APPROVED / PENDIENTE que el CHECK todavia tolera NO
-- se contemplan porque **hoy no existe ni una fila con ellos** (comprobado
-- 2026-09-02: finanzas 84 ACTIVO + 35 ANULADO, inventario 410 + 58, tickets
-- 61 + 13). Si algun dia reaparecen, un ADMIN los anula sin ventana.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_autor_tickets        ON public.transacciones_tickets;
--   DROP TRIGGER trg_vigilar_upd_tickets  ON public.transacciones_tickets;
--   DROP TRIGGER trg_bitacora_tickets     ON public.transacciones_tickets;
--   DROP TRIGGER trg_autor_finanzas       ON public.finanzas_ledger;
--   DROP TRIGGER trg_vigilar_upd_finanzas ON public.finanzas_ledger;
--   DROP TRIGGER trg_bitacora_finanzas    ON public.finanzas_ledger;
--   DROP TRIGGER trg_autor_inventario         ON public.inventario_ledger;
--   DROP TRIGGER trg_vigilar_upd_inventario   ON public.inventario_ledger;
--   DROP TRIGGER trg_bitacora_inventario      ON public.inventario_ledger;
--   DROP FUNCTION public.tg_bitacora();
--   DROP FUNCTION public.tg_vigilar_update_no_admin();
--   DROP FUNCTION public.tg_forzar_autor();
--   DROP FUNCTION public.usuario_de_sesion();
--   DROP TABLE public.auditoria_logs;   -- se pierde el historial registrado
--
-- ─── NOTA SOBRE EL HISTORIAL DE LA BASE ─────────────────────────────────────
-- Al aplicarla, el REVOKE de EXECUTE sobre `usuario_de_sesion()` a
-- `authenticated` salio como una migracion aparte
-- (`cerrar_execute_usuario_de_sesion`, mismo dia) porque lo pidio el advisor de
-- seguridad despues del primer apply. Aqui ya esta integrado: este archivo es
-- el estado final y se puede replicar de cero tal cual.
-- ============================================================================


-- ─── 1. LA BITACORA ─────────────────────────────────────────────────────────
-- `CLAUDE.md` afirmaba DOS VECES que `auditoria_logs` existia. Nunca existio
-- (ERP-14): `grep -rn "auditoria_logs"` devolvia cero en todo el repo. Hasta
-- hoy no habia forma de saber quien anulo que.

CREATE TABLE IF NOT EXISTS public.auditoria_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tabla         text        NOT NULL,
  id_registro   uuid        NOT NULL,
  operacion     text        NOT NULL CHECK (operacion IN ('INSERT', 'UPDATE')),
  -- El correo de la SESION, puesto por el trigger. Nunca lo que diga el cliente.
  usuario       text        NOT NULL,
  -- Rol resuelto por `mi_rol()`. NULL cuando escribe `postgres` o `service_role`.
  rol           text,
  datos_antes   jsonb,      -- NULL en INSERT
  datos_despues jsonb       NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.auditoria_logs IS
  'Bitacora de escrituras en los dos ledgers y en los tickets. La escribe SOLO '
  'el trigger `tg_bitacora` (SECURITY DEFINER). Nadie mas puede insertar, '
  'actualizar ni borrar: no hay politica de RLS que lo permita y los privilegios '
  'de escritura estan revocados. Solo ADMIN y SOCIO pueden leerla.';

CREATE INDEX IF NOT EXISTS idx_auditoria_logs_tabla_registro
  ON public.auditoria_logs (tabla, id_registro);

CREATE INDEX IF NOT EXISTS idx_auditoria_logs_creado_en
  ON public.auditoria_logs (creado_en DESC);

ALTER TABLE public.auditoria_logs ENABLE ROW LEVEL SECURITY;

-- Supabase concede por defecto todos los privilegios a `anon` y `authenticated`
-- sobre cada tabla nueva de `public`. Hay que quitarlos a mano; el RLS por si
-- solo no impide un `DELETE` si el privilegio esta concedido y hay politica.
REVOKE ALL ON public.auditoria_logs FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON public.auditoria_logs TO authenticated;
GRANT  ALL    ON public.auditoria_logs TO service_role;

-- La UNICA politica: leer. No hay INSERT/UPDATE/DELETE, asi que con RLS activo
-- quedan negados para todo `authenticated`, ADMIN incluido. Una bitacora que su
-- dueno puede editar no es una bitacora.
DROP POLICY IF EXISTS auditoria_sel_admin_socio ON public.auditoria_logs;
CREATE POLICY auditoria_sel_admin_socio ON public.auditoria_logs
  FOR SELECT TO authenticated
  USING (public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO']));


-- ─── 2. QUIEN ES EL DE LA SESION ────────────────────────────────────────────
-- CUIDADO 2 DEL ENCARGO: las migraciones y los arreglos de datos corren como
-- `postgres` / `service_role`, donde `auth.jwt()` es NULL. `auth.jwt()` es
-- `coalesce(nullif(current_setting('request.jwt.claim', true), ''), ...)::jsonb`
-- y con el segundo argumento en `true` NO revienta si el ajuste no existe:
-- devuelve NULL, y `NULL ->> 'email'` es NULL. De ahi sale 'sistema'.

CREATE OR REPLACE FUNCTION public.usuario_de_sesion() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(auth.jwt() ->> 'email', ''), 'sistema')
$$;

-- Sin GRANT a `authenticated`: la unica que la llama es `tg_bitacora`, que es
-- SECURITY DEFINER y corre como `postgres`. Concedersela a `authenticated` la
-- publicaria como /rest/v1/rpc/usuario_de_sesion sin que nadie la necesite
-- (lo marca el advisor de seguridad 0029).
REVOKE EXECUTE ON FUNCTION public.usuario_de_sesion() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.usuario_de_sesion() TO service_role;


-- ─── 3. BEFORE INSERT: el autor lo pone el servidor ─────────────────────────
-- Hoy `usuario_creador` lo manda el cliente. Puede venir vacio (38 filas de
-- `finanzas_ledger` lo tienen NULL) o puede venir con el correo de otro. Y por
-- venir vacio, `assertAnnullmentAllowed` (`app/actions/audit.ts`) le niega a un
-- DST anular su propio abono: compara `row.usuario_creador === currentUser.email`
-- y NULL no empata con nada. Esto lo cierra para siempre.
--
-- Si NO hay sesion (migracion o service_role) se respeta lo que traiga la fila
-- y, si viene vacio, se marca 'sistema'. Un script de datos que se identifica
-- a si mismo dice mas que un 'sistema' generico, y ahi no hay cliente al que
-- desconfiarle.

CREATE OR REPLACE FUNCTION public.tg_forzar_autor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text := NULLIF(auth.jwt() ->> 'email', '');
BEGIN
  IF v_email IS NOT NULL THEN
    NEW.usuario_creador := v_email;
  ELSE
    NEW.usuario_creador := COALESCE(NULLIF(BTRIM(NEW.usuario_creador), ''), 'sistema');
  END IF;

  RETURN NEW;
END;
$$;


-- ─── 4. BEFORE UPDATE: las tres reglas que hoy solo pide la app ─────────────
-- Argumentos del trigger:
--   TG_ARGV[0] — nombre de la columna de fecha de la tabla.
--   TG_ARGV[1] — columnas editables ADEMAS de `status`, separadas por coma
--                (opcional; hoy solo `notas` en `inventario_ledger`).
--
-- CUIDADO 1: el ADMIN escribe por la app con su propia sesion y no debe notar
-- nada. Sale por la primera puerta.
-- CUIDADO 2: sin rol resuelto no hay usuario que vigilar — es `postgres` (una
-- migracion), es `service_role` (un arreglo de datos), o es alguien sin fila en
-- `entidades`, a quien el RLS ya le nego este UPDATE mucho antes de llegar
-- aqui. En los tres casos se deja pasar y NO revienta.

CREATE OR REPLACE FUNCTION public.tg_vigilar_update_no_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rol        text := public.mi_rol();
  v_editables  text[] := ARRAY['status'];
  v_col        text;
  v_antes      jsonb;
  v_despues    jsonb;
  v_cambiadas  text;
  v_fecha      timestamptz;
  v_horas      numeric;
BEGIN
  IF v_rol IS NULL OR v_rol = 'ADMIN' THEN
    RETURN NEW;
  END IF;

  IF TG_NARGS > 1 AND COALESCE(TG_ARGV[1], '') <> '' THEN
    v_editables := v_editables || string_to_array(TG_ARGV[1], ',');
  END IF;

  -- REGLA 1 — ninguna otra columna se mueve.
  v_antes   := to_jsonb(OLD);
  v_despues := to_jsonb(NEW);

  FOREACH v_col IN ARRAY v_editables LOOP
    v_antes   := v_antes   - v_col;
    v_despues := v_despues - v_col;
  END LOOP;

  IF v_antes IS DISTINCT FROM v_despues THEN
    SELECT string_agg(clave, ', ' ORDER BY clave)
      INTO v_cambiadas
      FROM jsonb_object_keys(v_antes) AS clave
     WHERE v_antes -> clave IS DISTINCT FROM v_despues -> clave;

    RAISE EXCEPTION
      'Regla violada: COLUMNAS PROTEGIDAS. El rol % solo puede cambiar [%] en %; '
      'intento modificar [%]. Solo un ADMIN puede tocar esas columnas.',
      v_rol, array_to_string(v_editables, ', '), TG_TABLE_NAME, v_cambiadas
      USING ERRCODE = '42501';
  END IF;

  -- REGLA 2 — la unica transicion permitida es ACTIVO -> ANULADO.
  IF NOT (OLD.status = 'ACTIVO' AND NEW.status = 'ANULADO') THEN
    RAISE EXCEPTION
      'Regla violada: TRANSICION DE STATUS. El rol % solo puede pasar status de '
      'ACTIVO a ANULADO en %; intento % -> %.',
      v_rol, TG_TABLE_NAME, OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- REGLA 3 — la ventana de 12 h (D-E25). El ADMIN ya salio arriba: no tiene.
  v_fecha := (to_jsonb(OLD) ->> TG_ARGV[0])::timestamptz;

  IF v_fecha IS NULL THEN
    RAISE EXCEPTION
      'Regla violada: VENTANA DE EDICION. El registro % de % no tiene % y no se '
      'puede fechar; solo un ADMIN puede anularlo.',
      OLD.id, TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = '42501';
  END IF;

  v_horas := EXTRACT(EPOCH FROM (now() - v_fecha)) / 3600;

  IF v_horas > 12 THEN
    RAISE EXCEPTION
      'Regla violada: VENTANA DE EDICION. Ventana de anulacion expirada (maximo 12 horas). '
      'El registro % de % es del % (hace % horas) y el rol % no tiene ventana abierta. '
      'Solo un ADMIN puede anularlo.',
      OLD.id, TG_TABLE_NAME, v_fecha, round(v_horas, 1), v_rol
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;


-- ─── 5. AFTER INSERT OR UPDATE: dejar constancia ────────────────────────────
-- CUIDADO 3: este trigger NO se cuelga de `auditoria_logs` (seria recursion
-- infinita). El guardia de la primera linea lo hace imposible aunque alguien
-- lo intente por descuido dentro de un ano.
--
-- Corre DESPUES de los BEFORE, asi que `to_jsonb(NEW)` ya trae el
-- `usuario_creador` forzado por el servidor, no el que mando el cliente.

CREATE OR REPLACE FUNCTION public.tg_bitacora() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  RETURN NULL;  -- AFTER trigger: el valor de retorno se ignora.
END;
$$;

-- Nadie llama estas funciones a mano: las dispara el motor. Con EXECUTE abierto
-- a PUBLIC serian tres RPC mas publicadas por PostgREST.
REVOKE EXECUTE ON FUNCTION public.tg_forzar_autor()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_vigilar_update_no_admin()  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_bitacora()                 FROM PUBLIC, anon, authenticated;


-- ─── 6. LOS NUEVE TRIGGERS ──────────────────────────────────────────────────

-- transacciones_tickets · fecha en `fecha_transaccion`, solo `status` editable
DROP TRIGGER IF EXISTS trg_autor_tickets ON public.transacciones_tickets;
CREATE TRIGGER trg_autor_tickets
  BEFORE INSERT ON public.transacciones_tickets
  FOR EACH ROW EXECUTE FUNCTION public.tg_forzar_autor();

DROP TRIGGER IF EXISTS trg_vigilar_upd_tickets ON public.transacciones_tickets;
CREATE TRIGGER trg_vigilar_upd_tickets
  BEFORE UPDATE ON public.transacciones_tickets
  FOR EACH ROW EXECUTE FUNCTION public.tg_vigilar_update_no_admin('fecha_transaccion');

DROP TRIGGER IF EXISTS trg_bitacora_tickets ON public.transacciones_tickets;
CREATE TRIGGER trg_bitacora_tickets
  AFTER INSERT OR UPDATE ON public.transacciones_tickets
  FOR EACH ROW EXECUTE FUNCTION public.tg_bitacora();

-- finanzas_ledger · fecha en `fecha_movimiento`, solo `status` editable
DROP TRIGGER IF EXISTS trg_autor_finanzas ON public.finanzas_ledger;
CREATE TRIGGER trg_autor_finanzas
  BEFORE INSERT ON public.finanzas_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_forzar_autor();

DROP TRIGGER IF EXISTS trg_vigilar_upd_finanzas ON public.finanzas_ledger;
CREATE TRIGGER trg_vigilar_upd_finanzas
  BEFORE UPDATE ON public.finanzas_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_vigilar_update_no_admin('fecha_movimiento');

DROP TRIGGER IF EXISTS trg_bitacora_finanzas ON public.finanzas_ledger;
CREATE TRIGGER trg_bitacora_finanzas
  AFTER INSERT OR UPDATE ON public.finanzas_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_bitacora();

-- inventario_ledger · fecha en `fecha_movimiento`; `notas` editable ademas de
-- `status` por lo explicado en la cabecera (la app las escribe juntas al anular)
DROP TRIGGER IF EXISTS trg_autor_inventario ON public.inventario_ledger;
CREATE TRIGGER trg_autor_inventario
  BEFORE INSERT ON public.inventario_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_forzar_autor();

DROP TRIGGER IF EXISTS trg_vigilar_upd_inventario ON public.inventario_ledger;
CREATE TRIGGER trg_vigilar_upd_inventario
  BEFORE UPDATE ON public.inventario_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_vigilar_update_no_admin('fecha_movimiento', 'notas');

DROP TRIGGER IF EXISTS trg_bitacora_inventario ON public.inventario_ledger;
CREATE TRIGGER trg_bitacora_inventario
  AFTER INSERT OR UPDATE ON public.inventario_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_bitacora();
