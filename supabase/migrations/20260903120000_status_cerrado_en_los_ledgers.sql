-- ============================================================================
-- Cerrar `status` en los dos ledgers, y volver `tipo_movimiento` obligatorio
-- ============================================================================
-- ERP-12 + ERP-13.
--
-- QUE ESTABA ABIERTO (verificado contra produccion el 2026-09-03, antes de
-- aplicar esta migracion):
--
--   finanzas_ledger.status    DEFAULT 'APPROVED'
--                             CHECK (status IN ('ACTIVO','ANULADO','APPROVED','PENDIENTE'))
--   inventario_ledger.status  DEFAULT 'ACTIVO'   <- este ya estaba bien
--                             CHECK (status IN ('ACTIVO','ANULADO','APPROVED','PENDIENTE'))
--   finanzas_ledger.tipo_movimiento  NULLABLE
--
--   `transacciones_tickets.status` ya estaba cerrado a dos valores desde antes;
--   esta migracion no lo toca.
--
-- POR QUE IMPORTA, si hoy hay CERO filas legacy. Porque el default sigue
-- armado: cualquier `INSERT` en `finanzas_ledger` que **omita** `status` nace
-- `APPROVED` **sin dar error**. Y `APPROVED` se comporta distinto segun quien
-- lea: desaparece de las lecturas que exigen `status = 'ACTIVO'` (el KPI de IVA
-- e IEPS por pagar) y sigue contando en las que hacen
-- `.in('status', ['ACTIVO','APPROVED'])` (casi todas las demas). Es dinero que
-- se ve en una pantalla y no en otra, sin ningun sintoma que lo delate.
--
-- Es tambien la puerta exacta por la que va a entrar el bot de Telegram
-- (ERP-43): codigo nuevo armando filas por un camino que nadie ha recorrido.
-- Cerrarla hoy cuesta una migracion; cerrarla despues cuesta una auditoria.
--
-- QUE NO HACE. **No normaliza nada.** Si el dia que corra hubiera filas con
-- status legacy o con `tipo_movimiento` NULL, revienta con el conteo en el
-- mensaje y no cambia una sola fila. Que un dato raro se "arregle solo" en una
-- migracion es como se pierde el rastro de por que existia.
--
-- POR QUE SE DEJA UN DEFAULT, y no se quita. Un `INSERT` que omita `status`
-- tiene que entrar como `ACTIVO`, no reventar: la app escribe el ledger por
-- varios caminos (`pos.ts`, `auditoria.ts`, `inventario.ts`, `abonos.ts`) y el
-- bot va a escribir por otro mas. Sin default, cerrar el CHECK convertiria un
-- olvido silencioso en una caida ruidosa — mejor que hoy, pero peor que lo
-- correcto.
--
-- NO CAMBIA NINGUNA CIFRA. No se toca una fila de datos: son cuatro `ALTER`
-- sobre metadatos de columna. Las cifras de control se comprueban al pie.
--
-- --- ROLLBACK ---------------------------------------------------------------
--   ALTER TABLE public.finanzas_ledger   ALTER COLUMN status SET DEFAULT 'APPROVED';
--   ALTER TABLE public.finanzas_ledger   DROP CONSTRAINT finanzas_ledger_status_check;
--   ALTER TABLE public.finanzas_ledger   ADD  CONSTRAINT finanzas_ledger_status_check
--     CHECK (status = ANY (ARRAY['ACTIVO','ANULADO','APPROVED','PENDIENTE']));
--   ALTER TABLE public.finanzas_ledger   ALTER COLUMN tipo_movimiento DROP NOT NULL;
--   ALTER TABLE public.inventario_ledger DROP CONSTRAINT inventario_ledger_status_check;
--   ALTER TABLE public.inventario_ledger ADD  CONSTRAINT inventario_ledger_status_check
--     CHECK (status = ANY (ARRAY['ACTIVO','ANULADO','APPROVED','PENDIENTE']));
--   -- (`inventario_ledger.status` ya tenia DEFAULT 'ACTIVO'; no hay nada que devolver.)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. GUARDIA. Si hay datos que no encajan, no se pasa de aqui.
-- ----------------------------------------------------------------------------
-- El orden importa: primero contar, despues apretar. Si esto se hiciera al
-- reves, el `ADD CONSTRAINT` fallaria con un mensaje de Postgres que dice
-- "violates check constraint" y no dice CUANTAS filas ni de que tabla.

DO $guardia_status$
DECLARE
  v_finanzas   bigint;
  v_inventario bigint;
BEGIN
  SELECT count(*) INTO v_finanzas
    FROM public.finanzas_ledger
   WHERE status IS NULL OR status NOT IN ('ACTIVO', 'ANULADO');

  SELECT count(*) INTO v_inventario
    FROM public.inventario_ledger
   WHERE status IS NULL OR status NOT IN ('ACTIVO', 'ANULADO');

  IF v_finanzas > 0 OR v_inventario > 0 THEN
    RAISE EXCEPTION
      'ABORTADA: hay filas con status fuera de (ACTIVO, ANULADO) — finanzas_ledger: %, inventario_ledger: %. Nada se ha modificado. Revisalas a mano antes de volver a correr esto; esta migracion NO las normaliza a proposito.',
      v_finanzas, v_inventario;
  END IF;

  RAISE NOTICE 'Guardia de status OK: 0 filas legacy en los dos ledgers.';
END
$guardia_status$;


DO $guardia_tipo$
DECLARE
  v_nulos bigint;
BEGIN
  SELECT count(*) INTO v_nulos
    FROM public.finanzas_ledger
   WHERE tipo_movimiento IS NULL;

  IF v_nulos > 0 THEN
    RAISE EXCEPTION
      'ABORTADA: % fila(s) de finanzas_ledger tienen tipo_movimiento NULL. Nada se ha modificado. Un movimiento de dinero sin tipo no se puede clasificar ni deshacer; hay que decidir uno por uno que era cada uno.',
      v_nulos;
  END IF;

  RAISE NOTICE 'Guardia de tipo_movimiento OK: 0 NULLs en finanzas_ledger.';
END
$guardia_tipo$;


-- ----------------------------------------------------------------------------
-- 2. El default deja de ser una mina.
-- ----------------------------------------------------------------------------
-- Se pone tambien en `inventario_ledger` aunque ya valia 'ACTIVO': que la linea
-- este escrita es lo que hace que dentro de un ano nadie tenga que ir a la base
-- a comprobar cual de los dos ledgers era el raro.

ALTER TABLE public.finanzas_ledger   ALTER COLUMN status SET DEFAULT 'ACTIVO';
ALTER TABLE public.inventario_ledger ALTER COLUMN status SET DEFAULT 'ACTIVO';


-- ----------------------------------------------------------------------------
-- 3. El CHECK baja de cuatro valores a dos.
-- ----------------------------------------------------------------------------
-- Mismos nombres de restriccion que ya tenian, para que el error que le llegue
-- a alguien dentro de un ano diga `finanzas_ledger_status_check` y se pueda
-- buscar en el repo. `IF EXISTS` para que reaplicar la migracion no reviente.

ALTER TABLE public.finanzas_ledger
  DROP CONSTRAINT IF EXISTS finanzas_ledger_status_check;

ALTER TABLE public.finanzas_ledger
  ADD CONSTRAINT finanzas_ledger_status_check
  CHECK (status IN ('ACTIVO', 'ANULADO'));

ALTER TABLE public.inventario_ledger
  DROP CONSTRAINT IF EXISTS inventario_ledger_status_check;

ALTER TABLE public.inventario_ledger
  ADD CONSTRAINT inventario_ledger_status_check
  CHECK (status IN ('ACTIVO', 'ANULADO'));


-- ----------------------------------------------------------------------------
-- 4. `finanzas_ledger.tipo_movimiento` deja de admitir NULL.
-- ----------------------------------------------------------------------------
-- Ya tenia un CHECK con la lista de 15 tipos validos, pero un CHECK deja pasar
-- el NULL (en SQL, `NULL IN (...)` no es falso, es NULL, y un CHECK solo falla
-- cuando es falso). O sea que la lista cerrada de tipos tenia un agujero del
-- tamano de "no pongas nada". `inventario_ledger.tipo_movimiento` ya era
-- NOT NULL; esto empareja los dos ledgers.

ALTER TABLE public.finanzas_ledger
  ALTER COLUMN tipo_movimiento SET NOT NULL;


-- ============================================================================
-- ESTADO: ESCRITA Y REVISADA, **TODAVIA NO APLICADA** (2026-09-03)
-- ============================================================================
-- Lo que SI quedo verificado contra produccion, antes de aplicar nada:
--
--   SELECT 'finanzas_ledger' AS tabla, status, count(*) FROM finanzas_ledger GROUP BY status
--   UNION ALL SELECT 'inventario_ledger', status, count(*) FROM inventario_ledger GROUP BY status
--   UNION ALL SELECT 'finanzas.tipo_movimiento IS NULL', NULL, count(*)
--               FROM finanzas_ledger WHERE tipo_movimiento IS NULL;
--
--     finanzas_ledger                   | ACTIVO  |  84
--     finanzas_ledger                   | ANULADO |  35
--     inventario_ledger                 | ACTIVO  | 410
--     inventario_ledger                 | ANULADO |  58
--     finanzas.tipo_movimiento IS NULL  | (null)  |   0
--
--   O sea: las dos guardias de arriba pasan, y ningun ALTER va a tocar datos.
--   Cifras de control el mismo dia, ANTES: 84 activas / 468 / 61 / $386,201.00.
--
-- POR QUE NO SE APLICO. El clasificador de permisos de la sesion bloqueo la
-- ejecucion de DDL contra produccion. **Y `supabase db push` no es la salida**,
-- esto hay que decirlo aunque estorbe: el historial local y el remoto estan
-- desincronizados. Diez migraciones que YA estan vivas en la base figuran como
-- pendientes en el repo, porque se aplicaron por el MCP y quedaron selladas con
-- otro timestamp. Un `db push` hoy las reaplicaria todas — incluida
-- `20260902235950`, que escribe tres UPDATE sobre una fila real del ledger. Ese
-- desfase es un problema aparte, sin ticket todavia, y no se arregla aqui.
--
-- COMO APLICARLA. Pegar este archivo, tal cual y completo, en el SQL editor de
-- Supabase. Es una sola transaccion: o entra todo o no entra nada.
--
-- QUE COMPROBAR DESPUES, y en este orden:
--
--   1) Metadatos de columna. Se espera `'ACTIVO'::text` en los dos status y
--      `is_nullable = NO` en `finanzas_ledger.tipo_movimiento`:
--
--      SELECT table_name, column_name, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema='public'
--         AND table_name IN ('finanzas_ledger','inventario_ledger')
--         AND column_name IN ('status','tipo_movimiento')
--       ORDER BY table_name, column_name;
--
--   2) Los dos CHECK, que deben quedar en dos valores:
--
--      SELECT c.relname, pg_get_constraintdef(con.oid)
--        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
--       WHERE con.conname IN ('finanzas_ledger_status_check',
--                             'inventario_ledger_status_check');
--
--   3) Las tres pruebas de la puerta. Van dentro de un bloque que termina en
--      ROLLBACK, para no dejar basura en el ledger:
--
--      BEGIN;
--        -- (a) omitir `status` -> debe ENTRAR, y nacer ACTIVO
--        INSERT INTO finanzas_ledger (tipo_movimiento, monto, descripcion)
--        VALUES ('GASTO_OPERATIVO', 1, 'prueba puerta (a)') RETURNING status;
--
--        -- (b) status legacy -> debe FALLAR con finanzas_ledger_status_check
--        INSERT INTO finanzas_ledger (tipo_movimiento, monto, status, descripcion)
--        VALUES ('GASTO_OPERATIVO', 1, 'APPROVED', 'prueba puerta (b)');
--
--        -- (c) sin tipo_movimiento -> debe FALLAR con not-null
--        INSERT INTO finanzas_ledger (monto, descripcion)
--        VALUES (1, 'prueba puerta (c)');
--      ROLLBACK;
--
--   4) Cifras de control, que tienen que seguir clavadas:
--
--      SELECT (SELECT count(*) FROM finanzas_ledger WHERE status='ACTIVO'),
--             (SELECT count(*) FROM inventario_ledger),
--             (SELECT count(*) FROM transacciones_tickets WHERE status='ACTIVO'),
--             (SELECT sum(total_cobrado_real) FROM transacciones_tickets
--               WHERE status='ACTIVO');
--      -- esperado: 84 | 468 | 61 | 386201.00
--
-- Cuando corra, la salida real de esos cuatro pasos sustituye a este bloque.
-- Mientras siga diciendo TODAVIA NO APLICADA, la base conserva el default
-- `APPROVED` armado y la regla 4 de `CLAUDE.md` va por delante del esquema.
-- ============================================================================


