-- ===========================================================================
--  ERP-71 · un intento BLOQUEADO tiene que dejar rastro
-- ===========================================================================
--  Escrito el 2026-09-17 por el Socio.  **ESTA MIGRACION NO ESTA APLICADA.**
--  Se aplica con `apply_migration` del MCP. NUNCA con `supabase db push`.
--
-- ---------------------------------------------------------------------------
--  1. EL DEFECTO, DICHO CON PRECISION
-- ---------------------------------------------------------------------------
--  `20260903043105_bitacora_auditoria_y_triggers.sql` monta dos piezas sobre
--  cada uno de los tres ledgers:
--
--    · `tg_vigilar_update_no_admin` — BEFORE UPDATE. Deniega con `RAISE
--      EXCEPTION ... USING ERRCODE = '42501'` (lineas ~225 y ~234 del archivo).
--    · `tg_bitacora`                — AFTER INSERT OR UPDATE. Escribe la fila
--      en `auditoria_logs`.
--
--  El ticket lo cuenta como "el RAISE aborta la transaccion y con ella se va la
--  fila de bitacora que acababa de escribirse". **El mecanismo real es un paso
--  antes, y conviene decirlo bien porque cambia la cura:** un trigger AFTER no
--  llega a dispararse cuando un BEFORE de la misma sentencia lanza. No es que
--  la fila se escriba y se pierda: **es que nunca se escribe**. En los dos
--  relatos el resultado es el mismo y es el que importa —
--
--      la bitacora registra lo que PASO y es ciega a lo que se INTENTO y se
--      IMPIDIO, que es justo lo que uno quiere ver en una auditoria.
--
--  Hay un segundo caso, este si de rollback, y NO se arregla aqui a proposito:
--  si una server action escribe cinco filas y la quinta falla, las cuatro filas
--  de bitacora de las anteriores se van con el rollback. Eso es **correcto**:
--  describian filas que dejaron de existir. Una bitacora que sobrevive a los
--  datos que describe miente. (Ese caso es ERP-11, y se ataca haciendo la venta
--  atomica, no tocando la bitacora.)
--
-- ---------------------------------------------------------------------------
--  2. LA INVESTIGACION: QUE PUEDE ESCRIBIR FUERA DE UNA TRANSACCION QUE ABORTA
-- ---------------------------------------------------------------------------
--  La tension es de fondo y no se puede negociar: **para denegar fuerte hay que
--  abortar, y para persistir hay que no abortar.** Un `INSERT` -este o
--  cualquier otro, en la misma tabla o en otra, dentro de un bloque `EXCEPTION`
--  o fuera de el- vive dentro de la misma transaccion que se va a deshacer.
--  Postgres no tiene transacciones autonomas. Lo unico que sirve es un canal
--  que NO participe del rollback. Hay exactamente tres, y se revisaron los
--  tres contra ESTA base (Postgres 17.6, proyecto `gnnqxtsdrbvmlkhfemjw`):
--
--  (a) EL LOG DEL SERVIDOR — `RAISE LOG`.
--      Lo escribe el backend al ejecutarse, a un archivo. Un `ROLLBACK` no
--      retira bytes ya escritos en un archivo de log. Comprobado en la base que
--      el canal esta abierto: `log_min_messages = warning`, `logging_collector
--      = on`, `log_destination = csvlog`, y en el orden de severidades de
--      Postgres `LOG` esta POR ENCIMA de `warning`, asi que una linea `RAISE
--      LOG` si se emite. Coste: cero extensiones, cero credenciales, cero
--      conexiones nuevas. Limite: no es una fila — no se consulta con SQL y
--      vive lo que dure la retencion de logs del proyecto.
--
--  (b) OTRA CONEXION — `dblink`.
--      La unica forma de conseguir una fila de verdad. `dblink` esta
--      DISPONIBLE en esta base (1.2) pero NO instalada; `postgres_fdw` igual;
--      `pg_background` **no existe** en el catalogo de este proyecto, asi que
--      el camino que suele recomendarse para transacciones autonomas aqui no
--      esta. Se descarta como camino por defecto, y por dos costes que no son
--      teoricos:
--        · Hay que guardar una credencial de conexion a la propia base. Se
--          puede tapar con `supabase_vault` (instalado, 0.3.1), pero sigue
--          siendo un secreto vivo y una funcion `SECURITY DEFINER` capaz de
--          abrir conexiones arbitrarias.
--        · **Abre una negacion de servicio.** Cada intento bloqueado abriria
--          una conexion nueva. Un DST con `curl` y un bucle -que es justo el
--          personaje contra el que se escribio la migracion original- puede
--          agotar el pool de conexiones del proyecto y tumbar la aplicacion
--          entera disparando denegaciones a proposito. El mecanismo de
--          auditoria se convertiria en el arma.
--      El SQL de esta variante queda escrito al final del archivo, comentado,
--      por si Norman decide que la fila vale ese precio.
--
--  (c) UN CONTADOR — una SECUENCIA.
--      `nextval()` **no se deshace con el rollback** (documentado: las
--      secuencias son no transaccionales, por eso hay huecos en los IDs). Da
--      un numero, no una historia; pero es SQL, es permanente y es gratis.
--      Salvedad honesta: Postgres escribe el avance de una secuencia al WAL
--      cada 32 valores, asi que una caida dura puede perder hasta 32 cuentas.
--      Para un cable de alarma —"¿hubo intentos desde la ultima vez?"— sobra.
--
--  LO QUE SE ELIGE: **(a) + (c)**. El detalle de cada intento va al log del
--  servidor con una marca que se busca en un segundo; el contador da la prueba
--  consultable con SQL que sobrevive a la retencion del log. Ninguna extension
--  nueva, ningun secreto nuevo, ninguna conexion nueva, y **ni un camino nuevo
--  por el que alguien pueda escribir**.
--
--  LO QUE ESTO NO ARREGLA, DICHO EN VOZ ALTA: el rastro del intento NO queda en
--  `auditoria_logs`. Quien audite tiene que mirar dos sitios. Es el precio de
--  no abrir (b), y esta escrito aqui para que la decision se pueda revisar.
--
-- ---------------------------------------------------------------------------
--  3. QUE SE LOGUEA, Y QUE NO
-- ---------------------------------------------------------------------------
--  La linea lleva METADATOS: tabla, id del registro, regla violada, rol,
--  usuario de la sesion, y el detalle minimo de la regla (que columnas, que
--  transicion, cuantas horas). **Nunca la fila.** El log del servidor esta peor
--  protegido que la tabla -`auditoria_logs` solo la leen ADMIN y SOCIO, con
--  RLS-, asi que volcar ahi `to_jsonb(OLD)` cambiaria un hueco de auditoria por
--  una fuga de datos. Eso seria arreglar un defecto creando otro.
--
-- ---------------------------------------------------------------------------
--  4. EL CAMBIO
-- ---------------------------------------------------------------------------

-- ─── 4.1 El contador que sobrevive al rollback ──────────────────────────────
-- `CACHE 1` no es adorno: con cache mayor, cada backend se reserva un bloque y
-- `last_value` deja de ser el conteo real.
CREATE SEQUENCE IF NOT EXISTS public.intentos_bloqueados_contador
  AS bigint START 1 CACHE 1;

COMMENT ON SEQUENCE public.intentos_bloqueados_contador IS
  'ERP-71. Cuenta los intentos de escritura BLOQUEADOS por '
  '`tg_vigilar_update_no_admin`. Es una secuencia y no una tabla porque '
  '`nextval` no participa del rollback: la transaccion que se aborta no puede '
  'borrar la cuenta. El detalle de cada intento va al log del servidor con la '
  'marca ERP71_INTENTO_BLOQUEADO.';

-- Nadie la toca a mano. `registrar_intento_bloqueado` es SECURITY DEFINER y
-- avanza como su dueno, asi que no hace falta conceder nada a `authenticated`.
REVOKE ALL ON SEQUENCE public.intentos_bloqueados_contador FROM PUBLIC, anon, authenticated;

-- ─── 4.2 Quien escribe el rastro ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_intento_bloqueado(
  p_tabla       text,
  p_id_registro uuid,
  p_regla       text,
  p_detalle     jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_folio bigint;
BEGIN
  -- 1. El contador. No se deshace con el rollback: esa es toda su razon de ser.
  v_folio := nextval('public.intentos_bloqueados_contador');

  -- 2. El detalle, al log del servidor. `clock_timestamp()` y no `now()`:
  --    `now()` es la hora de INICIO de la transaccion, y la que interesa es la
  --    del intento.
  RAISE LOG '%', jsonb_build_object(
    'marca',       'ERP71_INTENTO_BLOQUEADO',
    'folio',       v_folio,
    'cuando',      clock_timestamp(),
    'tabla',       p_tabla,
    'id_registro', p_id_registro,
    'regla',       p_regla,
    'usuario',     public.usuario_de_sesion(),
    'rol',         public.mi_rol(),
    'detalle',     p_detalle
  )::text;
EXCEPTION WHEN OTHERS THEN
  -- NUNCA convertir un fallo del registro en un fallo de la denegacion. Si
  -- esto revienta, la escritura tiene que seguir prohibida igual. El orden
  -- importa: la denegacion la hace quien nos llama, DESPUES de este RETURN.
  NULL;
END;
$$;

COMMENT ON FUNCTION public.registrar_intento_bloqueado(text, uuid, text, jsonb) IS
  'ERP-71. Deja rastro de un intento de escritura bloqueado por los dos canales '
  'que NO participan del rollback: una secuencia (cuenta) y el log del servidor '
  '(detalle, marcado con ERP71_INTENTO_BLOQUEADO). Nunca escribe la fila '
  'completa: el log esta peor protegido que `auditoria_logs`.';

-- La llama unicamente el trigger, que tambien es SECURITY DEFINER. Con EXECUTE
-- abierto seria una RPC mas publicada por PostgREST, y cualquiera podria
-- ensuciar la bitacora con intentos inventados.
REVOKE EXECUTE ON FUNCTION public.registrar_intento_bloqueado(text, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;

-- ─── 4.3 Como se consulta la cuenta ─────────────────────────────────────────
-- `is_called` en falso significa que nunca se llamo: la cuenta es 0, no 1.
CREATE OR REPLACE FUNCTION public.intentos_bloqueados_hasta_ahora() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
           WHEN public.mi_rol() = ANY (ARRAY['ADMIN', 'SOCIO'])
             THEN (SELECT CASE WHEN is_called THEN last_value ELSE 0 END
                     FROM public.intentos_bloqueados_contador)
           ELSE NULL
         END;
$$;

COMMENT ON FUNCTION public.intentos_bloqueados_hasta_ahora() IS
  'ERP-71. Cuantos intentos de escritura se han bloqueado desde que se aplico '
  'la migracion. Solo ADMIN y SOCIO obtienen numero; los demas, NULL. Si sube, '
  'el detalle esta en el log del servidor: buscar ERP71_INTENTO_BLOQUEADO.';

REVOKE EXECUTE ON FUNCTION public.intentos_bloqueados_hasta_ahora() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.intentos_bloqueados_hasta_ahora() TO authenticated;

-- ─── 4.4 El trigger, con el rastro antes de cada denegacion ─────────────────
-- Es el MISMO cuerpo de `20260903043105_bitacora_auditoria_y_triggers.sql`, con
-- una llamada a `registrar_intento_bloqueado` delante de cada uno de los cuatro
-- `RAISE`. `CREATE OR REPLACE` conserva la identidad de la funcion: los nueve
-- triggers siguen apuntando aqui y NO hay que recrearlos.
--
-- El orden es el que es: primero se registra, despues se lanza. Al reves, la
-- excepcion ya habria salido y no habria quien registrara.

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

    PERFORM public.registrar_intento_bloqueado(
      TG_TABLE_NAME, OLD.id, 'COLUMNAS_PROTEGIDAS',
      jsonb_build_object(
        'columnas_intentadas', v_cambiadas,
        'columnas_editables',  array_to_string(v_editables, ', ')
      ));

    RAISE EXCEPTION
      'Regla violada: COLUMNAS PROTEGIDAS. El rol % solo puede cambiar [%] en %; '
      'intento modificar [%]. Solo un ADMIN puede tocar esas columnas.',
      v_rol, array_to_string(v_editables, ', '), TG_TABLE_NAME, v_cambiadas
      USING ERRCODE = '42501';
  END IF;

  -- REGLA 2 — la unica transicion permitida es ACTIVO -> ANULADO.
  IF NOT (OLD.status = 'ACTIVO' AND NEW.status = 'ANULADO') THEN
    PERFORM public.registrar_intento_bloqueado(
      TG_TABLE_NAME, OLD.id, 'TRANSICION_DE_STATUS',
      jsonb_build_object('de', OLD.status, 'a', NEW.status));

    RAISE EXCEPTION
      'Regla violada: TRANSICION DE STATUS. El rol % solo puede pasar status de '
      'ACTIVO a ANULADO en %; intento % -> %.',
      v_rol, TG_TABLE_NAME, OLD.status, NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- REGLA 3 — la ventana de 12 h (D-E25). El ADMIN ya salio arriba: no tiene.
  v_fecha := (to_jsonb(OLD) ->> TG_ARGV[0])::timestamptz;

  IF v_fecha IS NULL THEN
    PERFORM public.registrar_intento_bloqueado(
      TG_TABLE_NAME, OLD.id, 'VENTANA_SIN_FECHA',
      jsonb_build_object('columna_de_fecha', TG_ARGV[0]));

    RAISE EXCEPTION
      'Regla violada: VENTANA DE EDICION. El registro % de % no tiene % y no se '
      'puede fechar; solo un ADMIN puede anularlo.',
      OLD.id, TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = '42501';
  END IF;

  v_horas := EXTRACT(EPOCH FROM (now() - v_fecha)) / 3600;

  IF v_horas > 12 THEN
    PERFORM public.registrar_intento_bloqueado(
      TG_TABLE_NAME, OLD.id, 'VENTANA_EXPIRADA',
      jsonb_build_object('horas_transcurridas', round(v_horas, 1), 'ventana_horas', 12));

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

REVOKE EXECUTE ON FUNCTION public.tg_vigilar_update_no_admin() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
--  5. COMO SE COMPRUEBA DESPUES DE APLICAR (control positivo y negativo)
-- ---------------------------------------------------------------------------
--  CONTROL POSITIVO — el intento bloqueado deja rastro:
--
--    1) Lee la cuenta de partida:
--         SELECT CASE WHEN is_called THEN last_value ELSE 0 END
--           FROM public.intentos_bloqueados_contador;
--    2) Con la sesion de un DST (no service_role, no postgres), intenta el
--       UPDATE prohibido; tiene que fallar con 42501, como hoy.
--    3) Vuelve a leer la cuenta: **tiene que haber subido en 1**. Si subio, el
--       rastro sobrevivio al rollback que borro todo lo demas. Ese es el
--       experimento entero.
--    4) En el Logs Explorer del proyecto, busca `ERP71_INTENTO_BLOQUEADO`: ahi
--       esta el detalle con el mismo folio.
--
--  CONTROL NEGATIVO — la prueba distingue de verdad:
--
--    5) Con la MISMA sesion, haz un UPDATE **permitido** (ACTIVO -> ANULADO
--       dentro de la ventana). La cuenta **NO** debe moverse. Si sube tambien
--       aqui, el contador esta contando escrituras, no denegaciones, y no mide
--       lo que dice medir.
--    6) Con sesion de ADMIN, cualquier UPDATE: la cuenta tampoco se mueve (el
--       ADMIN sale por la primera puerta de la funcion).
--
--  Y la pregunta del control, contestada antes de correrlo: si esto estuviera
--  roto —si el rastro siguiera dentro de la transaccion— el paso 3 daria la
--  MISMA cuenta de partida. Cuenta igual = arreglo que no arreglo nada.
--
-- ---------------------------------------------------------------------------
--  6. ROLLBACK
-- ---------------------------------------------------------------------------
--    -- Volver a poner `tg_vigilar_update_no_admin` como esta en
--    -- supabase/migrations/20260903043105_bitacora_auditoria_y_triggers.sql
--    -- (copiar su CREATE OR REPLACE tal cual), y despues:
--    DROP FUNCTION IF EXISTS public.intentos_bloqueados_hasta_ahora();
--    DROP FUNCTION IF EXISTS public.registrar_intento_bloqueado(text, uuid, text, jsonb);
--    DROP SEQUENCE IF EXISTS public.intentos_bloqueados_contador;  -- se pierde la cuenta
--
-- ---------------------------------------------------------------------------
--  7. LA VARIANTE (b), POR SI LA FILA VALE SU PRECIO — NO APLICAR A CIEGAS
-- ---------------------------------------------------------------------------
--  Esto da una fila de verdad en `auditoria_logs` para el intento bloqueado.
--  Antes de encenderlo hay que decidir que se acepta el riesgo de agotar
--  conexiones descrito en el punto 2(b), y guardar la cadena de conexion en
--  Vault. Queda escrito para que la decision sea de Norman y no una laguna:
--
--    CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
--
--    -- La cadena vive en Vault, NUNCA en el archivo ni en un COMMENT:
--    --   SELECT vault.create_secret(
--    --     'dbname=postgres user=... password=... host=... port=5432',
--    --     'erp71_bitacora_autonoma', 'ERP-71: conexion de vuelta a la propia base');
--
--    CREATE OR REPLACE FUNCTION public.registrar_intento_bloqueado_en_tabla(
--      p_tabla text, p_id_registro uuid, p_regla text, p_detalle jsonb
--    ) RETURNS void
--    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
--    DECLARE
--      v_conn text;
--    BEGIN
--      SELECT decrypted_secret INTO v_conn
--        FROM vault.decrypted_secrets WHERE name = 'erp71_bitacora_autonoma';
--
--      PERFORM dblink_exec(v_conn, format(
--        'INSERT INTO public.auditoria_logs '
--        '(tabla, id_registro, operacion, usuario, rol, datos_antes, datos_despues) '
--        'VALUES (%L, %L, %L, %L, %L, NULL, %L)',
--        p_tabla, p_id_registro, 'INTENTO_BLOQUEADO',
--        public.usuario_de_sesion(), public.mi_rol(), p_detalle));
--    EXCEPTION WHEN OTHERS THEN
--      NULL;  -- igual que arriba: el registro no puede tumbar la denegacion
--    END;
--    $fn$;
--
--  OJO, y por eso no va activado: `auditoria_logs.operacion` tiene
--  `CHECK (operacion IN ('INSERT','UPDATE'))`. Encender esta variante obliga a
--  ampliar ese CHECK con 'INTENTO_BLOQUEADO' en la MISMA migracion, o cada
--  intento de registro fallaria en silencio dentro del `EXCEPTION` de arriba —
--  que es exactamente el modo de fallo que este ticket vino a cerrar.
-- ===========================================================================
