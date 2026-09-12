-- ============================================================================
-- Migracion de PRUEBA: el trigger no puede estorbarle a una migracion
-- ============================================================================
-- CRITERIO 4 DEL PROMPT 14, y el unico que solo se puede comprobar SIENDO una
-- migracion. Corre como `postgres`: ahi `auth.jwt()` es NULL y `mi_rol()`
-- devuelve NULL. Si `tg_vigilar_update_no_admin` no tuviera su salida por
-- "sin rol resuelto", este archivo reventaria — y con el, todas las migraciones
-- y arreglos de datos futuros. Ese fallo no se descubre el dia que se escribe
-- el trigger, sino el dia que hace falta arreglar algo con prisa.
--
-- No es una migracion de esquema: no crea, no altera y no borra nada. Escribe
-- tres veces sobre UNA fila vieja de `inventario_ledger` — tocando una columna
-- protegida (`notas`), una columna de dinero (`costo_unitario_movimiento`) y
-- sin ninguna transicion de status, o sea **violando las tres reglas a la vez**
-- — y la deja exactamente como estaba, con una comprobacion explicita que
-- revienta si no fuera asi.
--
-- Se queda en el repo a proposito: es reproducible, es idempotente y es la
-- prueba de que el candado distingue "un DST con un token" de "el dueno de la
-- base corriendo una migracion". Volver a aplicarla cuesta tres UPDATE.
--
-- Salida observada al aplicarla (2026-09-02): sin error, y las cifras de
-- control siguieron en 84 activas / 468 / 61 / $386,201. Las tres escrituras
-- quedaron en `auditoria_logs` con `usuario = 'sistema'` y `rol = NULL`, que es
-- justo lo que pide el CUIDADO 2 del encargo.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- Ninguno: la migracion se deshace a si misma antes de terminar. Si se quiere
-- borrar su rastro, es un DELETE sobre `auditoria_logs`... que nadie puede
-- hacer salvo `postgres`, y ese es justamente el punto.
-- ============================================================================

DO $prueba$
DECLARE
  v_id      uuid;
  v_notas   text;
  v_status  text;
  v_fecha   timestamptz;
BEGIN
  SELECT id, notas, status, fecha_movimiento
    INTO v_id, v_notas, v_status, v_fecha
    FROM public.inventario_ledger
   WHERE status = 'ACTIVO'
   ORDER BY fecha_movimiento ASC
   LIMIT 1;

  RAISE NOTICE 'Fila de prueba: % (del %, status %)', v_id, v_fecha, v_status;

  -- 1) Escribir una columna protegida sin cambiar status.
  UPDATE public.inventario_ledger
     SET notas = COALESCE(v_notas, '') || ' [prueba-migracion-prompt14]'
   WHERE id = v_id;

  -- 2) Y una columna de dinero, que a un DST le costaria un 42501.
  UPDATE public.inventario_ledger
     SET costo_unitario_movimiento = costo_unitario_movimiento
   WHERE id = v_id;

  -- 3) Dejarlo como estaba. La bitacora conserva los tres pasos.
  UPDATE public.inventario_ledger
     SET notas = v_notas
   WHERE id = v_id;

  IF (SELECT notas FROM public.inventario_ledger WHERE id = v_id) IS DISTINCT FROM v_notas THEN
    RAISE EXCEPTION 'La prueba no dejo el dato como estaba';
  END IF;

  RAISE NOTICE 'OK: el trigger dejo pasar las tres escrituras sin sesion.';
END
$prueba$;
